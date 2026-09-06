// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  findLayerImportBoundaryViolations,
  findManagedRuntimeBoundaryViolations,
  findPackageImageBoundaryViolations,
  parseReceiptHarnessDecisionBaseline,
} from "../../scripts/checks/layer-import-boundaries.mts";

const REPO_ROOT = path.join(import.meta.dirname, "../..");
let fixtureCounter = 0;

function fixturePath(dir: string, label: string, extension = ".ts"): string {
  fixtureCounter += 1;
  return path.join(
    REPO_ROOT,
    dir,
    `__boundary-${label}-${process.pid}-${fixtureCounter}${extension}`,
  );
}

function namedActionFixturePath(extension = ".mts"): string {
  fixtureCounter += 1;
  return path.join(
    REPO_ROOT,
    "src/lib",
    `__boundary-${process.pid}-${fixtureCounter}-action${extension}`,
  );
}

function scanFixture(
  fixture: string,
  source: string,
  packagesRoot?: string,
  options?: Parameters<typeof findLayerImportBoundaryViolations>[2],
) {
  try {
    fs.writeFileSync(fixture, source);
    return findLayerImportBoundaryViolations(fixture, packagesRoot, options);
  } finally {
    fs.rmSync(fixture, { force: true });
  }
}

function harnessDebtSource(entries: readonly unknown[]): string {
  return JSON.stringify({
    description: "Test receipt-backed harness debt.",
    match: ["file", "function", "decisionKind", "packageId", "occurrences"],
    entries,
  });
}

describe("CLI layer import boundaries (#6245)", () => {
  it("keeps domain, adapter, action, and command layers separated (#6245)", () => {
    expect(findLayerImportBoundaryViolations()).toEqual([]);
  });

  it("keeps managed runtime orchestration provider-neutral (#9145)", () => {
    expect(findManagedRuntimeBoundaryViolations()).toEqual([]);
  });

  it("discovers future package IDs for managed bootstrap neutrality", () => {
    const packagesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-packages-"));
    const packageRoot = path.join(packagesRoot, "future-runtime");
    const fixture = fixturePath("src/lib/onboard/managed-bootstrap", "future-package-id");
    fs.mkdirSync(packageRoot);
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@example/future-runtime",
        nemoclaw: { harnessManifest: "manifest.yaml" },
      }),
    );
    fs.writeFileSync(path.join(packageRoot, "manifest.yaml"), "name: future-harness\n");
    fs.writeFileSync(fixture, 'export const encodedAgent = "future-harness";\n');
    try {
      expect(findManagedRuntimeBoundaryViolations(packagesRoot)).toEqual([
        expect.objectContaining({
          file: path.relative(REPO_ROOT, fixture),
          rule: "managed-state-root-neutrality",
          detail: "managed bootstrap and Podman provider code must not encode agent IDs",
        }),
      ]);
    } finally {
      fs.rmSync(fixture, { force: true });
      fs.rmSync(packagesRoot, { force: true, recursive: true });
    }
  });

  it("rejects an exact future package ID passed to receipt-store authority", () => {
    const packagesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-receipt-packages-"));
    const packageRoot = path.join(packagesRoot, "future-runtime");
    const fixture = fixturePath("src/lib", "future-receipt-selector");
    fs.mkdirSync(packageRoot);
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@example/future-runtime",
        nemoclaw: { harnessManifest: "manifest.yaml" },
      }),
    );
    fs.writeFileSync(path.join(packageRoot, "manifest.yaml"), "name: future-harness\n");
    try {
      expect(
        scanFixture(fixture, 'readInstalledHarnessPackage("future-harness");\n', packagesRoot, {
          verifyReceiptHarnessDecisionBaseline: false,
        }),
      ).toEqual([
        expect.objectContaining({
          rule: "receipt-backed-package-selector",
          detail: expect.stringContaining("future-harness"),
        }),
      ]);
    } finally {
      fs.rmSync(packagesRoot, { force: true, recursive: true });
    }
  });

  it("allows a future package receipt selected from typed authority", () => {
    const fixture = fixturePath("src/lib", "typed-receipt-selector");
    expect(
      scanFixture(
        fixture,
        "export function selectPackage(packageId: string) { return readInstalledHarnessPackage(packageId); }\n",
        undefined,
        { verifyReceiptHarnessDecisionBaseline: false },
      ),
    ).toEqual([]);
  });

  it("rejects an exact future package ID at the provider-broker boundary", () => {
    const packagesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-broker-packages-"));
    const packageRoot = path.join(packagesRoot, "future-runtime");
    const fixture = fixturePath("src/lib", "future-provider-broker-selector");
    fs.mkdirSync(packageRoot);
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@example/future-runtime",
        nemoclaw: { harnessManifest: "manifest.yaml" },
      }),
    );
    fs.writeFileSync(path.join(packageRoot, "manifest.yaml"), "name: future-harness\n");
    try {
      expect(
        scanFixture(
          fixture,
          'runHarnessProviderBrokerController("future-harness", request);\n',
          packagesRoot,
          { verifyReceiptHarnessDecisionBaseline: false },
        ),
      ).toEqual([
        expect.objectContaining({
          rule: "receipt-backed-package-selector",
          detail: expect.stringContaining("runHarnessProviderBrokerController"),
        }),
      ]);
    } finally {
      fs.rmSync(packagesRoot, { force: true, recursive: true });
    }
  });

  it("rejects core-native files copied into a publishable package image", () => {
    const packagesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-image-packages-"));
    const packageRoot = path.join(packagesRoot, "future-runtime");
    fs.mkdirSync(packageRoot);
    fs.writeFileSync(
      path.join(packageRoot, "Dockerfile"),
      [
        "FROM scratch",
        "COPY scripts/managed-gateway-control.py /runtime/control.py",
        "COPY src/lib/messaging/ /runtime/messaging/",
      ].join("\n"),
    );
    try {
      expect(findPackageImageBoundaryViolations(packagesRoot)).toEqual([
        expect.objectContaining({
          rule: "package-image-native-ownership",
          detail: expect.stringContaining("scripts/managed-gateway-control.py"),
        }),
        expect.objectContaining({
          rule: "package-image-native-ownership",
          detail: expect.stringContaining("src/lib/messaging/"),
        }),
      ]);
    } finally {
      fs.rmSync(packagesRoot, { force: true, recursive: true });
    }
  });

  it("requires shared package runtimes to use the published contract materializer", () => {
    const packagesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-packages-"));
    const packageRoot = path.join(packagesRoot, "future-runtime");
    fs.mkdirSync(path.join(packageRoot, "runtime"), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, "messaging"), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "Dockerfile"), "FROM scratch\n");
    fs.writeFileSync(path.join(packageRoot, "runtime/managed-gateway-control.py"), "# runtime\n");
    fs.writeFileSync(path.join(packageRoot, "messaging/messaging-build.mts"), "// runtime\n");
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        devDependencies: { "@nvidia/nemoclaw-harness-contract": "^0.1.0" },
        scripts: {
          "build:runtime": "tsx ../../scripts/packages/build-messaging-runtime.mts",
          "check:runtime": "echo unchecked",
        },
      }),
    );
    try {
      expect(findPackageImageBoundaryViolations(packagesRoot)).toEqual([
        expect.objectContaining({
          rule: "package-image-runtime-materializer",
          detail: expect.stringContaining("must not reach into NemoClaw core source"),
        }),
        expect.objectContaining({
          rule: "package-image-runtime-materializer",
          detail: expect.stringContaining("runtime/managed-gateway-control.py must be built"),
        }),
        expect.objectContaining({
          rule: "package-image-runtime-materializer",
          detail: expect.stringContaining("messaging/messaging-build.mts must be built"),
        }),
      ]);

      fs.writeFileSync(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          devDependencies: { "@nvidia/nemoclaw-harness-contract": "^0.1.0" },
          scripts: {
            "build:runtime":
              "nemoclaw-materialize-runtime managed-gateway runtime/managed-gateway-control.py && nemoclaw-materialize-runtime messaging-build messaging/messaging-build.mts",
            "check:runtime":
              "nemoclaw-materialize-runtime managed-gateway runtime/managed-gateway-control.py --check && nemoclaw-materialize-runtime messaging-build messaging/messaging-build.mts --check",
          },
        }),
      );
      expect(findPackageImageBoundaryViolations(packagesRoot)).toEqual([]);
    } finally {
      fs.rmSync(packagesRoot, { force: true, recursive: true });
    }
  });

  it("rejects another installed package ID from a managed gateway profile", () => {
    const packagesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-profile-packages-"));
    for (const packageId of ["first-agent", "future-agent"]) {
      const packageRoot = path.join(packagesRoot, packageId);
      fs.mkdirSync(path.join(packageRoot, "runtime"), { recursive: true });
      fs.writeFileSync(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: `@example/${packageId}`,
          nemoclaw: { harnessManifest: "manifest.yaml" },
        }),
      );
      fs.writeFileSync(path.join(packageRoot, "manifest.yaml"), `name: ${packageId}\n`);
      fs.writeFileSync(path.join(packageRoot, "Dockerfile"), "FROM scratch\n");
    }
    fs.writeFileSync(
      path.join(packagesRoot, "first-agent/runtime/managed-gateway-profile.py"),
      'OTHER_PACKAGE = "future-agent"\n',
    );
    try {
      expect(findPackageImageBoundaryViolations(packagesRoot)).toEqual([
        expect.objectContaining({
          rule: "package-image-native-ownership",
          detail: "managed gateway profile for first-agent must not encode package future-agent",
        }),
      ]);
    } finally {
      fs.rmSync(packagesRoot, { force: true, recursive: true });
    }
  });

  it("recognizes the repository's hidden internal oclif command base", () => {
    const fixture = fixturePath("src/commands/internal", "internal-command");
    expect(
      scanFixture(
        fixture,
        [
          'import { NemoClawInternalCommand as InternalBase } from "../../lib/cli/internal-command";',
          "export default class Example extends InternalBase {}",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it.each([
    ["a static import", 'import "@nvidia/nemoclaw-pi";\n'],
    ["a re-export", 'export * from "@nvidia/nemoclaw-pi/runtime";\n'],
    ["CommonJS require", 'require("@nvidia/nemoclaw-pi");\n'],
    ["a dynamic import", 'void import("@nvidia/nemoclaw-pi/runtime");\n'],
  ])("blocks %s from an agent runtime package", (_case, source) => {
    expect(scanFixture(fixturePath("src/lib", "agent-runtime-package"), source)).toEqual([
      expect.objectContaining({
        rule: "core-no-agent-runtime-package-imports",
        detail:
          "core source must use the typed agent runtime package contract instead of importing @nvidia/nemoclaw-pi",
      }),
    ]);
  });

  it("blocks a relative import from an agent runtime package", () => {
    const fixture = fixturePath("src/lib", "relative-agent-runtime-package");
    const target = path.join(REPO_ROOT, "packages/nemoclaw-openclaw/compat/npm-remediation.mts");
    const specifier = path.relative(path.dirname(fixture), target).split(path.sep).join("/");

    expect(scanFixture(fixture, `import ${JSON.stringify(specifier)};\n`)).toEqual([
      expect.objectContaining({
        rule: "core-no-agent-runtime-package-imports",
        detail: expect.stringContaining("@nvidia/nemoclaw-openclaw"),
      }),
    ]);
  });

  it("discovers an agent runtime package from package metadata", () => {
    const packagesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-packages-"));
    const packageRoot = path.join(packagesRoot, "custom-runtime");
    fs.mkdirSync(packageRoot);
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@example/custom-runtime",
        nemoclaw: { harnessManifest: "manifest.yaml" },
      }),
    );
    try {
      expect(
        scanFixture(
          fixturePath("src/lib", "metadata-agent-runtime-package"),
          'import "@example/custom-runtime";\n',
          packagesRoot,
        ),
      ).toEqual([
        expect.objectContaining({
          rule: "core-no-agent-runtime-package-imports",
          detail: expect.stringContaining("@example/custom-runtime"),
        }),
      ]);
    } finally {
      fs.rmSync(packagesRoot, { force: true, recursive: true });
    }
  });

  it("does not classify shared NeMo Fabric infrastructure as an agent runtime package", () => {
    expect(
      scanFixture(fixturePath("src/lib", "fabric-package"), 'import "nemoclaw-fabric";\n'),
    ).toEqual([]);
  });

  it("keeps generic harness contract modules free of discovered package IDs", () => {
    const violations = scanFixture(
      fixturePath("src/lib/agent-runtime/adapter", "package-id"),
      'export const packageId = "pi";\n',
    );

    expect(violations).toEqual([
      expect.objectContaining({
        rule: "harness-contract-neutrality",
        detail: "generic harness contract code must not encode package ID 'pi'",
      }),
    ]);
  });

  it("discovers future package IDs from their manifests", () => {
    const packagesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-packages-"));
    const packageRoot = path.join(packagesRoot, "future-runtime");
    fs.mkdirSync(packageRoot);
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@example/future-runtime",
        nemoclaw: { harnessManifest: "manifest.yaml" },
      }),
    );
    fs.writeFileSync(path.join(packageRoot, "manifest.yaml"), "name: future-harness\n");
    try {
      expect(
        scanFixture(
          fixturePath("src/lib/agent-runtime/package", "future-package-id"),
          'export const packageId = "future-harness";\n',
          packagesRoot,
        ),
      ).toEqual([
        expect.objectContaining({
          rule: "harness-contract-neutrality",
          detail: "generic harness contract code must not encode package ID 'future-harness'",
        }),
      ]);
    } finally {
      fs.rmSync(packagesRoot, { force: true, recursive: true });
    }
  });

  it("allows package names in comments and explanatory text", () => {
    expect(
      scanFixture(
        fixturePath("src/lib/agent-runtime/adapter", "package-id-prose"),
        '// pi is an example only.\nexport const explanation = "pi-compatible example";\n',
      ),
    ).toEqual([]);
  });

  it("blocks exact harness decisions after package authority is resolved", () => {
    const fixture = fixturePath("src/lib", "receipt-harness-branch");
    const authority = path
      .relative(
        path.dirname(fixture),
        path.join(REPO_ROOT, "src/lib/onboard/package/package-authority"),
      )
      .split(path.sep)
      .join("/");
    const specifier = authority.startsWith(".") ? authority : `./${authority}`;
    const violations = scanFixture(
      fixture,
      `import { resolvePackageBackedSandboxAgent } from ${JSON.stringify(specifier)};\n` +
        `export function decide(entry: Parameters<typeof resolvePackageBackedSandboxAgent>[0]) {\n` +
        `  const resolved = resolvePackageBackedSandboxAgent(entry);\n` +
        `  return resolved.definition.name === "pi";\n` +
        `}\n`,
    );

    expect(violations).toEqual([
      expect.objectContaining({
        rule: "receipt-backed-harness-neutrality",
        detail: expect.stringContaining("package ID 'pi'"),
      }),
    ]);
  });

  it("blocks harness decisions through transitive package-authority imports", () => {
    const authorityBridge = fixturePath("src/lib", "receipt-authority-bridge");
    const featureBridge = fixturePath("src/lib", "receipt-feature-bridge");
    const consumer = fixturePath("src/lib", "receipt-indirect-consumer");
    const authority = path
      .relative(
        path.dirname(authorityBridge),
        path.join(REPO_ROOT, "src/lib/onboard/package/package-authority"),
      )
      .split(path.sep)
      .join("/");
    const authoritySpecifier = authority.startsWith(".") ? authority : `./${authority}`;
    const featureSpecifier = `./${path.basename(featureBridge, ".ts")}`;
    const bridgeSpecifier = `./${path.basename(authorityBridge, ".ts")}`;
    try {
      fs.writeFileSync(
        authorityBridge,
        `export { resolvePackageBackedSandboxAgent } from ${JSON.stringify(authoritySpecifier)};\n`,
      );
      fs.writeFileSync(
        featureBridge,
        `export { resolvePackageBackedSandboxAgent } from ${JSON.stringify(bridgeSpecifier)};\n`,
      );
      fs.writeFileSync(
        consumer,
        `import { resolvePackageBackedSandboxAgent } from ${JSON.stringify(featureSpecifier)};\n` +
          `export function decide(entry: Parameters<typeof resolvePackageBackedSandboxAgent>[0]) {\n` +
          `  return resolvePackageBackedSandboxAgent(entry).definition.name === "pi";\n` +
          `}\n`,
      );

      expect(findLayerImportBoundaryViolations(consumer)).toEqual([
        expect.objectContaining({
          file: path.relative(REPO_ROOT, consumer),
          rule: "receipt-backed-harness-neutrality",
          detail: expect.stringContaining("package ID 'pi' (equality decision in 'decide')"),
        }),
      ]);
    } finally {
      fs.rmSync(consumer, { force: true });
      fs.rmSync(featureBridge, { force: true });
      fs.rmSync(authorityBridge, { force: true });
    }
  });

  it("blocks harness decisions in typed callbacks that receive package authority as data", () => {
    const fixture = fixturePath("src/lib", "receipt-callback-consumer");
    const repoPath = path.relative(REPO_ROOT, fixture).split(path.sep).join("/");
    const violations = scanFixture(
      fixture,
      'export function decide(agent: { name: string }) {\n  return agent.name === "pi";\n}\n',
      undefined,
      { receiptBackedCallbackModules: new Set([repoPath]) },
    );

    expect(violations).toEqual([
      expect.objectContaining({
        file: repoPath,
        rule: "receipt-backed-harness-neutrality",
        detail: expect.stringContaining("package ID 'pi' (equality decision in 'decide')"),
      }),
    ]);
  });

  it("allows comments and diagnostics through transitive package-authority imports", () => {
    const authorityBridge = fixturePath("src/lib", "receipt-diagnostic-bridge");
    const consumer = fixturePath("src/lib", "receipt-indirect-diagnostic");
    const authority = path
      .relative(
        path.dirname(authorityBridge),
        path.join(REPO_ROOT, "src/lib/sandbox/command-agent"),
      )
      .split(path.sep)
      .join("/");
    const authoritySpecifier = authority.startsWith(".") ? authority : `./${authority}`;
    const bridgeSpecifier = `./${path.basename(authorityBridge, ".ts")}`;
    try {
      fs.writeFileSync(
        authorityBridge,
        `export { resolveSandboxCommandAgent } from ${JSON.stringify(authoritySpecifier)};\n`,
      );
      fs.writeFileSync(
        consumer,
        `import { resolveSandboxCommandAgent } from ${JSON.stringify(bridgeSpecifier)};\n` +
          `// openclaw is named only to explain a historical migration.\n` +
          `export const diagnostic = "openclaw is a legacy example";\n` +
          `export { resolveSandboxCommandAgent };\n`,
      );

      expect(findLayerImportBoundaryViolations(consumer)).toEqual([]);
    } finally {
      fs.rmSync(consumer, { force: true });
      fs.rmSync(authorityBridge, { force: true });
    }
  });

  it("rejects a malformed harness debt occurrence limit", () => {
    expect(() =>
      parseReceiptHarnessDecisionBaseline(
        harnessDebtSource([["src/lib/example.ts", "decide", "equality", "openclaw", 0]]),
        "test harness debt",
      ),
    ).toThrow("test harness debt entry 1 has an invalid occurrence count");
  });

  it("reports a stale harness debt occurrence limit", () => {
    const fixture = fixturePath("src/lib", "receipt-stale-debt");
    const authority = path
      .relative(path.dirname(fixture), path.join(REPO_ROOT, "src/lib/sandbox/command-agent"))
      .split(path.sep)
      .join("/");
    const specifier = authority.startsWith(".") ? authority : `./${authority}`;
    const repoPath = path.relative(REPO_ROOT, fixture).split(path.sep).join("/");
    const baseline = parseReceiptHarnessDecisionBaseline(
      harnessDebtSource([[repoPath, "decide", "equality", "pi", 2]]),
    );
    try {
      fs.writeFileSync(
        fixture,
        `import { resolveSandboxCommandAgent } from ${JSON.stringify(specifier)};\n` +
          `export function decide(entry: Parameters<typeof resolveSandboxCommandAgent>[0]) {\n` +
          `  return resolveSandboxCommandAgent(entry).name === "pi";\n` +
          `}\n`,
      );

      expect(
        findLayerImportBoundaryViolations(fixture, undefined, {
          receiptHarnessDecisionBaseline: baseline,
          verifyReceiptHarnessDecisionBaseline: true,
        }),
      ).toEqual([
        expect.objectContaining({
          file: "scripts/checks/harness-debt.json",
          rule: "receipt-backed-harness-debt",
          detail: expect.stringContaining(
            `package ID 'pi' expects 2 equality decision occurrence(s) in 'decide' at ${repoPath}, but found 1`,
          ),
        }),
      ]);
    } finally {
      fs.rmSync(fixture, { force: true });
    }
  });

  it("blocks inline harness membership decisions after package authority is resolved", () => {
    const fixture = fixturePath("src/lib", "receipt-harness-membership");
    const authority = path
      .relative(path.dirname(fixture), path.join(REPO_ROOT, "src/lib/sandbox/command-agent"))
      .split(path.sep)
      .join("/");
    const specifier = authority.startsWith(".") ? authority : `./${authority}`;
    const violations = scanFixture(
      fixture,
      `import { resolveSandboxCommandAgent } from ${JSON.stringify(specifier)};\n` +
        `export function decide(entry: Parameters<typeof resolveSandboxCommandAgent>[0]) {\n` +
        `  return ["openclaw", "hermes"].includes(resolveSandboxCommandAgent(entry).name);\n` +
        `}\n`,
    );

    expect(violations).toEqual([
      expect.objectContaining({ rule: "receipt-backed-harness-neutrality" }),
      expect.objectContaining({ rule: "receipt-backed-harness-neutrality" }),
    ]);
  });

  it("allows package IDs in catalogue code that does not consume package authority", () => {
    expect(
      scanFixture(
        fixturePath("src/lib", "catalogue-harness-ids"),
        'export const qualifiedHarnesses = new Set(["openclaw", "pi"]);\n',
      ),
    ).toEqual([]);
  });

  it("allows exact harness decisions in legacy code without package authority", () => {
    expect(
      scanFixture(
        fixturePath("src/lib/state", "legacy-harness-decision"),
        'export function decodeLegacyAgent(agent: string) {\n  return agent === "openclaw";\n}\n',
      ),
    ).toEqual([]);
  });

  it("allows package IDs in non-decision diagnostics beside package authority", () => {
    const fixture = fixturePath("src/lib", "receipt-harness-diagnostic");
    const authority = path
      .relative(path.dirname(fixture), path.join(REPO_ROOT, "src/lib/sandbox/command-agent"))
      .split(path.sep)
      .join("/");
    const specifier = authority.startsWith(".") ? authority : `./${authority}`;
    expect(
      scanFixture(
        fixture,
        `import { resolveSandboxCommandAgent } from ${JSON.stringify(specifier)};\n` +
          'export const migrationNote = "openclaw is a legacy example";\n' +
          "export { resolveSandboxCommandAgent };\n",
      ),
    ).toEqual([]);
  });

  it("collects TypeScript import-equals references (#6245)", () => {
    const violations = scanFixture(
      fixturePath("src/lib/domain", "import-equals"),
      'import adapter = require("../adapters/openshell/client");\nexport const value = adapter;\n',
    );

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detail: "domain must not import src/lib/adapters/openshell/client.ts",
        }),
      ]),
    );
  });

  it("keeps messaging manifests isolated from side-effect layers (#6245)", () => {
    const violations = scanFixture(
      fixturePath("src/lib/messaging/manifest", "fs"),
      'import { readFileSync } from "node:fs";\nexport const value = readFileSync;\n',
    );

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detail: "messaging manifest modules must not import node:fs",
        }),
      ]),
    );
  });

  it("blocks bare fs imports in messaging manifests (#6245)", () => {
    const violations = scanFixture(
      fixturePath("src/lib/messaging/manifest", "bare-fs"),
      'import { readFile } from "fs/promises";\nexport const value = readFile;\n',
    );

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detail: "messaging manifest modules must not import fs",
        }),
      ]),
    );
  });

  it("blocks packaged bin shims outside protected layer directories (#6245)", () => {
    const violations = scanFixture(
      fixturePath("src/lib", "bin-lib-shim"),
      'import "../../bin/lib/ports.js";\n',
    );

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detail:
            "src must import implementation modules directly instead of packaged shim bin/lib/ports.js",
        }),
      ]),
    );
  });

  it.each([
    ["CommonJS require", 'export const ports = require("../../bin/lib/ports.js");\n'],
    ["dynamic import", 'export const ports = import("../../bin/lib/ports.js");\n'],
  ])("blocks packaged bin shims loaded through %s (#6245)", (_case, source) => {
    const violations = scanFixture(fixturePath("src/lib", "bin-lib-call"), source);

    expect(violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ rule: "src-no-bin-lib-shims" })]),
    );
  });

  it("classifies a bin shim imported through a source-tree symlink (#6245)", () => {
    const importer = fixturePath("src/lib", "bin-lib-alias-importer");
    const alias = fixturePath("src/lib", "bin-lib-alias", ".js");
    const relativeAlias = `./${path.basename(alias)}`;
    try {
      fs.symlinkSync(path.join(REPO_ROOT, "bin/lib/ports.js"), alias, "file");
      fs.writeFileSync(importer, `import "${relativeAlias}";\n`);

      expect(findLayerImportBoundaryViolations(importer)).toEqual([
        expect.objectContaining({
          detail:
            "src must import implementation modules directly instead of packaged shim bin/lib/ports.js",
        }),
      ]);
    } finally {
      fs.rmSync(importer, { force: true });
      fs.rmSync(alias, { force: true });
    }
  });

  it("counts only classes that extend Command as oclif command classes (#6245)", () => {
    const violations = scanFixture(
      fixturePath("src/commands", "implements"),
      'import { Command } from "@oclif/core";\nclass NotACommand implements Command {}\n',
    );

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detail: "command files must define exactly one registered oclif command class; found 0",
        }),
      ]),
    );
  });

  it.each([
    {
      name: "a direct oclif import",
      source:
        'import { Command } from "@oclif/core";\nexport default class Example extends Command {}\n',
    },
    {
      name: "an aliased oclif import",
      source:
        'import { Command as OclifCommand } from "@oclif/core";\nexport default class Example extends OclifCommand {}\n',
    },
    {
      name: "a namespace-qualified oclif import",
      source:
        'import * as oclif from "@oclif/core";\nexport default class Example extends oclif.Command {}\n',
    },
    {
      name: "the NemoClaw command base",
      source:
        'import { NemoClawCommand as Base } from "../lib/cli/nemoclaw-oclif-command";\nexport default class Example extends Base {}\n',
    },
  ])("recognizes $name by its import binding (#6245)", ({ source }) => {
    const violations = scanFixture(fixturePath("src/commands", "command-binding"), source);

    expect(violations).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ rule: "one-command-per-file" })]),
    );
  });

  it.each(["Command", "NemoClawCommand"])(
    "rejects an unrelated local %s class as a command base (#6245)",
    (baseName) => {
      const violations = scanFixture(
        fixturePath("src/commands", "local-command-base"),
        `class ${baseName} {}\nexport default class Example extends ${baseName} {}\n`,
      );

      expect(violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            detail: "command files must define exactly one registered oclif command class; found 0",
          }),
        ]),
      );
    },
  );

  it.each([".mts", ".cts", ".tsx"])(
    "scans production %s modules for protected-layer violations (#6245)",
    (extension) => {
      const violations = scanFixture(
        fixturePath("src/lib/actions", "module-extension", extension),
        'import { Command } from "@oclif/core";\n',
      );

      expect(violations).toEqual(
        expect.arrayContaining([expect.objectContaining({ rule: "actions-no-oclif" })]),
      );
    },
  );

  it("recognizes alternate-extension action modules outside the actions directory (#6245)", () => {
    const violations = scanFixture(
      namedActionFixturePath(),
      'import { Command } from "@oclif/core";\n',
    );

    expect(violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ rule: "actions-no-oclif" })]),
    );
  });

  it("resolves extensionless imports to alternate TypeScript modules (#6245)", () => {
    const target = fixturePath("src/lib/actions", "extensionless-target", ".mts");
    const importer = fixturePath("src/lib/domain", "extensionless-importer", ".mts");
    const specifier = path
      .relative(path.dirname(importer), target)
      .split(path.sep)
      .join("/")
      .replace(/\.mts$/, "");
    try {
      fs.writeFileSync(target, "export const value = true;\n");
      fs.writeFileSync(importer, `import { value } from "${specifier}";\nexport { value };\n`);

      expect(findLayerImportBoundaryViolations(importer)).toEqual([
        expect.objectContaining({
          detail: `domain must not import ${path.relative(REPO_ROOT, target)}`,
        }),
      ]);
    } finally {
      fs.rmSync(importer, { force: true });
      fs.rmSync(target, { force: true });
    }
  });

  it.each([
    { emittedExtension: ".js", sourceExtension: ".ts" },
    { emittedExtension: ".mjs", sourceExtension: ".mts" },
    { emittedExtension: ".cjs", sourceExtension: ".cts" },
  ])(
    "resolves $emittedExtension output specifiers to $sourceExtension source modules (#6245)",
    ({ emittedExtension, sourceExtension }) => {
      const target = fixturePath(
        "src/lib/adapters",
        `emitted-specifier-target-${sourceExtension.slice(1)}`,
        sourceExtension,
      );
      const importer = fixturePath(
        "src/lib/domain",
        `emitted-specifier-importer-${sourceExtension.slice(1)}`,
      );
      const specifier = path.relative(path.dirname(importer), target).split(path.sep).join("/");
      const emittedSpecifier = specifier.slice(0, -sourceExtension.length) + emittedExtension;
      try {
        fs.writeFileSync(target, "export const value = true;\n");
        fs.writeFileSync(
          importer,
          `import { value } from "${emittedSpecifier}";\nexport { value };\n`,
        );

        expect(findLayerImportBoundaryViolations(importer)).toEqual([
          expect.objectContaining({
            detail: `domain must not import ${path.relative(REPO_ROOT, target)}`,
          }),
        ]);
      } finally {
        fs.rmSync(importer, { force: true });
        fs.rmSync(target, { force: true });
      }
    },
  );

  it("resolves an extensionless directory import to its index module (#6245)", () => {
    const targetDir = fs.mkdtempSync(
      path.join(REPO_ROOT, "src/lib/actions/__boundary-extensionless-directory-"),
    );
    const target = path.join(targetDir, "index.mts");
    const importer = fixturePath("src/lib/domain", "extensionless-directory-importer", ".mts");
    const specifier = path.relative(path.dirname(importer), targetDir).split(path.sep).join("/");
    try {
      fs.writeFileSync(target, "export const value = true;\n");
      fs.writeFileSync(importer, `import { value } from "${specifier}";\nexport { value };\n`);

      expect(findLayerImportBoundaryViolations(importer)).toEqual([
        expect.objectContaining({
          detail: `domain must not import ${path.relative(REPO_ROOT, target)}`,
        }),
      ]);
    } finally {
      fs.rmSync(importer, { force: true });
      fs.rmSync(targetDir, { force: true, recursive: true });
    }
  });

  it.each([".test.mts", ".spec.cts", ".test.tsx"])(
    "excludes %s test modules from the production scan (#6245)",
    (extension) => {
      expect(
        scanFixture(
          fixturePath("src/lib/actions", "test-module-extension", extension),
          'import { Command } from "@oclif/core";\n',
        ),
      ).toEqual([]);
    },
  );

  it("does not recurse through a symbolic-link loop (#6245)", () => {
    const fixtureRoot = fs.mkdtempSync(
      path.join(REPO_ROOT, "src/lib/domain/__boundary-symlink-loop-"),
    );
    try {
      fs.writeFileSync(
        path.join(fixtureRoot, "violation.mts"),
        'import { spawn } from "node:child_process";\nexport { spawn };\n',
      );
      fs.symlinkSync(".", path.join(fixtureRoot, "loop"), "dir");

      expect(findLayerImportBoundaryViolations(fixtureRoot)).toEqual([
        expect.objectContaining({ rule: "domain-purity" }),
      ]);
    } finally {
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("classifies a symbolic-link import by its canonical protected-layer target (#6245)", () => {
    const target = fixturePath("src/lib/actions", "symlink-target", ".mts");
    const importer = fixturePath("src/lib/domain", "symlink-importer", ".mts");
    const alias = fixturePath("src/lib/domain", "symlink-alias", ".mts");
    const relativeAlias = path
      .relative(path.dirname(importer), alias)
      .split(path.sep)
      .join("/")
      .replace(/\.mts$/, "");
    const specifier = relativeAlias.startsWith(".") ? relativeAlias : `./${relativeAlias}`;
    try {
      fs.writeFileSync(target, "export const value = true;\n");
      fs.symlinkSync(target, alias, "file");
      fs.writeFileSync(importer, `import { value } from "${specifier}";\nexport { value };\n`);

      expect(findLayerImportBoundaryViolations(importer)).toEqual([
        expect.objectContaining({
          detail: `domain must not import ${path.relative(REPO_ROOT, target)}`,
        }),
      ]);
    } finally {
      fs.rmSync(importer, { force: true });
      fs.rmSync(alias, { force: true });
      fs.rmSync(target, { force: true });
    }
  });
});
