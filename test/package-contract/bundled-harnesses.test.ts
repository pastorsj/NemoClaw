// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { directDockerfileCopySources } from "../../scripts/lib/dockerfile-copy-sources.mts";
import { listBundledHarnessSources } from "../../dist/lib/harness/bundled-source";
import { parseHarnessPackageManifest } from "../../dist/lib/harness/package-manifest";
import { validateHarnessPackageTree } from "../../dist/lib/harness/package-tree";

const REPOSITORY_ROOT = path.join(import.meta.dirname, "..", "..");
const BUNDLED_ROOT = path.join(REPOSITORY_ROOT, "dist", "harnesses");
const TSX = path.join(REPOSITORY_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
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

function artifactRoot(id: string): string {
  return path.join(BUNDLED_ROOT, `nemoclaw-${id}`);
}

function artifactPackPrefix(id: string): string {
  return `dist/harnesses/nemoclaw-${id}`;
}

function packageDigests(): Readonly<Record<string, string>> {
  return Object.fromEntries(
    EXPECTED_IDS.map((id) => [id, validateHarnessPackageTree(artifactRoot(id)).contentDigest]),
  );
}

function runBundledBuild(...args: readonly string[]): void {
  execFileSync(process.execPath, [TSX, "scripts/build-harnesses.mts", ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  });
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
      return {
        keys: Object.keys(parsed.envelope).sort(),
        id: parsed.envelope.id,
        manifest: parsed.envelope.manifest,
        manifestName: parsed.manifest.name,
      };
    });
    expect(envelopeSummaries).toEqual(
      EXPECTED_IDS.map((id) => ({
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
      })),
    );
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
    const first = packageDigests();
    runBundledBuild("--clean");
    expect(fs.existsSync(BUNDLED_ROOT)).toBe(false);
    runBundledBuild();
    expect(packageDigests()).toEqual(first);
    expect(() => runBundledBuild("--unsupported")).toThrow();
    expect(packageDigests()).toEqual(first);
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
