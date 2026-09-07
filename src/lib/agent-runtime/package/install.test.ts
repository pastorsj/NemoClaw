// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TEST_CONFIG_ADAPTER_SOURCE,
  TEST_MESSAGING_ADAPTER_SOURCE,
  TEST_STARTUP_ADAPTER_SOURCE,
} from "../../../../test/helpers/adapter-fixtures";
import { activateHarnessPackage } from "./activation";
import { installHarnessPackage } from "./install";
import {
  HarnessPackageStoreIntegrityError,
  readInstalledHarnessPackage,
  resolvePinnedHarnessPackage,
  type InstalledHarnessPackage,
} from "./store";
import type { BundledHarnessPackageSourceIdentity } from "./receipt";
import type { HarnessPackageIdentity } from "./types";
import { validateHarnessPackage } from "./validation";

const FIRST_SOURCE_IDENTITY: BundledHarnessPackageSourceIdentity = {
  kind: "bundled",
  nemoclawBuildIdentity: {
    nemoclawVersion: "0.0.113",
    sourceRevision: "b".repeat(40),
  },
};
const SECOND_SOURCE_IDENTITY: BundledHarnessPackageSourceIdentity = {
  kind: "bundled",
  nemoclawBuildIdentity: {
    nemoclawVersion: "0.0.114",
    sourceRevision: "c".repeat(40),
  },
};
const STORE_TEST_PARENT = path.join(
  process.cwd(),
  "node_modules/.cache/nemoclaw-package-store-tests",
);
const INSTALL_TEST_PARENT = path.join(
  process.cwd(),
  "node_modules/.cache/nemoclaw-package-install-tests",
);
fs.mkdirSync(STORE_TEST_PARENT, { recursive: true, mode: 0o700 });
fs.mkdirSync(INSTALL_TEST_PARENT, { recursive: true, mode: 0o700 });

let fixtureRoot = path.join(process.cwd(), ".nemoclaw-install-test-unused");
let sourceRoot = path.join(fixtureRoot, "source");
let storeRoot = path.join(fixtureRoot, "store");

function packageEnvelope(packageVersion: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "agent-runtime",
    id: "openclaw",
    displayName: "OpenClaw",
    packageVersion,
    minimumNemoClawVersion: "0.0.113",
    maximumNemoClawVersionExclusive: "0.0.121",
    manifest: "packages/nemoclaw-openclaw/manifest.yaml",
  };
}

function writeFixtureFile(relativePath: string, contents: string, mode = 0o600): void {
  const target = path.join(sourceRoot, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, contents, { mode });
  fs.chmodSync(target, mode);
}

function writePackage(packageVersion = "1.0.0", payload = "first payload\n"): void {
  fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(sourceRoot, 0o700);
  writeFixtureFile("nemoclaw-package.json", `${JSON.stringify(packageEnvelope(packageVersion))}\n`);
  writeFixtureFile(
    "packages/nemoclaw-openclaw/manifest.yaml",
    [
      "name: openclaw",
      "display_name: OpenClaw",
      "description: Reviewed runtime adapter",
      "runtime:",
      "  kind: gateway",
      "  interactive_command: openclaw",
      "  process_lifecycle:",
      "    support: unsupported",
      "    reason: This fixture does not manage a gateway process.",
      "gateway_command: openclaw gateway run",
      "health_probe:",
      "  url: http://127.0.0.1:18789/health",
      "  port: 18789",
      "  timeout_seconds: 30",
      "config:",
      "  dir: /sandbox/.openclaw",
      "  config_file: openclaw.json",
      "  format: json",
      "inference:",
      "  config_update:",
      "    support: unsupported",
      "    reason: This synthetic package has fixed inference configuration.",
      "messaging:",
      "  support: disabled",
      "policy:",
      "  owned_presets: []",
      "  automatic_presets: []",
      "  baseline_exclusion_impacts: {}",
      "state_lifecycle:",
      "  backup_quiescence:",
      "    kind: not-required",
      "  snapshot_restore: []",
      "  rebuild:",
      "    managed_extensions:",
      "      support: disabled",
      "      reason: Test package has no managed extensions.",
      "    scheduled_work:",
      "      support: disabled",
      "      reason: This package does not run scheduled work.",
      "    post_restore:",
      "      kind: not-required",
      "",
    ].join("\n"),
  );
  writeFixtureFile(
    "packages/nemoclaw-openclaw/host/config-adapter.cts",
    TEST_CONFIG_ADAPTER_SOURCE,
  );
  writeFixtureFile(
    "packages/nemoclaw-openclaw/host/messaging-adapter.cts",
    TEST_MESSAGING_ADAPTER_SOURCE,
  );
  writeFixtureFile(
    "packages/nemoclaw-openclaw/host/startup-adapter.cts",
    TEST_STARTUP_ADAPTER_SOURCE,
  );
  writeFixtureFile("runtime/payload.txt", payload);
}

function install(sourceIdentity: BundledHarnessPackageSourceIdentity = FIRST_SOURCE_IDENTITY) {
  return installHarnessPackage({ packageRoot: sourceRoot, sourceIdentity }, { storeRoot });
}

function installLocal(expectedId = "openclaw") {
  return installHarnessPackage(
    { packageRoot: sourceRoot, expectedId, sourceIdentity: { kind: "local" } },
    { storeRoot },
  );
}

function receiptPath(identity: HarnessPackageIdentity): string {
  return path.join(storeRoot, "receipts", identity.id, "sha256", `${identity.contentDigest}.json`);
}

function objectPath(identity: HarnessPackageIdentity): string {
  return path.join(storeRoot, "objects", "sha256", identity.contentDigest);
}

function failPublication(): never {
  throw new Error("injected active-pointer publication failure");
}

function failMissingPackage(): never {
  throw new Error("expected an installed harness package");
}

function readActivePackage(): InstalledHarnessPackage {
  return readInstalledHarnessPackage("openclaw", { storeRoot }) ?? failMissingPackage();
}

function configAdapterWithDescribeMutableConfig(exportValue: string): string {
  return `
"use strict";
module.exports = {
  describeInferenceConfig() {},
  prepareInferenceConfig() {},
  prepareConfigUpdate() {},
  classifyConfigUrl() {},
  ${exportValue}
};
`;
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(INSTALL_TEST_PARENT, "fixture-"));
  fs.chmodSync(fixtureRoot, 0o700);
  sourceRoot = path.join(fixtureRoot, "source");
  storeRoot = path.join(fixtureRoot, "store");
  fs.mkdirSync(storeRoot, { mode: 0o700 });
  writePackage();
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { force: true, recursive: true });
});

describe("installHarnessPackage", () => {
  it("returns one receipt-bound package with only installed lifecycle state", () => {
    const result = install();

    expect(result.state).toBe("installed");
    expect(result.identity).toEqual(result.receipt.identity);
    expect(result.packageManifest.envelope.id).toBe("openclaw");
    expect(result.packageRoot).toBe(objectPath(result.identity));
    expect(result).not.toHaveProperty("available");
    expect(result).not.toHaveProperty("selected");
    expect(result).not.toHaveProperty("qualified");
    expect(result).not.toHaveProperty("supported");
  });

  it("records only bounded local provenance for an explicitly matched package id", () => {
    const result = installLocal();

    expect(result.receipt.sourceIdentity).toEqual({ kind: "local" });
    expect(JSON.stringify(result.receipt)).not.toContain(sourceRoot);
  });

  it("rejects a local package id mismatch before creating package-store state", () => {
    expect(() => installLocal("hermes")).toThrow(
      "Harness package id does not match the requested installation id",
    );
    expect(fs.readdirSync(storeRoot)).toEqual([]);
  });

  it("reuses immutable object and receipt bytes during an exact reinstall", () => {
    const first = install();
    const immutableReceipt = receiptPath(first.identity);
    const immutableObject = objectPath(first.identity);
    const receiptBytes = fs.readFileSync(immutableReceipt);
    const receiptStat = fs.lstatSync(immutableReceipt, { bigint: true });
    const objectStat = fs.lstatSync(immutableObject, { bigint: true });

    const second = install(SECOND_SOURCE_IDENTITY);

    expect(second.identity).toEqual(first.identity);
    expect(second.receipt).toEqual(first.receipt);
    expect(second.receipt.sourceIdentity).toEqual(FIRST_SOURCE_IDENTITY);
    expect(fs.readFileSync(immutableReceipt)).toEqual(receiptBytes);
    expect(fs.lstatSync(immutableReceipt, { bigint: true }).ino).toBe(receiptStat.ino);
    expect(fs.lstatSync(immutableReceipt, { bigint: true }).mtimeNs).toBe(receiptStat.mtimeNs);
    expect(fs.lstatSync(immutableObject, { bigint: true }).ino).toBe(objectStat.ino);
    expect(fs.lstatSync(immutableObject, { bigint: true }).mtimeNs).toBe(objectStat.mtimeNs);
  });

  it("publishes the captured package tree when its source changes during publication", () => {
    const result = installHarnessPackage(
      { packageRoot: sourceRoot, sourceIdentity: FIRST_SOURCE_IDENTITY },
      {
        storeRoot,
        dependencies: {
          onPublicationCheckpoint: (checkpoint) =>
            checkpoint === "before-object-publication"
              ? writeFixtureFile("runtime/payload.txt", "later payload\n")
              : undefined,
        },
      },
    );

    expect(fs.readFileSync(path.join(result.packageRoot, "runtime/payload.txt"), "utf8")).toBe(
      "first payload\n",
    );
    expect(fs.readFileSync(path.join(sourceRoot, "runtime/payload.txt"), "utf8")).toBe(
      "later payload\n",
    );
  });

  it("rejects changed bytes that retain the same package version", () => {
    const first = install();
    writePackage("1.0.0", "changed payload\n");

    expect(() => install()).toThrow(/digest|version|identity/u);
    expect(readActivePackage().identity).toEqual(first.identity);
  });

  it("advances to a new version while retaining the prior pinned package", () => {
    const first = install();
    writePackage("1.1.0", "changed payload\n");

    const second = install();

    expect(second.identity.packageVersion).toBe("1.1.0");
    expect(second.identity.contentDigest).not.toBe(first.identity.contentDigest);
    expect(readActivePackage().identity).toEqual(second.identity);
    expect(resolvePinnedHarnessPackage(first.identity, { storeRoot }).identity).toEqual(
      first.identity,
    );
  });

  it("upgrades a local package by reinstall while retaining its prior pinned identity", () => {
    const first = installLocal();
    writePackage("1.1.0", "changed local payload\n");

    const second = installLocal();

    expect(second.identity.packageVersion).toBe("1.1.0");
    expect(second.receipt.sourceIdentity).toEqual({ kind: "local" });
    expect(readActivePackage().identity).toEqual(second.identity);
    expect(resolvePinnedHarnessPackage(first.identity, { storeRoot }).identity).toEqual(
      first.identity,
    );
  });

  it("leaves the prior package active when pointer publication fails", () => {
    const first = install();
    writePackage("1.1.0", "changed payload\n");

    expect(() =>
      installHarnessPackage(
        { packageRoot: sourceRoot, sourceIdentity: SECOND_SOURCE_IDENTITY },
        {
          storeRoot,
          dependencies: {
            onPublicationCheckpoint: (checkpoint) =>
              checkpoint === "before-active-pointer-replacement" ? failPublication() : undefined,
          },
        },
      ),
    ).toThrow(HarnessPackageStoreIntegrityError);
    expect(readActivePackage().identity).toEqual(first.identity);

    const recovered = install(SECOND_SOURCE_IDENTITY);
    expect(recovered.identity.packageVersion).toBe("1.1.0");
  });

  it.each([
    ["missing", ""],
    ["wrongly typed", 'describeMutableConfig: "not-a-function",'],
  ])(
    "retains a package with a %s fixed export but refuses to install or activate it",
    (_condition, exportValue) => {
      const first = install();
      writePackage("1.1.0", "unqualified payload\n");
      writeFixtureFile(
        "packages/nemoclaw-openclaw/host/config-adapter.cts",
        configAdapterWithDescribeMutableConfig(exportValue),
      );
      const report = validateHarnessPackage(sourceRoot);

      expect(report.valid).toBe(true);
      expect(() => install(SECOND_SOURCE_IDENTITY)).toThrow(
        /configuration adapter.*must export describeMutableConfig/u,
      );
      expect(readActivePackage().identity).toEqual(first.identity);
      expect(fs.existsSync(objectPath(report.identity))).toBe(true);
      expect(fs.existsSync(receiptPath(report.identity))).toBe(true);
      expect(resolvePinnedHarnessPackage(report.identity, { storeRoot }).identity).toEqual(
        report.identity,
      );

      expect(() =>
        activateHarnessPackage("openclaw", report.identity.contentDigest, { storeRoot }),
      ).toThrow(/configuration adapter.*must export describeMutableConfig/u);
      expect(readActivePackage().identity).toEqual(first.identity);
    },
  );

  it("evaluates adapter modules only during trusted install and activation", () => {
    const first = install();
    writePackage("1.1.0", "initialization marker payload\n");
    writeFixtureFile(
      "packages/nemoclaw-openclaw/host/config-adapter.cts",
      'throw new Error("synthetic initialization marker"); module.exports = {};\n',
    );
    const report = validateHarnessPackage(sourceRoot);

    expect(report.valid).toBe(true);
    expect(() => install(SECOND_SOURCE_IDENTITY)).toThrow(
      /configuration adapter.*could not be evaluated/u,
    );
    expect(resolvePinnedHarnessPackage(report.identity, { storeRoot }).identity).toEqual(
      report.identity,
    );
    expect(() =>
      activateHarnessPackage("openclaw", report.identity.contentDigest, { storeRoot }),
    ).toThrow(/configuration adapter.*could not be evaluated/u);
    expect(readActivePackage().identity).toEqual(first.identity);
  });

  it("initializes exports without running adapter operations or the provider controller", () => {
    const controllerMarker = path.join(fixtureRoot, "provider-controller-ran");
    const operationFailure = 'throw new Error("synthetic adapter operation ran");';
    const throwingExports = (names: readonly string[]) =>
      `"use strict"; module.exports = { ${names
        .map((name) => `${name}() { ${operationFailure} }`)
        .join(", ")} };\n`;
    writeFixtureFile(
      "packages/nemoclaw-openclaw/host/config-adapter.cts",
      throwingExports([
        "describeInferenceConfig",
        "prepareInferenceConfig",
        "prepareConfigUpdate",
        "classifyConfigUrl",
        "describeMutableConfig",
      ]),
    );
    writeFixtureFile(
      "packages/nemoclaw-openclaw/host/messaging-adapter.cts",
      throwingExports(["describeMessagingIntegration"]),
    );
    writeFixtureFile(
      "packages/nemoclaw-openclaw/host/startup-adapter.cts",
      throwingExports([
        "buildStartupPlan",
        "prepareStartupProfile",
        "buildInitialStartupProfile",
        "reconcileStartupProfile",
      ]),
    );
    fs.appendFileSync(
      path.join(sourceRoot, "packages/nemoclaw-openclaw/manifest.yaml"),
      [
        "provider_broker:",
        "  support: managed",
        "  adapter: provider-broker",
        "  operations:",
        "    - describe-provider",
        "    - register-refresh-provider",
        "    - ensure-broker",
        "    - inspect-broker",
        "    - teardown-broker",
        "",
      ].join("\n"),
    );
    writeFixtureFile(
      "packages/nemoclaw-openclaw/host/provider-broker-adapter.cts",
      throwingExports(["buildProviderBrokerPlan"]),
    );
    writeFixtureFile(
      "packages/nemoclaw-openclaw/host/provider-broker-control.cts",
      `require("node:fs").writeFileSync(${JSON.stringify(controllerMarker)}, "ran");\n`,
    );

    expect(install().state).toBe("installed");
    expect(fs.existsSync(controllerMarker)).toBe(false);
  });

  it("rejects malformed source identity before creating package-store state", () => {
    const sourceIdentity = {
      ...FIRST_SOURCE_IDENTITY,
      token: "must-not-persist",
    } as unknown as BundledHarnessPackageSourceIdentity;

    expect(() => install(sourceIdentity)).toThrow("source identity fields do not match");
    expect(fs.readdirSync(storeRoot)).toEqual([]);
  });

  it("rejects an invalid manifest before creating package-store state", () => {
    writeFixtureFile("packages/nemoclaw-openclaw/manifest.yaml", "name: hermes\n");

    expect(() => install()).toThrow("manifest name must match the package id");
    expect(fs.readdirSync(storeRoot)).toEqual([]);
  });

  it("rejects a package missing a required adapter before creating package-store state", () => {
    fs.rmSync(
      path.join(sourceRoot, "packages", "nemoclaw-openclaw", "host", "messaging-adapter.cts"),
    );

    expect(() => install()).toThrow(
      "requires a non-empty regular artifact 'host/messaging-adapter.cts'",
    );
    expect(fs.readdirSync(storeRoot)).toEqual([]);
  });

  it.each([
    ["missing", undefined, "metadata fields do not match"],
    ["malformed", "0.0", "minimumNemoClawVersion"],
  ])(
    "rejects a %s minimum NemoClaw version before creating package-store state",
    (_label, minimumNemoClawVersion, expectedMessage) => {
      const envelope = packageEnvelope("1.0.0");
      minimumNemoClawVersion === undefined
        ? Reflect.deleteProperty(envelope, "minimumNemoClawVersion")
        : Object.assign(envelope, { minimumNemoClawVersion });
      writeFixtureFile("nemoclaw-package.json", `${JSON.stringify(envelope)}\n`);

      expect(() => install()).toThrow(expectedMessage);
      expect(fs.readdirSync(storeRoot)).toEqual([]);
    },
  );

  it.each([
    ["below the minimum", "0.0.112", false, "requires NemoClaw 0.0.113 or newer"],
    ["at the minimum", "0.0.113", true, ""],
    ["below the maximum", "0.0.114", true, ""],
    ["at the maximum", "0.0.115", false, "requires NemoClaw older than 0.0.115"],
    ["above the maximum", "0.0.116", false, "requires NemoClaw older than 0.0.115"],
  ])("handles a running core %s", (_label, nemoclawVersion, compatible, expectedMessage) => {
    const envelope = packageEnvelope("1.0.0");
    envelope.maximumNemoClawVersionExclusive = "0.0.115";
    writeFixtureFile("nemoclaw-package.json", `${JSON.stringify(envelope)}\n`);

    const operation = () =>
      installHarnessPackage(
        { packageRoot: sourceRoot, sourceIdentity: FIRST_SOURCE_IDENTITY },
        {
          storeRoot,
          getBuildIdentity: () => ({ nemoclawVersion, sourceRevision: "a".repeat(40) }),
        },
      );
    const assertCompatibility = compatible
      ? () => expect(operation().identity.id).toBe("openclaw")
      : () => {
          expect(operation).toThrow(expectedMessage);
          expect(fs.readdirSync(storeRoot)).toEqual([]);
        };
    assertCompatibility();
  });

  it("refuses an existing pinned receipt after the running core leaves its window", () => {
    const installed = install();
    const incompatibleCore = {
      storeRoot,
      getBuildIdentity: () => ({
        nemoclawVersion: "0.0.121",
        sourceRevision: "a".repeat(40),
      }),
    };

    expect(() => readInstalledHarnessPackage("openclaw", incompatibleCore)).toThrow(
      "requires NemoClaw older than 0.0.121",
    );
    expect(() => resolvePinnedHarnessPackage(installed.identity, incompatibleCore)).toThrow(
      "requires NemoClaw older than 0.0.121",
    );
    expect(() =>
      activateHarnessPackage("openclaw", installed.identity.contentDigest, incompatibleCore),
    ).toThrow("requires NemoClaw older than 0.0.121");
  });

  it("rejects package authoring content before creating package-store state", () => {
    writeFixtureFile("tests/host-install.test.ts", "throw new Error('must not run');\n");

    expect(() => install()).toThrow("contains authoring content");
    expect(fs.readdirSync(storeRoot)).toEqual([]);
  });

  it("copies executable and authoring sentinels without running package lifecycle scripts", () => {
    const marker = path.join(fixtureRoot, "package-code-ran");
    const markerCommand = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`;
    writeFixtureFile(
      "package.json",
      `${JSON.stringify({ scripts: { install: `node -e ${JSON.stringify(markerCommand)}` } })}\n`,
    );
    writeFixtureFile("install.sh", `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, 0o700);
    writeFixtureFile(
      "authoring-check.py",
      `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('ran')\n`,
      0o700,
    );

    const result = install();

    expect(result.state).toBe("installed");
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(path.join(result.packageRoot, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(result.packageRoot, "install.sh"))).toBe(true);
    expect(fs.existsSync(path.join(result.packageRoot, "authoring-check.py"))).toBe(true);
  });
});
