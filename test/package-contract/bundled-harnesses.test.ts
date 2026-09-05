// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { listBundledAgentRuntimeSources } from "../../scripts/build-harnesses.mts";
import { buildAgentDefinition } from "../../dist/lib/agent-runtime/manifest-loader.js";
import { parseHarnessPackageManifest } from "../../dist/lib/agent-runtime/package/manifest.js";
import { validateHarnessPackageTree } from "../../dist/lib/agent-runtime/package/tree.js";

const REPOSITORY_ROOT = path.join(import.meta.dirname, "..", "..");
const BUNDLED_ROOT = path.join(REPOSITORY_ROOT, "dist", "harnesses");
const TSX = path.join(REPOSITORY_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const PRIVATE_BUILD_EXPRESSION = `
import { materializeBundledHarnesses } from "./scripts/build-harnesses.mts";
materializeBundledHarnesses(process.argv[1] ?? "", process.argv[2]);
`;

type PackResult = Array<{ files: Array<{ path: string }> }>;
type BundledAgentRuntimeSource = ReturnType<typeof listBundledAgentRuntimeSources>[number];

function bundledPackageIds(): readonly string[] {
  return listBundledAgentRuntimeSources().map(({ id }) => id);
}

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
    bundledPackageIds().map((id) => {
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

function writeFutureHarnessPackage(repositoryRoot: string): void {
  const packageRoot = path.join(repositoryRoot, "packages", "nemoclaw-future-harness");
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "@fixture/nemoclaw-future-harness",
        version: "9.8.7",
        nemoclaw: { harnessManifest: "manifest.yaml" },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(packageRoot, "manifest.yaml"),
    'name: future-harness\ndisplay_name: "Future Harness"\n',
  );
  fs.writeFileSync(path.join(packageRoot, "Dockerfile.base"), "FROM scratch\n");
  fs.writeFileSync(
    path.join(packageRoot, "Dockerfile"),
    "FROM scratch\nCOPY packages/nemoclaw-future-harness/start.sh /usr/local/bin/nemoclaw-start\n",
  );
  fs.writeFileSync(path.join(packageRoot, "start.sh"), "#!/bin/sh\nexec future-harness\n", {
    mode: 0o755,
  });
  fs.writeFileSync(path.join(packageRoot, "policy-additions.yaml"), "version: 1\n");
}

function runBundledBuild(...args: readonly string[]): void {
  const result = spawnSync(process.execPath, [TSX, "scripts/build-harnesses.mts", ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
}

function runPrivateBundledBuild(outputRoot: string, authoringRepositoryRoot?: string): void {
  const result = spawnSync(
    process.execPath,
    [
      TSX,
      "--eval",
      PRIVATE_BUILD_EXPRESSION,
      outputRoot,
      ...(authoringRepositoryRoot ? [authoringRepositoryRoot] : []),
    ],
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

function missingPackedAssets(
  source: BundledAgentRuntimeSource,
  packed: readonly string[],
): string[] {
  const prefix = `${artifactPackPrefix(source.id)}/`;
  return source.mappings.flatMap(({ sourcePath, destinationPath }) => {
    const repositoryAsset = path.join(REPOSITORY_ROOT, sourcePath);
    const expected = `${prefix}${destinationPath}`;
    const isPacked = fs.statSync(repositoryAsset).isDirectory()
      ? packed.some((filePath) => filePath.startsWith(`${expected}/`))
      : packed.includes(expected);
    return isPacked ? [] : [sourcePath];
  });
}

describe("bundled harness package artifacts", () => {
  it("discovers and bundles a metadata-declared package without an ID registry", () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(fs.realpathSync.native(path.dirname(REPOSITORY_ROOT)), ".nemoclaw-discovery-"),
    );
    const fixtureRepositoryRoot = path.join(temporaryRoot, "repository");
    const outputRoot = path.join(temporaryRoot, "bundled");
    try {
      fs.mkdirSync(path.join(fixtureRepositoryRoot, "packages"), { recursive: true });
      writeFutureHarnessPackage(fixtureRepositoryRoot);

      expect(listBundledAgentRuntimeSources(fixtureRepositoryRoot)).toMatchObject([
        {
          id: "future-harness",
          displayName: "Future Harness",
          packageVersion: "9.8.7",
          manifestPath: "packages/nemoclaw-future-harness/manifest.yaml",
        },
      ]);

      runPrivateBundledBuild(outputRoot, fixtureRepositoryRoot);
      expect(fs.readdirSync(outputRoot)).toEqual(["nemoclaw-future-harness"]);
      const packageRoot = artifactRoot("future-harness", outputRoot);
      const parsed = parseHarnessPackageManifest(packageRoot);
      expect(parsed.envelope).toMatchObject({
        id: "future-harness",
        displayName: "Future Harness",
        packageVersion: "9.8.7",
        manifest: "packages/nemoclaw-future-harness/manifest.yaml",
      });
      expect(validateHarnessPackageTree(packageRoot).contentDigest).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      makeTreeWritable(temporaryRoot);
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("discovers each declared in-tree package and builds a valid closed envelope", () => {
    const sources = listBundledAgentRuntimeSources();
    const packageIds = sources.map(({ id }) => id);
    expect(fs.readdirSync(BUNDLED_ROOT).sort()).toEqual(
      packageIds.map((id) => `nemoclaw-${id}`).sort(),
    );
    const envelopeSummaries = packageIds.map((id) => {
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
    expect(envelopeSummaries).toEqual(
      packageIds.map((id) => {
        const source = sources.find((candidate) => candidate.id === id)!;
        const packagePath = `packages/nemoclaw-${id}`;
        return {
          keys: ["displayName", "id", "kind", "manifest", "packageVersion", "schemaVersion"],
          id,
          manifest: `${packagePath}/manifest.yaml`,
          manifestName: id,
          packageVersion: source.packageVersion,
          dockerfile: `${packagePath}/Dockerfile`,
          baseDockerfile: `${packagePath}/Dockerfile.base`,
          legacyDockerfile: null,
          legacyBaseDockerfile: null,
        };
      }),
    );
    expect(packageIds.map((id) => fs.statSync(artifactRoot(id)).mode & 0o777)).toEqual(
      packageIds.map(() => 0o555),
    );
    const nonCanonicalModes = packageIds.flatMap((id) =>
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

  it("keeps authoring caches and empty source directories out of package artifacts", () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(fs.realpathSync.native(path.dirname(REPOSITORY_ROOT)), ".nemoclaw-authoring-"),
    );
    const fixtureRepositoryRoot = path.join(temporaryRoot, "repository");
    const baselineRoot = path.join(temporaryRoot, "baseline");
    const contaminatedRoot = path.join(temporaryRoot, "contaminated");
    try {
      fs.mkdirSync(path.join(fixtureRepositoryRoot, "packages"), { recursive: true });
      writeFutureHarnessPackage(fixtureRepositoryRoot);
      runPrivateBundledBuild(baselineRoot, fixtureRepositoryRoot);
      const baseline = validateHarnessPackageTree(artifactRoot("future-harness", baselineRoot));

      const packageRoot = path.join(fixtureRepositoryRoot, "packages", "nemoclaw-future-harness");
      fs.mkdirSync(path.join(packageRoot, ".e2e"), { recursive: true });
      fs.writeFileSync(path.join(packageRoot, ".e2e", "run.json"), '{"local":true}\n');
      fs.mkdirSync(path.join(packageRoot, ".ruff_cache"), { recursive: true });
      fs.writeFileSync(path.join(packageRoot, ".ruff_cache", "cache.db"), "local cache\n");
      fs.mkdirSync(path.join(packageRoot, "runtime", "state"), { recursive: true });

      runPrivateBundledBuild(contaminatedRoot, fixtureRepositoryRoot);
      const contaminated = validateHarnessPackageTree(
        artifactRoot("future-harness", contaminatedRoot),
      );

      expect(contaminated.contentDigest).toBe(baseline.contentDigest);
      expect(contaminated.entries).toEqual(baseline.entries);
      expect(contaminated.entries.map(({ relativePath }) => relativePath)).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining("/.e2e"),
          expect.stringContaining("/.ruff_cache"),
          expect.stringContaining("/runtime/state"),
        ]),
      );
    } finally {
      makeTreeWritable(temporaryRoot);
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("publishes every accepted artifact and locally referenced build asset", () => {
    const packed = packedFileList();
    const missingArtifacts = listBundledAgentRuntimeSources().flatMap((source) => {
      const required = [
        `${artifactPackPrefix(source.id)}/nemoclaw-package.json`,
        `${artifactPackPrefix(source.id)}/${source.manifestPath}`,
      ];
      return required.filter((filePath) => !packed.includes(filePath));
    });
    const missingAssets = listBundledAgentRuntimeSources().flatMap((source) =>
      missingPackedAssets(source, packed).map((asset) => `${source.id}:${asset}`),
    );

    expect(missingArtifacts).toEqual([]);
    expect(missingAssets).toEqual([]);
  }, 120_000);

  it("omits excluded candidates, authoring files, credentials, and host callbacks", () => {
    const artifactFiles = packedFileList().filter((filePath) =>
      filePath.startsWith("dist/harnesses/"),
    );
    const payloadFiles = artifactFiles.map((filePath) =>
      filePath.replace(/^dist\/harnesses\/nemoclaw-[^/]+\//u, ""),
    );
    expect(artifactFiles).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/dist\/harnesses\/nemoclaw-nemocua(?:\/|$)/u)]),
    );
    expect(payloadFiles).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /(?:^|\/)(?:\.git|\.cache|\.mypy_cache|\.npm|\.pytest_cache|\.tox|__pycache__|coverage|dist|node_modules|tests|[^/]+\.egg-info|(?!(?:npm-cache-seed)(?:\/|$))[^/]*-cache)(?:\/|$)/u,
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
    expect(artifactFiles).toContain(
      `${artifactPackPrefix("openclaw")}/packages/nemoclaw-openclaw/host/config-adapter.cts`,
    );
    expect(artifactFiles.some((filePath) => filePath.includes("/host/source/"))).toBe(false);
    const envelopeKeys = bundledPackageIds().flatMap((id) =>
      Object.keys(
        JSON.parse(fs.readFileSync(path.join(artifactRoot(id), "nemoclaw-package.json"), "utf8")),
      ),
    );
    expect(envelopeKeys).not.toEqual(
      expect.arrayContaining(["entrypoint", "main", "module", "register", "callback"]),
    );
  }, 120_000);
});
