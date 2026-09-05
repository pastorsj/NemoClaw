// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ROOT } from "../runner";
import { buildAgentDefinition } from "./manifest-loader";
import { loadManifestRecord, parseManifestRecord, readDashboard } from "./manifest-readers";

const TEST_PARENT = path.join(process.cwd(), "node_modules/.cache/nemoclaw-agent-definition-tests");
fs.mkdirSync(TEST_PARENT, { recursive: true, mode: 0o700 });

let fixtureRoot = path.join(TEST_PARENT, "unused");

function writeFile(root: string, relativePath: string, contents = "fixture\n"): string {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, contents, { mode: 0o600 });
  return target;
}

function writeAgentRoot(
  root: string,
  options: { readonly displayName?: string; readonly legacyPath?: string } = {},
): string {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const lines = [
    "name: openclaw",
    `display_name: ${options.displayName ?? "OpenClaw"}`,
    "binary_path: /usr/local/bin/openclaw",
    ...(options.legacyPath ? ["_legacy_paths:", `  dockerfile: ${options.legacyPath}`] : []),
  ];
  return writeFile(root, "packages/nemoclaw-openclaw/manifest.yaml", `${lines.join("\n")}\n`);
}

function buildFromRoot(root: string, manifestPath = writeAgentRoot(root)) {
  return buildAgentDefinition({
    manifest: loadManifestRecord(manifestPath),
    manifestPath,
    packageRoot: root,
  });
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(TEST_PARENT, "fixture-"));
  fs.chmodSync(fixtureRoot, 0o700);
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("dashboard manifest metadata", () => {
  it("parses a bounded config token path for URL-token dashboards", () => {
    expect(
      readDashboard(
        parseManifestRecord(
          "dashboard:\n  auth: url_token\n  token_path: custom.browser.secret\n",
          "test manifest",
        ),
      ).tokenPath,
    ).toEqual(["custom", "browser", "secret"]);
  });

  it("rejects unsafe config token paths", () => {
    expect(() =>
      readDashboard(
        parseManifestRecord(
          "dashboard:\n  auth: url_token\n  token_path: gateway.auth.$token\n",
          "test manifest",
        ),
      ),
    ).toThrow(/safe dotted config path/);
  });
});

describe("buildAgentDefinition", () => {
  it("preserves repository definition behavior through the explicit-root builder", () => {
    const packageRoot = path.join(ROOT, "packages/nemoclaw-openclaw");
    const manifestPath = path.join(packageRoot, "manifest.yaml");
    const definition = buildAgentDefinition({
      manifest: loadManifestRecord(manifestPath),
      manifestPath,
      packageRoot,
    });

    expect(definition).toMatchObject({
      name: "openclaw",
      displayName: "OpenClaw",
      packageRoot,
      manifestPath,
      agentDir: path.dirname(manifestPath),
      managedImage: {
        repository: "ghcr.io/nvidia/nemoclaw/openclaw-sandbox",
        architectures: ["linux/amd64", "linux/arm64"],
        runtime_identity: { uid: 998, gid: 998, workdir: "/sandbox" },
        startup_profile_contract_version: 1,
        capability_contract_version: 1,
      },
    });
    expect(definition).toMatchObject({
      dockerfileBasePath: path.join(packageRoot, "Dockerfile.base"),
      dockerfilePath: path.join(packageRoot, "Dockerfile"),
      startScriptPath: path.join(packageRoot, "start.sh"),
      policyAdditionsPath: path.join(packageRoot, "policy-additions.yaml"),
      pluginDir: path.join(packageRoot, "plugin"),
      legacyPaths: null,
    });
  });

  it("resolves ordinary and legacy assets only from the selected package root", () => {
    const manifestPath = writeAgentRoot(fixtureRoot, {
      legacyPath: "runtime/legacy.Dockerfile",
    });
    const dockerfile = writeFile(
      fixtureRoot,
      "packages/nemoclaw-openclaw/Dockerfile",
      "FROM scratch\n",
    );
    const legacyDockerfile = writeFile(fixtureRoot, "runtime/legacy.Dockerfile", "FROM scratch\n");

    const definition = buildAgentDefinition({
      manifest: loadManifestRecord(manifestPath),
      manifestPath,
      packageRoot: fixtureRoot,
    });

    expect(definition.packageRoot).toBe(fixtureRoot);
    expect(definition.dockerfilePath).toBe(dockerfile);
    expect(definition.legacyPaths?.dockerfile).toBe(legacyDockerfile);
    expect(path.relative(fixtureRoot, definition.legacyPaths?.dockerfile ?? "")).toBe(
      "runtime/legacy.Dockerfile",
    );
    expect(Object.getOwnPropertyDescriptors(definition)).toMatchObject({
      agentDir: { configurable: false, value: path.dirname(manifestPath), writable: false },
      manifestPath: { configurable: false, value: manifestPath, writable: false },
      packageRoot: { configurable: false, value: fixtureRoot, writable: false },
    });
    expect(Object.isFrozen(definition)).toBe(false);
  });

  it("keeps same-id definitions from different package roots isolated", () => {
    const firstRoot = path.join(fixtureRoot, "first");
    const secondRoot = path.join(fixtureRoot, "second");
    const firstManifest = writeAgentRoot(firstRoot, { displayName: "First OpenClaw" });
    const secondManifest = writeAgentRoot(secondRoot, { displayName: "Second OpenClaw" });
    writeFile(firstRoot, "packages/nemoclaw-openclaw/Dockerfile", "FROM first\n");
    writeFile(secondRoot, "packages/nemoclaw-openclaw/Dockerfile", "FROM second\n");

    const first = buildFromRoot(firstRoot, firstManifest);
    const second = buildFromRoot(secondRoot, secondManifest);

    expect(first.name).toBe(second.name);
    expect(first.displayName).toBe("First OpenClaw");
    expect(second.displayName).toBe("Second OpenClaw");
    expect(first.packageRoot).toBe(firstRoot);
    expect(second.packageRoot).toBe(secondRoot);
    expect(first.dockerfilePath).not.toBe(second.dockerfilePath);
  });

  it("uses the selected package's legacy baseline policy when no ordinary policy exists", () => {
    const manifestPath = writeFile(
      fixtureRoot,
      "packages/nemoclaw-openclaw/manifest.yaml",
      "name: openclaw\n_legacy_paths:\n  policy: runtime/openclaw-policy.yaml\n",
    );
    const legacyPolicy = writeFile(fixtureRoot, "runtime/openclaw-policy.yaml", "version: 1\n");

    const definition = buildFromRoot(fixtureRoot, manifestPath);

    expect(definition.policyAdditionsPath).toBe(legacyPolicy);
  });

  it("rejects manifest paths outside or aliased beneath the trusted root", () => {
    const manifestPath = writeAgentRoot(fixtureRoot);
    const outsideRoot = fs.mkdtempSync(path.join(TEST_PARENT, "outside-"));
    const outsideManifest = writeAgentRoot(outsideRoot);
    try {
      expect(() =>
        buildAgentDefinition({
          manifest: loadManifestRecord(outsideManifest),
          manifestPath: outsideManifest,
          packageRoot: fixtureRoot,
        }),
      ).toThrow(/inside the agent package root/u);

      const aliasedManifest = `${path.dirname(manifestPath)}/../openclaw/manifest.yaml`;
      expect(() =>
        buildAgentDefinition({
          manifest: loadManifestRecord(manifestPath),
          manifestPath: aliasedManifest,
          packageRoot: fixtureRoot,
        }),
      ).toThrow(/canonical absolute path/u);
    } finally {
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it.each(["/etc/passwd", "../outside", "runtime\\outside"])(
    "rejects hostile legacy asset path %s",
    (legacyPath) => {
      const manifestPath = writeAgentRoot(fixtureRoot);
      const manifest = parseManifestRecord(
        `name: openclaw\n_legacy_paths:\n  dockerfile: ${JSON.stringify(legacyPath)}\n`,
        manifestPath,
      );

      expect(() =>
        buildAgentDefinition({ manifest, manifestPath, packageRoot: fixtureRoot }),
      ).toThrow(/canonical relative path/u);
    },
  );

  it("rejects symbolic links used by ordinary or legacy package assets", () => {
    const manifestPath = writeAgentRoot(fixtureRoot, { legacyPath: "runtime/legacy.Dockerfile" });
    const outside = writeFile(fixtureRoot, "outside/Dockerfile", "FROM scratch\n");
    fs.mkdirSync(path.join(fixtureRoot, "runtime"), { recursive: true, mode: 0o700 });
    fs.symlinkSync(outside, path.join(fixtureRoot, "packages/nemoclaw-openclaw/Dockerfile"));
    fs.symlinkSync(outside, path.join(fixtureRoot, "runtime/legacy.Dockerfile"));

    expect(() =>
      buildAgentDefinition({
        manifest: loadManifestRecord(manifestPath),
        manifestPath,
        packageRoot: fixtureRoot,
      }),
    ).toThrow(/symbolic links/u);
  });

  it("revalidates legacy assets after the definition is built", () => {
    const manifestPath = writeAgentRoot(fixtureRoot, {
      legacyPath: "runtime/legacy.Dockerfile",
    });
    const legacyDockerfile = writeFile(fixtureRoot, "runtime/legacy.Dockerfile", "FROM scratch\n");
    const replacement = writeFile(fixtureRoot, "replacement/Dockerfile", "FROM scratch\n");
    const definition = buildAgentDefinition({
      manifest: loadManifestRecord(manifestPath),
      manifestPath,
      packageRoot: fixtureRoot,
    });

    expect(definition.legacyPaths?.dockerfile).toBe(legacyDockerfile);
    fs.rmSync(legacyDockerfile);
    fs.symlinkSync(replacement, legacyDockerfile);

    expect(() => definition.legacyPaths).toThrow(/symbolic links/u);
  });
});
