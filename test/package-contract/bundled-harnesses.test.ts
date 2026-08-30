// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { directDockerfileCopySources } from "../../scripts/lib/dockerfile-copy-sources.mts";
import { buildAgentDefinition } from "../../dist/lib/agent/definition-loader";
import { listBundledHarnessSources } from "../../dist/lib/harness/bundled-source";
import { parseHarnessPackageManifest } from "../../dist/lib/harness/package-manifest";
import { validateHarnessPackageTree } from "../../dist/lib/harness/package-tree";

const REPOSITORY_ROOT = path.join(import.meta.dirname, "..", "..");
const BUNDLED_ROOT = path.join(REPOSITORY_ROOT, "dist", "harnesses");
const TSX = path.join(REPOSITORY_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const PRIVATE_BUILD_EXPRESSION = `
import { materializeBundledHarnesses } from "./scripts/build-harnesses.mts";
materializeBundledHarnesses(process.argv[1] ?? "");
`;
const EXPECTED_IDS = ["openclaw", "hermes", "langchain-deepagents-code"] as const;
const DOCKERFILES = {
  openclaw: ["Dockerfile", "Dockerfile.base"],
  hermes: ["agents/hermes/Dockerfile", "agents/hermes/Dockerfile.base"],
  "langchain-deepagents-code": [
    "agents/langchain-deepagents-code/Dockerfile",
    "agents/langchain-deepagents-code/Dockerfile.base",
  ],
} as const;

type PackResult = Array<{ files: Array<{ path: string }> }>;

function artifactRoot(id: string, outputRoot = BUNDLED_ROOT): string {
  return path.join(outputRoot, `nemoclaw-${id}`);
}

function artifactPackPrefix(id: string): string {
  return `dist/harnesses/nemoclaw-${id}`;
}

function relativePackageAsset(packageRoot: string, assetPath: string | null): string | null {
  return assetPath ? path.relative(packageRoot, assetPath) : null;
}

function packageTreeSnapshots(outputRoot: string): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    EXPECTED_IDS.map((id) => {
      const packageRoot = artifactRoot(id, outputRoot);
      const validated = validateHarnessPackageTree(packageRoot);
      const entries = [
        { relativePath: ".", type: "directory" as const },
        ...validated.entries.map(({ relativePath, type }) => ({ relativePath, type })),
      ];
      return [
        id,
        {
          contentDigest: validated.contentDigest,
          modes: entries.map(({ relativePath, type }) => ({
            relativePath,
            type,
            mode: fs.statSync(path.join(packageRoot, relativePath)).mode & 0o777,
          })),
        },
      ];
    }),
  );
}

function sharedBundleSnapshot(): Readonly<Record<string, unknown>> {
  const rootStat = fs.lstatSync(BUNDLED_ROOT, { bigint: true });
  return {
    rootIdentity: {
      device: rootStat.dev,
      inode: rootStat.ino,
      mode: rootStat.mode,
      modifiedAt: rootStat.mtimeNs,
      changedAt: rootStat.ctimeNs,
    },
    packages: packageTreeSnapshots(BUNDLED_ROOT),
  };
}

function makeTreeWritable(root: string): void {
  fs.chmodSync(root, 0o700);
  fs.readdirSync(root, { withFileTypes: true }).forEach((entry) => {
    const target = path.join(root, entry.name);
    entry.isDirectory() ? makeTreeWritable(target) : fs.chmodSync(target, 0o600);
  });
}

function runBundledBuild(...args: readonly string[]): void {
  const result = spawnSync(process.execPath, [TSX, "scripts/build-harnesses.mts", ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
}

function runPrivateBundledBuild(outputRoot: string): void {
  const result = spawnSync(
    process.execPath,
    [TSX, "--eval", PRIVATE_BUILD_EXPRESSION, outputRoot],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    },
  );
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
}

function packedFileList(): readonly string[] {
  const result = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }),
  ) as PackResult;
  return result[0]?.files.map(({ path: filePath }) => filePath) ?? [];
}

function expandCopySource(sourcePath: string): readonly string[] {
  const normalized = sourcePath.replace(/\/+$/u, "");
  return /[*?[\]]/u.test(normalized)
    ? fs.globSync(normalized, { cwd: REPOSITORY_ROOT }).sort()
    : [normalized];
}

function localBuildAssets(id: (typeof EXPECTED_IDS)[number]): readonly string[] {
  return [
    ...DOCKERFILES[id],
    ...DOCKERFILES[id].flatMap((dockerfile) =>
      directDockerfileCopySources(path.join(REPOSITORY_ROOT, dockerfile), dockerfile).flatMap(
        ({ source }) => expandCopySource(source),
      ),
    ),
  ];
}

function missingPackedAssets(
  id: (typeof EXPECTED_IDS)[number],
  packed: readonly string[],
): string[] {
  const prefix = `${artifactPackPrefix(id)}/`;
  return localBuildAssets(id).filter((asset) => {
    const repositoryAsset = path.join(REPOSITORY_ROOT, asset);
    const expected = `${prefix}${asset}`;
    return fs.statSync(repositoryAsset).isDirectory()
      ? !packed.some((filePath) => filePath.startsWith(`${expected}/`))
      : !packed.includes(expected);
  });
}

describe("bundled harness package artifacts", () => {
  it("builds only the accepted standard catalogue with valid closed envelopes", () => {
    expect(fs.readdirSync(BUNDLED_ROOT).sort()).toEqual(
      EXPECTED_IDS.map((id) => `nemoclaw-${id}`).sort(),
    );
    const envelopeSummaries = EXPECTED_IDS.map((id) => {
      const parsed = parseHarnessPackageManifest(artifactRoot(id));
      const definition = buildAgentDefinition({
        manifest: parsed.manifest,
        manifestPath: parsed.manifestPath,
        packageRoot: parsed.packageRoot,
      });
      return {
        keys: Object.keys(parsed.envelope).sort(),
        id: parsed.envelope.id,
        manifest: parsed.envelope.manifest,
        manifestName: parsed.manifest.name,
        packageVersion: parsed.envelope.packageVersion,
        dockerfile: relativePackageAsset(parsed.packageRoot, definition.dockerfilePath),
        baseDockerfile: relativePackageAsset(parsed.packageRoot, definition.dockerfileBasePath),
        legacyDockerfile: relativePackageAsset(
          parsed.packageRoot,
          definition.legacyPaths?.dockerfile ?? null,
        ),
        legacyBaseDockerfile: relativePackageAsset(
          parsed.packageRoot,
          definition.legacyPaths?.dockerfileBase ?? null,
        ),
      };
    });
    expect(envelopeSummaries).toEqual([
      {
        keys: [
          "contractVersion",
          "displayName",
          "id",
          "kind",
          "manifest",
          "packageVersion",
          "schemaVersion",
        ],
        id: "openclaw",
        manifest: "agents/openclaw/manifest.yaml",
        manifestName: "openclaw",
        packageVersion: "0.1.1",
        dockerfile: "agents/openclaw/Dockerfile",
        baseDockerfile: null,
        legacyDockerfile: "Dockerfile",
        legacyBaseDockerfile: "Dockerfile.base",
      },
      ...(["hermes", "langchain-deepagents-code"] as const).map((id) => ({
        keys: [
          "contractVersion",
          "displayName",
          "id",
          "kind",
          "manifest",
          "packageVersion",
          "schemaVersion",
        ],
        id,
        manifest: `agents/${id}/manifest.yaml`,
        manifestName: id,
        packageVersion: "0.1.0",
        dockerfile: `agents/${id}/Dockerfile`,
        baseDockerfile: `agents/${id}/Dockerfile.base`,
        legacyDockerfile: null,
        legacyBaseDockerfile: null,
      })),
    ]);
    expect(EXPECTED_IDS.map((id) => fs.statSync(artifactRoot(id)).mode & 0o777)).toEqual(
      EXPECTED_IDS.map(() => 0o555),
    );
    const nonCanonicalModes = EXPECTED_IDS.flatMap((id) =>
      validateHarnessPackageTree(artifactRoot(id))
        .entries.filter(({ relativePath, type }) => {
          const mode = fs.statSync(path.join(artifactRoot(id), relativePath)).mode & 0o777;
          return mode !== (type === "directory" ? 0o555 : mode & 0o111 ? 0o555 : 0o444);
        })
        .map(({ relativePath }) => `${id}:${relativePath}`),
    );
    expect(nonCanonicalModes).toEqual([]);
  });

  it("produces byte-identical validated package trees on repeated builds", () => {
    const sharedBefore = sharedBundleSnapshot();
    const temporaryRoot = fs.mkdtempSync(
      path.join(fs.realpathSync.native(path.dirname(REPOSITORY_ROOT)), ".nemoclaw-bundles-"),
    );
    const firstRoot = path.join(temporaryRoot, "first");
    const secondRoot = path.join(temporaryRoot, "second");
    try {
      runPrivateBundledBuild(firstRoot);
      const first = packageTreeSnapshots(firstRoot);
      expect(sharedBundleSnapshot()).toEqual(sharedBefore);

      runPrivateBundledBuild(secondRoot);
      expect(packageTreeSnapshots(secondRoot)).toEqual(first);
      expect(sharedBundleSnapshot()).toEqual(sharedBefore);

      expect(() => runPrivateBundledBuild(firstRoot)).toThrow();
      expect(() => runBundledBuild("--unsupported")).toThrow();
      expect(sharedBundleSnapshot()).toEqual(sharedBefore);
    } finally {
      makeTreeWritable(temporaryRoot);
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("publishes every accepted artifact and locally referenced build asset", () => {
    const packed = packedFileList();
    const missingArtifacts = listBundledHarnessSources().flatMap((source) => {
      const required = [
        `${artifactPackPrefix(source.id)}/nemoclaw-package.json`,
        `${artifactPackPrefix(source.id)}/${source.manifestPath}`,
      ];
      return required.filter((filePath) => !packed.includes(filePath));
    });
    const missingAssets = EXPECTED_IDS.flatMap((id) =>
      missingPackedAssets(id, packed).map((asset) => `${id}:${asset}`),
    );

    expect(missingArtifacts).toEqual([]);
    expect(missingAssets).toEqual([]);
  }, 120_000);

  it("omits candidate, authoring, credential, and dynamic host callback surfaces", () => {
    const artifactFiles = packedFileList().filter((filePath) =>
      filePath.startsWith("dist/harnesses/"),
    );
    const payloadFiles = artifactFiles.map((filePath) =>
      filePath.replace(/^dist\/harnesses\/nemoclaw-[^/]+\//u, ""),
    );
    expect(artifactFiles).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/dist\/harnesses\/nemoclaw-(?:pi|nemocua)(?:\/|$)/u),
      ]),
    );
    expect(payloadFiles).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /(?:^|\/)(?:\.git|\.cache|\.mypy_cache|\.npm|\.pytest_cache|\.tox|__pycache__|coverage|dist|node_modules|tests|(?!(?:npm-cache-seed)(?:\/|$))[^/]*-cache)(?:\/|$)/u,
        ),
        expect.stringMatching(
          /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.netrc|credentials\.json)(?:$|\/)/u,
        ),
        expect.stringMatching(/(?:^|\/)(?:test_[^/]+\.py|[^/]+\.(?:test|spec)\.[cm]?[jt]sx?)$/u),
        expect.stringMatching(/(?:^|\/)dependency-review[^/]*$/iu),
        expect.stringMatching(
          /(?:^|\/)(?:\.DS_Store|\.gitignore|\.gitkeep|tsconfig\.test\.json|vitest\.(?:config|nemoclaw|project)\.ts)$/u,
        ),
        expect.stringContaining("nemoclaw-blueprint/router/llm-router/"),
      ]),
    );
    const envelopeKeys = EXPECTED_IDS.flatMap((id) =>
      Object.keys(
        JSON.parse(fs.readFileSync(path.join(artifactRoot(id), "nemoclaw-package.json"), "utf8")),
      ),
    );
    expect(envelopeKeys).not.toEqual(
      expect.arrayContaining(["entrypoint", "main", "module", "register", "callback"]),
    );
  }, 120_000);
});
