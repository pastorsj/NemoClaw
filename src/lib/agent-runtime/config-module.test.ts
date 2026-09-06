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
  describeInferenceConfig() {
    return { kind: "mutable", providerApiOverrides: [] };
  },
  prepareInferenceConfig(request) {
    const config = JSON.parse(JSON.stringify(request.config));
    config.runtime = {
      model: request.route.model,
      baseUrl: request.route.baseUrl,
      api: request.route.api,
    };
    return {
      kind: "mutation",
      config,
      changed: true,
      postCommit: {
        configSync: "required",
        gatewayRestart: { kind: "not-required" },
        sandboxReconcile: { kind: "not-required" },
      },
    };
  },
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
  inferenceDeclaration = [
    "inference:",
    "  config_update:",
    "    support: mutable",
    "    provider_api_overrides: []",
    "    post_commit:",
    "      config_sync: required",
    "      gateway_restart: not-required",
    "      sandbox_reconcile:",
    "        kind: not-required",
  ],
  managedImageDeclaration: readonly string[] = [],
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
      maximumNemoClawVersionExclusive: "0.0.121",
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
      ...managedImageDeclaration,
      ...inferenceDeclaration,
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
      adapter.prepareInferenceConfig({
        config: {},
        target,
        route: {
          upstreamProvider: "nvidia-prod",
          model: "nvidia/future-model",
          providerKey: "inference",
          primaryModelRef: null,
          baseUrl: "https://inference.local/v1",
          api: "openai-completions",
          compatibility: null,
        },
        contextWindow: 131_072,
        reasoning: { effort: null, explicit: false },
      }),
    ).toMatchObject({
      kind: "mutation",
      changed: true,
      config: {
        runtime: {
          model: "nvidia/future-model",
          baseUrl: "https://inference.local/v1",
          api: "openai-completions",
        },
      },
    });
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

  it("rejects an inference plan outside the finite result schema", () => {
    const installed = installFuturePackage(
      CONFIG_MODULE.replace("changed: true", 'changed: "yes"'),
    );
    const adapter = loadHarnessConfigAdapterHostModule(installed.identity, { storeRoot });

    expect(() =>
      adapter.prepareInferenceConfig({
        config: {},
        target: {
          directory: "/sandbox/.future",
          file: "config.json",
          format: "json",
          sensitiveFiles: [],
        },
        route: {
          upstreamProvider: "nvidia-prod",
          model: "nvidia/future-model",
          providerKey: "inference",
          primaryModelRef: "inference/nvidia/future-model",
          baseUrl: "https://inference.local/v1",
          api: "openai-completions",
          compatibility: null,
        },
        contextWindow: null,
        reasoning: { effort: null, explicit: false },
      }),
    ).toThrow(/returned an invalid inference configuration update plan/u);
  });

  it("rejects an adapter that disagrees with its inference manifest declaration", () => {
    const installed = installFuturePackage(
      CONFIG_MODULE.replace(
        'return { kind: "mutable", providerApiOverrides: [] };',
        'return { kind: "unsupported", reason: "Not available." };',
      ),
    );
    const adapter = loadHarnessConfigAdapterHostModule(installed.identity, { storeRoot });

    expect(() =>
      adapter.describeInferenceConfig({
        target: {
          directory: "/sandbox/.future",
          file: "config.json",
          format: "json",
          sensitiveFiles: [],
        },
      }),
    ).toThrow(/does not match its manifest declaration/u);
  });

  it("rejects a future adapter that requests an undeclared sandbox command", () => {
    const installed = installFuturePackage(
      CONFIG_MODULE.replace(
        'sandboxReconcile: { kind: "not-required" },',
        'sandboxReconcile: { kind: "command", trigger: "when-config-changes", command: ["/usr/local/lib/future/reconcile"], timeoutSeconds: 30 },',
      ),
    );
    const adapter = loadHarnessConfigAdapterHostModule(installed.identity, { storeRoot });

    expect(() =>
      adapter.prepareInferenceConfig({
        config: {},
        target: {
          directory: "/sandbox/.future",
          file: "config.json",
          format: "json",
          sensitiveFiles: [],
        },
        route: {
          upstreamProvider: "nvidia-prod",
          model: "nvidia/future-model",
          providerKey: "inference",
          primaryModelRef: null,
          baseUrl: "https://inference.local/v1",
          api: "openai-completions",
          compatibility: null,
        },
        contextWindow: null,
        reasoning: { effort: null, explicit: false },
      }),
    ).toThrow(/does not match its manifest declaration/u);
  });

  it("rejects command reconciliation without a managed-image runtime identity at load time", () => {
    const configModule = CONFIG_MODULE.replace(
      'sandboxReconcile: { kind: "not-required" },',
      'sandboxReconcile: { kind: "command", trigger: "when-config-changes", command: ["/usr/local/lib/future/reconcile"], timeoutSeconds: 30 },',
    );
    const installed = installFuturePackage(configModule, RESTORE_MODULE, [
      "inference:",
      "  config_update:",
      "    support: mutable",
      "    provider_api_overrides: []",
      "    post_commit:",
      "      config_sync: required",
      "      gateway_restart: not-required",
      "      sandbox_reconcile:",
      "        kind: command",
      "        trigger: when-config-changes",
      "        command:",
      "          - /usr/local/lib/future/reconcile",
      "        timeout_seconds: 30",
    ]);

    let caught: unknown;
    try {
      loadHarnessConfigAdapterHostModule(installed.identity, { storeRoot });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HarnessConfigModuleError);
    expect((caught as Error).message).toMatch(/integrity validation/u);
    const validationError = ((caught as Error).cause as Error | undefined)?.cause;
    expect(validationError).toBeInstanceOf(HarnessConfigModuleError);
    expect((validationError as Error).message).toMatch(
      /without a valid managed-image runtime identity/u,
    );
  });

  it("loads command reconciliation against the receipt-pinned managed-image identity", () => {
    const configModule = CONFIG_MODULE.replace(
      'sandboxReconcile: { kind: "not-required" },',
      'sandboxReconcile: { kind: "command", trigger: "when-config-changes", command: ["/usr/local/lib/future/reconcile"], timeoutSeconds: 30 },',
    );
    const installed = installFuturePackage(
      configModule,
      RESTORE_MODULE,
      [
        "inference:",
        "  config_update:",
        "    support: mutable",
        "    provider_api_overrides: []",
        "    post_commit:",
        "      config_sync: required",
        "      gateway_restart: not-required",
        "      sandbox_reconcile:",
        "        kind: command",
        "        trigger: when-config-changes",
        "        command:",
        "          - /usr/local/lib/future/reconcile",
        "        timeout_seconds: 30",
      ],
      [
        "managed_image:",
        "  repository: nvcr.io/nvidia/nemoclaw-future-harness",
        "  architectures:",
        "    - linux/amd64",
        "  runtime_identity:",
        "    uid: 4321",
        "    gid: 4322",
        "    workdir: /sandbox",
      ],
    );

    expect(() =>
      loadHarnessConfigAdapterHostModule(installed.identity, { storeRoot }),
    ).not.toThrow();
  });

  it("rejects a package that omits the inference configuration declaration", () => {
    const installed = installFuturePackage(CONFIG_MODULE, RESTORE_MODULE, []);

    expect(() => loadHarnessConfigAdapterHostModule(installed.identity, { storeRoot })).toThrow(
      /manifest does not declare configuration adapter/u,
    );
  });

  it("rejects a mutable declaration without bounded post-commit authority", () => {
    const installed = installFuturePackage(CONFIG_MODULE, RESTORE_MODULE, [
      "inference:",
      "  config_update:",
      "    support: mutable",
      "    provider_api_overrides: []",
    ]);

    expect(() => loadHarnessConfigAdapterHostModule(installed.identity, { storeRoot })).toThrow(
      /manifest does not declare configuration adapter/u,
    );
  });

  it("rejects inference adapter bytes that no longer match their package receipt", () => {
    const installed = installFuturePackage();
    fs.appendFileSync(
      path.join(installed.packageRoot, "packages/nemoclaw-future-harness/host/config-adapter.cts"),
      "\n",
    );

    expect(() => loadHarnessConfigAdapterHostModule(installed.identity, { storeRoot })).toThrow(
      /integrity validation/u,
    );
  });

  it("rejects an uninstalled package identity", () => {
    expect(() =>
      loadHarnessConfigAdapterHostModule(
        {
          kind: "agent-runtime",
          id: "unknown-harness",
          packageVersion: "1.0.0",
          contentDigest: "f".repeat(64),
        },
        { storeRoot },
      ),
    ).toThrow(HarnessConfigModuleError);
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
