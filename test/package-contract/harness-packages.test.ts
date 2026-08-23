// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPackageFixture } from "./helpers/package-fixture";

const HARNESSES = [
  {
    id: "hermes",
    runtimeFile: "hermes-wrapper.py",
  },
  {
    id: "langchain-deepagents-code",
    runtimeFile: "dcode-wrapper.sh",
  },
  {
    id: "openclaw",
    runtimeFile: "openclaw-runtime/package-lock.json",
  },
] as const;

type HarnessPackage = {
  readonly id: string;
  readonly rootDir: string;
  readonly manifestPath: string;
  readonly source: "bundled" | "installed";
};

type HarnessRegistry = {
  readonly listHarnessPackages: (env: NodeJS.ProcessEnv) => HarnessPackage[];
  readonly resolveHarnessPackage: (id: string, env: NodeJS.ProcessEnv) => HarnessPackage | null;
};

type HarnessRuntimeLoader = {
  readonly loadHarnessCommonJsModule: (
    harnessPackage: HarnessPackage & { packageName: string; version: string },
    relativePath: string,
    maxBytes: number,
  ) => { exports: unknown };
};

describe("published harness packages", () => {
  let fixtureRoot: string;
  let packagedRoot: string;
  let packedPaths: ReadonlySet<string>;
  let openClawPackedPaths: ReadonlySet<string>;
  let installedPackageRoot: string;
  let fixtureRequire: NodeRequire;
  let registry: HarnessRegistry;
  let runtimeLoader: HarnessRuntimeLoader;
  let environment: NodeJS.ProcessEnv;

  beforeAll(() => {
    fixtureRoot = createPackageFixture({
      prefix: "nemoclaw-harness-packages-",
      entries: [
        "agents",
        "dist/lib/adapters/fs/regular-file.js",
        "dist/lib/agent/manifest-readers.js",
        "dist/lib/agent/state-file-restore-reader.js",
        "dist/lib/core/json-types.js",
        "dist/lib/harness",
        "dist/lib/onboard/custom-build-context.js",
        "dist/lib/validation.js",
        "node_modules/argparse",
        "node_modules/js-yaml",
        "packages",
      ],
    });

    packagedRoot = realpathSync(fixtureRoot);
    const report = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: fixtureRoot,
        encoding: "utf8",
      }),
    ) as Array<{ files?: Array<{ path?: string }> }>;
    packedPaths = new Set(
      (report[0]?.files ?? [])
        .map((entry) => entry.path)
        .filter((entry): entry is string => typeof entry === "string"),
    );
    const openClawReport = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: path.join(fixtureRoot, "packages", "nemoclaw-openclaw"),
        encoding: "utf8",
      }),
    ) as Array<{ files?: Array<{ path?: string }> }>;
    openClawPackedPaths = new Set(
      (openClawReport[0]?.files ?? [])
        .map((entry) => entry.path)
        .filter((entry): entry is string => typeof entry === "string"),
    );

    installedPackageRoot = path.join(fixtureRoot, "installed", "node_modules", "nemoclaw");
    const installedHermesConfig = path.join(
      installedPackageRoot,
      "packages",
      "nemoclaw-hermes",
      "config",
    );
    const installedDcodePackage = path.join(
      installedPackageRoot,
      "packages",
      "nemoclaw-langchain-deepagents-code",
    );
    mkdirSync(installedHermesConfig, { recursive: true });
    mkdirSync(installedDcodePackage, { recursive: true });
    writeFileSync(path.join(installedPackageRoot, "package.json"), '{"name":"nemoclaw"}\n');
    copyFileSync(
      path.join(packagedRoot, "packages/nemoclaw-hermes/config/managed-route.cts"),
      path.join(installedHermesConfig, "managed-route.cts"),
    );
    copyFileSync(
      path.join(packagedRoot, "packages/nemoclaw-langchain-deepagents-code/managed-identity.cts"),
      path.join(installedDcodePackage, "managed-identity.cts"),
    );

    fixtureRequire = createRequire(path.join(fixtureRoot, "package.json"));
    registry = fixtureRequire(
      path.join(fixtureRoot, "dist/lib/harness/package-registry.js"),
    ) as HarnessRegistry;
    runtimeLoader = fixtureRequire(
      path.join(fixtureRoot, "dist/lib/harness/commonjs-runtime.js"),
    ) as HarnessRuntimeLoader;
    environment = { HOME: path.join(fixtureRoot, "home") };
  }, 120_000);

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it.each(HARNESSES)("ships the $id harness package metadata and runtime", (harness) => {
    const packageRoot = `packages/nemoclaw-${harness.id}`;

    expect(packedPaths).toContain(`${packageRoot}/package.json`);
    expect(packedPaths).toContain(`${packageRoot}/manifest.yaml`);
    expect(packedPaths).toContain(`${packageRoot}/${harness.runtimeFile}`);
  });

  it.each([
    "packages/nemoclaw-hermes/config/managed-route.cts",
    "packages/nemoclaw-langchain-deepagents-code/managed-identity.cts",
  ])("ships package-owned runtime contract %s", (artifact) => {
    expect(packedPaths).toContain(artifact);
  });

  it("loads the package-owned runtime modules from the published tree", () => {
    const hermes = fixtureRequire(
      path.join(packagedRoot, "packages/nemoclaw-hermes/config/managed-route.cts"),
    ) as { hermesProviderKey(provider: string): string };
    const dcode = fixtureRequire(
      path.join(packagedRoot, "packages/nemoclaw-langchain-deepagents-code/managed-identity.cts"),
    ) as { normalizeManagedDcodeModelName(model: string): string };

    expect(hermes.hermesProviderKey("NVIDIA NIM")).toBe("nvidia-nim");
    expect(dcode.normalizeManagedDcodeModelName("openrouter:model")).toBe("model");
  });

  it("loads package-owned runtime modules from a normal node_modules installation", () => {
    const hermesRoot = path.join(installedPackageRoot, "packages", "nemoclaw-hermes");
    const dcodeRoot = path.join(
      installedPackageRoot,
      "packages",
      "nemoclaw-langchain-deepagents-code",
    );
    const hermes = runtimeLoader.loadHarnessCommonJsModule(
      {
        id: "hermes",
        packageName: "@nvidia/nemoclaw-hermes",
        version: "0.1.0",
        rootDir: hermesRoot,
        manifestPath: path.join(hermesRoot, "manifest.yaml"),
        source: "bundled",
      },
      "config/managed-route.cts",
      64 * 1024,
    ).exports as { hermesProviderKey(provider: string): string };
    const dcode = runtimeLoader.loadHarnessCommonJsModule(
      {
        id: "langchain-deepagents-code",
        packageName: "@nvidia/nemoclaw-langchain-deepagents-code",
        version: "0.1.0",
        rootDir: dcodeRoot,
        manifestPath: path.join(dcodeRoot, "manifest.yaml"),
        source: "bundled",
      },
      "managed-identity.cts",
      64 * 1024,
    ).exports as { normalizeManagedDcodeModelName(model: string): string };

    expect(hermes.hermesProviderKey("NVIDIA NIM")).toBe("nvidia-nim");
    expect(dcode.normalizeManagedDcodeModelName("openrouter:model")).toBe("model");
  });

  it.each([
    "Dockerfile",
    "Dockerfile.base",
    "start.sh",
    "policy-additions.yaml",
    "policy-permissive.yaml",
    "policy-permissive-default.yaml",
  ])("ships OpenClaw package artifact %s", (artifact) => {
    expect(packedPaths).toContain(`packages/nemoclaw-openclaw/${artifact}`);
  });

  it.each(["scripts/backup-workspace.sh", "scripts/lib/openclaw-npm-remediation.mts"])(
    "ships executable OpenClaw package helper %s",
    (artifact) => {
      expect(packedPaths).toContain(`packages/nemoclaw-openclaw/${artifact}`);
      expect(openClawPackedPaths).toContain(artifact);
      expect(
        statSync(path.join(packagedRoot, "packages", "nemoclaw-openclaw", artifact)).mode & 0o111,
      ).not.toBe(0);
    },
  );

  it.each([
    "Dockerfile",
    "Dockerfile.base",
    "scripts/nemoclaw-start.sh",
    "nemoclaw-blueprint/policies/openclaw-sandbox.yaml",
    "nemoclaw-blueprint/policies/openclaw-sandbox-permissive.yaml",
  ])("omits former OpenClaw path %s", (legacyPath) => {
    expect(packedPaths).not.toContain(legacyPath);
  });

  it.each(HARNESSES)("omits the legacy agents/$id package tree", ({ id }) => {
    expect([...packedPaths].some((packedPath) => packedPath.startsWith(`agents/${id}/`))).toBe(
      false,
    );
  });

  it("omits generated Python caches", () => {
    expect(
      [...packedPaths].filter((packedPath) =>
        /(?:^|\/)__pycache__(?:\/|$)|\.pyc$/u.test(packedPath),
      ),
    ).toEqual([]);
  });

  it("omits OpenClaw plugin dependencies from both published packages", () => {
    expect(
      [...packedPaths].filter((packedPath) =>
        packedPath.startsWith("packages/nemoclaw-openclaw/plugin/node_modules/"),
      ),
    ).toEqual([]);
    expect(
      [...openClawPackedPaths].filter((packedPath) =>
        packedPath.startsWith("plugin/node_modules/"),
      ),
    ).toEqual([]);
  });

  it("lists the three harnesses through the compiled registry", () => {
    expect(registry.listHarnessPackages(environment).map((entry) => entry.id)).toEqual(
      HARNESSES.map((harness) => harness.id),
    );
  });

  it.each(HARNESSES)("resolves the $id harness through the compiled registry", (harness) => {
    expect(registry.resolveHarnessPackage(harness.id, environment)).toEqual(
      expect.objectContaining({
        id: harness.id,
        manifestPath: path.join(
          packagedRoot,
          "packages",
          `nemoclaw-${harness.id}`,
          "manifest.yaml",
        ),
        rootDir: path.join(packagedRoot, "packages", `nemoclaw-${harness.id}`),
        source: "bundled",
      }),
    );
  });
});
