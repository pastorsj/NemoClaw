// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { loadAgent } from "../../src/lib/agent/defs";

type WorkflowRecord = Record<string, unknown>;

export type OpenClawFabricImageContract = Record<string, boolean>;

export interface OpenClawPublicationInspection {
  readonly agent: ReturnType<typeof loadAgent>;
  readonly packageContract: OpenClawFabricImageContract;
  readonly packageDockerfilePath: string | null;
  readonly protectedPaths: readonly string[];
  readonly publications: ReadonlyArray<{
    readonly contract: OpenClawFabricImageContract;
    readonly isFile: boolean;
    readonly path: string;
    readonly pathIsAbsolute: boolean;
    readonly pathSegments: readonly string[];
  }>;
  readonly workflowPaths: readonly string[];
}

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

function readRepositoryFile(relativePath: string): string {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function protectedBuildDockerfiles(source: string): string[] {
  return [...source.matchAll(/build_agent\s+\\\r?\n\s*openclaw\s+\\\r?\n\s*([^\s\\]+)\s+\\/gu)].map(
    (match) => match[1],
  );
}

function managedWorkflowDockerfiles(source: string): string[] {
  const workflow = YAML.parse(source) as WorkflowRecord;
  const jobs = workflow.jobs as WorkflowRecord;
  const dockerfiles: string[] = [];

  for (const job of Object.values(jobs)) {
    if (!job || typeof job !== "object" || Array.isArray(job)) continue;
    const strategy = (job as WorkflowRecord).strategy;
    if (!strategy || typeof strategy !== "object" || Array.isArray(strategy)) continue;
    const matrix = (strategy as WorkflowRecord).matrix;
    if (!matrix || typeof matrix !== "object" || Array.isArray(matrix)) continue;
    const include = (matrix as WorkflowRecord).include;
    if (!Array.isArray(include)) continue;

    for (const entry of include) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as WorkflowRecord;
      if (record.agent !== "openclaw") continue;
      if (typeof record.dockerfile !== "string" || record.dockerfile.length === 0) {
        throw new Error("Every managed OpenClaw image matrix entry must name its Dockerfile");
      }
      dockerfiles.push(record.dockerfile);
    }
  }

  return dockerfiles;
}

function openClawFabricImageContract(source: string): OpenClawFabricImageContract {
  return {
    lockedDependencies:
      source.includes(
        "COPY packages/nemoclaw-openclaw/fabric/requirements.lock /tmp/nemoclaw-openclaw-fabric-requirements.lock",
      ) && source.includes("pip3 install --no-cache-dir --require-hashes"),
    genericRunnerSource: source.includes("COPY packages/nemoclaw-fabric/src/"),
    packageAdapterSource: source.includes("COPY packages/nemoclaw-openclaw/fabric/src/"),
    immutableDescriptor: source.includes(
      "COPY --chmod=0444 packages/nemoclaw-openclaw/fabric/openclaw.fabric-adapter.json /usr/local/share/nemoclaw/openclaw.fabric-adapter.json",
    ),
    exactRuntimeIdentity: source.includes("nemoclaw-fabric 0.1.2 (nemo-fabric 0.2.0)"),
    buildTimeDoctor:
      source.includes("nemoclaw-fabric doctor \\") &&
      source.includes("--config /sandbox/.openclaw/fabric.json --json"),
    durableArtifacts: source.includes('"$config_dir/fabric-artifacts"'),
    privateConfig:
      source.includes("/sandbox/.openclaw/fabric.json") &&
      source.includes("chmod 600 /sandbox/.openclaw/fabric.json"),
    sealedConfigPair: source.includes("sha256sum openclaw.json fabric.json > .config-hash"),
  };
}

export const completeOpenClawFabricImageContract: OpenClawFabricImageContract = {
  lockedDependencies: true,
  genericRunnerSource: true,
  packageAdapterSource: true,
  immutableDescriptor: true,
  exactRuntimeIdentity: true,
  buildTimeDoctor: true,
  durableArtifacts: true,
  privateConfig: true,
  sealedConfigPair: true,
};

export function inspectOpenClawPublications(): OpenClawPublicationInspection {
  const agent = loadAgent("openclaw");
  const packageDockerfilePath = agent.dockerfilePath;
  const protectedPaths = protectedBuildDockerfiles(
    readRepositoryFile("scripts/checks/build-protected-managed-images.sh"),
  );
  const workflowPaths = managedWorkflowDockerfiles(
    readRepositoryFile(".github/workflows/managed-images.yaml"),
  );
  const publicationPaths = [...new Set([...protectedPaths, ...workflowPaths])];
  const packageContract = openClawFabricImageContract(
    fs.readFileSync(packageDockerfilePath as string, "utf8"),
  );
  const publications = publicationPaths.map((publicationPath) => {
    const resolvedPath = path.join(repositoryRoot, publicationPath);
    return {
      contract: openClawFabricImageContract(fs.readFileSync(resolvedPath, "utf8")),
      isFile: fs.statSync(resolvedPath).isFile(),
      path: publicationPath,
      pathIsAbsolute: path.isAbsolute(publicationPath),
      pathSegments: publicationPath.split(/[\\/]/u),
    };
  });

  return {
    agent,
    packageContract,
    packageDockerfilePath,
    protectedPaths,
    publications,
    workflowPaths,
  };
}
