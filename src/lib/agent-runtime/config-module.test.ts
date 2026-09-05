// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HarnessConfigModuleError,
  loadHarnessConfigAdapterHostModule,
  loadHarnessConfigRestoreHostModule,
} from "./config-module";
import { installHarnessPackage } from "./package/install";
import type { InstalledHarnessPackage } from "./package/store";

const TEST_PARENT = path.join(process.cwd(), "node_modules/.cache/nemoclaw-config-module-tests");
const SOURCE_IDENTITY = Object.freeze({
  kind: "bundled" as const,
  nemoclawBuildIdentity: Object.freeze({
    nemoclawVersion: "0.0.113",
    sourceRevision: "c".repeat(40),
  }),
});

const CONFIG_MODULE = `
module.exports = {
  prepareConfigUpdate(request) {
    return {
      kind: "transaction",
      content: request.serializedConfig + "\\n",
      validation: null,
      write: {
        command: ["future-config", request.expectedConfigSha256],
        timeoutSeconds: 20,
        failureMessage: "future config failed",
        success: { kind: "exit-zero" },
      },
      restart: { kind: "external", guidance: ["Restart Future Harness."] },
    };
  },
  classifyConfigUrl(request) {
    return {
      allowPrivateUrls: request.config.allowPrivate === true,
      allowOpenShellBridge: request.key === "model.endpoint",
    };
  },
  describeMutableConfig() {
    return { kind: "not-required", reason: "future config is immutable after startup" };
  },
};
`;

const RESTORE_MODULE = `
module.exports = {
  mergeConfigState(request) {
    if (request.currentContent === null) return { kind: "refused", reason: "current required" };
    return {
      kind: "merged",
      content: request.currentContent + request.backupContent,
      write: { kind: "atomic" },
    };
  },
};
`;

function configModuleWithMutablePlan(planSource: string): string {
  return CONFIG_MODULE.replace(
    'return { kind: "not-required", reason: "future config is immutable after startup" };',
    `return ${planSource};`,
  );
}

fs.mkdirSync(TEST_PARENT, { recursive: true, mode: 0o700 });

let fixtureRoot = "";
let sourceRoot = "";
let storeRoot = "";

function writeFixtureFile(relativePath: string, contents: string): void {
  const target = path.join(sourceRoot, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, contents, { mode: 0o600 });
}

function installFuturePackage(
  configModule = CONFIG_MODULE,
  restoreModule = RESTORE_MODULE,
): InstalledHarnessPackage {
  writeFixtureFile(
    "nemoclaw-package.json",
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "agent-runtime",
      id: "future-harness",
      displayName: "Future Harness",
      packageVersion: "1.0.0",
      minimumNemoClawVersion: "0.0.113",
      manifest: "packages/nemoclaw-future-harness/manifest.yaml",
    })}\n`,
  );
  writeFixtureFile(
    "packages/nemoclaw-future-harness/manifest.yaml",
    [
      "name: future-harness",
      "display_name: Future Harness",
      "config:",
      "  dir: /sandbox/.future",
      "  config_file: config.json",
      "  format: json",
      "",
    ].join("\n"),
  );
  writeFixtureFile("packages/nemoclaw-future-harness/host/config-adapter.cts", configModule);
  writeFixtureFile("packages/nemoclaw-future-harness/host/restore-adapter.cts", restoreModule);
  return installHarnessPackage(
    { packageRoot: sourceRoot, sourceIdentity: SOURCE_IDENTITY },
    { storeRoot },
  );
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(TEST_PARENT, "fixture-"));
  sourceRoot = path.join(fixtureRoot, "source");
  storeRoot = path.join(fixtureRoot, "store");
  fs.mkdirSync(storeRoot, { recursive: true, mode: 0o700 });
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("installed harness configuration adapter", () => {
  it("runs an unknown harness through the typed update, URL, posture, and restore operations", () => {
    const installed = installFuturePackage();
    const adapter = loadHarnessConfigAdapterHostModule(installed.identity, { storeRoot });
    const target = {
      directory: "/sandbox/.future",
      file: "config.json",
      format: "json",
      sensitiveFiles: [],
    };

    expect(
      adapter.prepareConfigUpdate({
        config: { allowPrivate: true },
        serializedConfig: '{"allowPrivate":true}',
        expectedConfigSha256: "a".repeat(64),
        target,
      }),
    ).toMatchObject({
      kind: "transaction",
      content: '{"allowPrivate":true}\n',
      write: { command: ["future-config", "a".repeat(64)] },
    });
    expect(
      adapter.classifyConfigUrl({
        config: { allowPrivate: true },
        key: "model.endpoint",
        relativePath: [],
      }),
    ).toEqual({ allowPrivateUrls: true, allowOpenShellBridge: true });
    expect(adapter.describeMutableConfig({ target, sandboxUid: null, sandboxGid: null })).toEqual({
      kind: "not-required",
      reason: "future config is immutable after startup",
    });

    const restore = loadHarnessConfigRestoreHostModule(installed.identity, { storeRoot });
    expect(
      restore.mergeConfigState({
        backupContent: "backup",
        currentContent: "current",
        managedChannelNames: [],
        previousImagePluginInstalls: null,
        freshImagePluginInstalls: null,
      }),
    ).toEqual({ kind: "merged", content: "currentbackup", write: { kind: "atomic" } });
  });

  it("rejects an invalid configuration plan before core can execute it", () => {
    const installed = installFuturePackage(
      CONFIG_MODULE.replace("timeoutSeconds: 20", 'timeoutSeconds: "forever"'),
    );
    const adapter = loadHarnessConfigAdapterHostModule(installed.identity, { storeRoot });

    expect(() =>
      adapter.prepareConfigUpdate({
        config: {},
        serializedConfig: "{}",
        expectedConfigSha256: "a".repeat(64),
        target: {
          directory: "/sandbox/.future",
          file: "config.json",
          format: "json",
          sensitiveFiles: [],
        },
      }),
    ).toThrow(/returned an invalid configuration update plan/u);
  });

  it("rejects a validation command whose declared transaction proof cannot be verified", () => {
    const invalidValidation = `{
      command: ["future-config", "validate"],
      timeoutSeconds: 20,
      failureMessage: "future validation failed",
      success: {
        kind: "config-transaction",
        action: "validate",
        configDirectory: "/sandbox/.future",
        protectedFiles: ["config.json"],
      },
    }`;
    const installed = installFuturePackage(
      CONFIG_MODULE.replace("validation: null", `validation: ${invalidValidation}`),
    );
    const adapter = loadHarnessConfigAdapterHostModule(installed.identity, { storeRoot });
    let caught: unknown;

    try {
      adapter.prepareConfigUpdate({
        config: {},
        serializedConfig: "{}",
        expectedConfigSha256: "a".repeat(64),
        target: {
          directory: "/sandbox/.future",
          file: "config.json",
          format: "json",
          sensitiveFiles: [],
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HarnessConfigModuleError);
    expect(caught).toMatchObject({ code: "invalid-adapter" });
    expect((caught as Error).message).toMatch(/returned an invalid configuration update plan/u);
  });

  it.each([
    [
      "probe",
      `{
        kind: "probe",
        probe: {
          command: ["future-config", "probe"],
          timeoutSeconds: 20,
          failureMessage: "future probe failed",
          success: {
            kind: "config-transaction",
            action: "probe",
            configDirectory: "/sandbox/.future",
            protectedFiles: ["config.json"],
          },
        },
      }`,
    ],
    [
      "repair",
      `{
        kind: "stat",
        directoryMode: "2770",
        directoryOwner: "sandbox:sandbox",
        fileMode: "660",
        fileOwner: "sandbox:sandbox",
        repair: {
          command: ["future-config", "repair"],
          timeoutSeconds: 20,
          failureMessage: "future repair failed",
          success: {
            kind: "config-transaction",
            action: "repair",
            configDirectory: "/sandbox/.future",
            protectedFiles: ["config.json"],
          },
        },
      }`,
    ],
  ])("rejects a %s command whose declared success proof cannot be verified", (_kind, plan) => {
    const installed = installFuturePackage(configModuleWithMutablePlan(plan));
    const adapter = loadHarnessConfigAdapterHostModule(installed.identity, { storeRoot });
    let caught: unknown;

    try {
      adapter.describeMutableConfig({
        target: {
          directory: "/sandbox/.future",
          file: "config.json",
          format: "json",
          sensitiveFiles: [],
        },
        sandboxUid: null,
        sandboxGid: null,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HarnessConfigModuleError);
    expect(caught).toMatchObject({ code: "invalid-adapter" });
    expect((caught as Error).message).toMatch(/returned an invalid mutable configuration plan/u);
  });

  it("rejects a restore result without a finite write plan", () => {
    const installed = installFuturePackage(
      CONFIG_MODULE,
      RESTORE_MODULE.replace(',\n      write: { kind: "atomic" }', ""),
    );
    const restore = loadHarnessConfigRestoreHostModule(installed.identity, { storeRoot });

    expect(() =>
      restore.mergeConfigState({
        backupContent: "backup",
        currentContent: "current",
        managedChannelNames: [],
        previousImagePluginInstalls: null,
        freshImagePluginInstalls: null,
      }),
    ).toThrow(/returned an invalid configuration restore result/u);
  });

  it("rejects a config-anchor restore without exact hash inputs", () => {
    const invalidRestoreModule = RESTORE_MODULE.replace(
      'write: { kind: "atomic" }',
      'write: { kind: "config-anchors" }',
    );
    const installed = installFuturePackage(CONFIG_MODULE, invalidRestoreModule);
    const restore = loadHarnessConfigRestoreHostModule(installed.identity, { storeRoot });

    expect(() =>
      restore.mergeConfigState({
        backupContent: "backup",
        currentContent: "current",
        managedChannelNames: [],
        previousImagePluginInstalls: null,
        freshImagePluginInstalls: null,
      }),
    ).toThrow(/returned an invalid configuration restore result/u);
  });

  it("rejects a restore result that exceeds the configuration document boundary", () => {
    const oversizedRestoreModule = RESTORE_MODULE.replace(
      "request.currentContent + request.backupContent",
      '"x".repeat(16 * 1024 * 1024 + 1)',
    );
    const installed = installFuturePackage(CONFIG_MODULE, oversizedRestoreModule);
    const restore = loadHarnessConfigRestoreHostModule(installed.identity, { storeRoot });

    expect(() =>
      restore.mergeConfigState({
        backupContent: "backup",
        currentContent: "current",
        managedChannelNames: [],
        previousImagePluginInstalls: null,
        freshImagePluginInstalls: null,
      }),
    ).toThrow(/returned an invalid configuration restore result/u);
  });
});
