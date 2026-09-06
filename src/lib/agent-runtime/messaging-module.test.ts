// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MessagingWorkflowPlanner } from "../messaging/compiler";
import type { ChannelManifest } from "../messaging/manifest";
import { ChannelManifestRegistry } from "../messaging/manifest/registry";
import {
  HarnessMessagingSupportError,
  listMessagingChannelsForProfile,
  resolveSandboxMessagingProfileAuthority,
} from "../messaging/profile-authority";
import { installHarnessPackage } from "./package/install";
import type { InstalledHarnessPackage } from "./package/store";
import { HarnessMessagingModuleError, loadHarnessMessagingIntegration } from "./messaging-module";

const TEST_PARENT = path.join(process.cwd(), "node_modules/.cache/nemoclaw-messaging-module-tests");
const SOURCE_IDENTITY = Object.freeze({
  kind: "bundled" as const,
  nemoclawBuildIdentity: Object.freeze({
    nemoclawVersion: "0.0.113",
    sourceRevision: "a".repeat(40),
  }),
});
const VALID_MODULE = `
module.exports = {
  describeMessagingIntegration(request) {
    return {
      kind: "channels",
      packageId: request.packageId,
      channelIds: ["future-channel"],
      profilePath: "messaging/profile.json",
      build: {
        configRoot: "~/.future-harness",
        packageManagers: ["node-package"],
        postCreateCredentialReconciliation: "restart-runtime",
        credentialPolicyReconciliation: "teams-outlook-shared-login",
        degradedDiagnostics: "gateway-log-tail",
      },
    };
  },
};
`;

fs.mkdirSync(TEST_PARENT, { recursive: true, mode: 0o700 });

let fixtureRoot = path.join(TEST_PARENT, "unused");
let sourceRoot = path.join(fixtureRoot, "source");
let storeRoot = path.join(fixtureRoot, "store");

function writeFixtureFile(relativePath: string, contents: string): void {
  const target = path.join(sourceRoot, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, contents, { mode: 0o600 });
  fs.chmodSync(target, 0o600);
}

function writeFuturePackage(
  moduleSource = VALID_MODULE,
  messagingDeclaration = "  support: channels\n  channels:\n    - future-channel",
  hookIds: readonly string[] = [],
  statePaths: readonly string[] = ["state/future-channel"],
): void {
  fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(sourceRoot, 0o700);
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
      "runtime:",
      "  kind: terminal",
      "  interactive_command: future-harness",
      "  headless_command: future-harness",
      "  prompt_transport: argv",
      "config:",
      "  dir: /sandbox/.future-harness",
      "  config_file: config.json",
      "  format: json",
      "inference:",
      "  config_update:",
      "    support: unsupported",
      "    reason: Fixed test harness",
      "state_lifecycle:",
      "  backup_quiescence:",
      "    kind: not-required",
      "  snapshot_restore: []",
      "  rebuild:",
      "    image_plugin_provenance: not-required",
      "    scheduled_work:",
      "      support: disabled",
      "      reason: This package does not run scheduled work.",
      "    post_restore:",
      "      kind: not-required",
      "messaging:",
      messagingDeclaration,
      "",
    ].join("\n"),
  );
  writeFixtureFile("runtime/payload.txt", "future runtime\n");
  writeFixtureFile("packages/nemoclaw-future-harness/host/messaging-adapter.cts", moduleSource);
  writeFixtureFile(
    "packages/nemoclaw-future-harness/messaging/profile.json",
    `${JSON.stringify([
      {
        channelId: "future-channel",
        config: {
          renders: [
            {
              id: "future-config",
              kind: "json-fragment",
              target: "~/.future-harness/config.json",
              path: "channels.future",
              value: { enabled: true },
            },
          ],
          statePaths,
        },
        policy: [{ presetName: "future", policyKeys: ["future_bridge"] }],
        lifecycle: {
          runtime: {
            envAliases: [
              {
                envKey: "FUTURE_SOURCE",
                targetEnvKey: "FUTURE_TARGET",
                match: "^source$",
                value: "target",
              },
            ],
          },
          packageInstalls: [
            {
              id: "futurePlugin",
              manager: "node-package",
              spec: "future-channel@1.0.0",
              required: true,
            },
          ],
          hookIds,
        },
      },
    ])}\n`,
  );
}

function installFuturePackage(
  moduleSource = VALID_MODULE,
  messagingDeclaration?: string,
): InstalledHarnessPackage {
  writeFuturePackage(moduleSource, messagingDeclaration);
  return installHarnessPackage(
    { packageRoot: sourceRoot, sourceIdentity: SOURCE_IDENTITY },
    { storeRoot },
  );
}

function installFuturePackageWithoutAdapter(): InstalledHarnessPackage {
  writeFuturePackage();
  fs.rmSync(path.join(sourceRoot, "packages/nemoclaw-future-harness/host/messaging-adapter.cts"));
  return installHarnessPackage(
    { packageRoot: sourceRoot, sourceIdentity: SOURCE_IDENTITY },
    { storeRoot },
  );
}

function futureChannelService(
  supportedAgents: readonly string[] = ["core-native-harness"],
): ChannelManifest {
  return {
    schemaVersion: 1 as const,
    id: "future-channel",
    displayName: "Future Channel",
    supportedAgents,
    auth: { mode: "none" as const },
    inputs: [],
    credentials: [],
    render: [],
    hooks: [],
  };
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(TEST_PARENT, "fixture-"));
  fs.chmodSync(fixtureRoot, 0o700);
  sourceRoot = path.join(fixtureRoot, "source");
  storeRoot = path.join(fixtureRoot, "store");
  fs.mkdirSync(storeRoot, { mode: 0o700 });
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("installed harness messaging module", () => {
  it("loads a synthetic package through the fixed typed profile", () => {
    const installed = installFuturePackage();

    expect(loadHarnessMessagingIntegration(installed.identity, { storeRoot })).toEqual({
      kind: "channels",
      packageId: "future-harness",
      build: {
        configRoot: "~/.future-harness",
        packageManagers: ["node-package"],
        postCreateCredentialReconciliation: "restart-runtime",
        credentialPolicyReconciliation: "teams-outlook-shared-login",
        degradedDiagnostics: "gateway-log-tail",
      },
      channels: [
        {
          channelId: "future-channel",
          config: {
            renders: [
              {
                id: "future-config",
                kind: "json-fragment",
                target: "~/.future-harness/config.json",
                path: "channels.future",
                value: { enabled: true },
              },
            ],
            statePaths: ["state/future-channel"],
          },
          policy: [{ presetName: "future", policyKeys: ["future_bridge"] }],
          lifecycle: {
            runtime: {
              envAliases: [
                {
                  envKey: "FUTURE_SOURCE",
                  targetEnvKey: "FUTURE_TARGET",
                  match: "^source$",
                  value: "target",
                },
              ],
            },
            packageInstalls: [
              {
                id: "futurePlugin",
                manager: "node-package",
                spec: "future-channel@1.0.0",
                required: true,
              },
            ],
            hookIds: [],
          },
        },
      ],
    });
  });

  it("resolves an unknown package id without a core package dispatch table", () => {
    const installed = installFuturePackage();
    const authority = resolveSandboxMessagingProfileAuthority(
      { agent: "future-harness", harnessPackage: installed.identity },
      { storeRoot },
    );
    const registry = new ChannelManifestRegistry([futureChannelService()]);

    expect(authority.agent.name).toBe("future-harness");
    expect(authority.packageAuthority.harnessPackage).toEqual(installed.identity);
    const [projected] = listMessagingChannelsForProfile(authority, registry);
    expect(projected?.id).toBe("future-channel");
    expect(projected?.supportedAgents).toEqual(["future-harness"]);
    expect(projected?.packageBuild).toEqual({
      configRoot: "~/.future-harness",
      packageManagers: ["node-package"],
      postCreateCredentialReconciliation: "restart-runtime",
      credentialPolicyReconciliation: "teams-outlook-shared-login",
      degradedDiagnostics: "gateway-log-tail",
    });
    expect(projected?.render).toEqual([
      {
        id: "future-config",
        kind: "json-fragment",
        agent: "future-harness",
        target: "~/.future-harness/config.json",
        fragment: { path: "channels.future", value: { enabled: true } },
      },
    ]);
    expect(projected?.policyPresets).toEqual([{ name: "future", policyKeys: ["future_bridge"] }]);
    expect(projected?.agentPackages).toEqual([
      {
        id: "futurePlugin",
        agent: "future-harness",
        manager: "node-package",
        spec: "future-channel@1.0.0",
        required: true,
      },
    ]);
    expect(projected?.state).toEqual({
      "future-harness": ["state/future-channel"],
    });
    expect(projected?.runtime).toEqual({
      "future-harness": {
        envAliases: [
          {
            envKey: "FUTURE_SOURCE",
            targetEnvKey: "FUTURE_TARGET",
            match: "^source$",
            value: "target",
          },
        ],
      },
    });
  });

  it("projects an unknown receipt-backed package into shared build and runtime plans", async () => {
    const installed = installFuturePackage();
    const authority = resolveSandboxMessagingProfileAuthority(
      { agent: "future-harness", harnessPackage: installed.identity },
      { storeRoot },
    );
    const coreRegistry = new ChannelManifestRegistry([futureChannelService()]);
    const manifests = listMessagingChannelsForProfile(authority, coreRegistry);
    const planner = new MessagingWorkflowPlanner(new ChannelManifestRegistry(manifests));
    const plan = await planner.buildPlan({
      sandboxName: "future-sandbox",
      agent: "future-harness",
      workflow: "onboard",
      isInteractive: false,
      configuredChannels: ["future-channel"],
    });

    expect(plan.agent).toBe("future-harness");
    expect(plan.packageBuild).toEqual({
      configRoot: "~/.future-harness",
      packageManagers: ["node-package"],
      postCreateCredentialReconciliation: "restart-runtime",
      credentialPolicyReconciliation: "teams-outlook-shared-login",
      degradedDiagnostics: "gateway-log-tail",
    });
    expect(plan.agentRender).toEqual([
      {
        channelId: "future-channel",
        renderId: "future-config",
        hookId: "future-config",
        handler: "common.staticOutputs",
        kind: "json-fragment",
        agent: "future-harness",
        target: "~/.future-harness/config.json",
        path: "channels.future",
        value: { enabled: true },
        templateRefs: [],
      },
    ]);
    expect(plan.buildSteps).toEqual([
      {
        channelId: "future-channel",
        kind: "package-install",
        outputId: "futurePlugin",
        required: true,
        value: { manager: "node-package", spec: "future-channel@1.0.0" },
      },
    ]);
    expect(plan.runtimeSetup).toEqual({
      nodePreloads: [],
      envAliases: [
        {
          channelId: "future-channel",
          envKey: "FUTURE_SOURCE",
          targetEnvKey: "FUTURE_TARGET",
          match: "^source$",
          value: "target",
        },
      ],
      secretScans: [],
    });

    const removalPlan = await planner.buildChannelRemovalTombstonePlanFromSandboxEntry({
      sandboxName: "future-sandbox",
      agent: "future-harness",
      channelId: "future-channel",
      sandboxEntry: {
        name: "future-sandbox",
        agent: "future-harness",
        messaging: { schemaVersion: 1, plan },
      },
      supportedChannelIds: ["future-channel"],
    });
    expect(removalPlan?.channels).toEqual([
      expect.objectContaining({
        channelId: "future-channel",
        active: false,
        disabled: true,
        pendingRemoval: true,
      }),
    ]);
  });

  it("returns a typed disabled profile without inventing channel behavior", () => {
    const installed = installFuturePackage(
      `module.exports = {
        describeMessagingIntegration(request) {
          return { kind: "disabled", packageId: request.packageId, reason: "No bridge." };
        },
      };`,
      "  support: disabled",
    );
    const authority = resolveSandboxMessagingProfileAuthority(
      { agent: "future-harness", harnessPackage: installed.identity },
      { storeRoot },
    );

    expect(authority.integration).toEqual({
      kind: "disabled",
      packageId: "future-harness",
      reason: "No bridge.",
    });
    expect(listMessagingChannelsForProfile(authority, new ChannelManifestRegistry())).toEqual([]);
  });

  it("rejects a package channel without a compatible core service", () => {
    const installed = installFuturePackage();
    const authority = resolveSandboxMessagingProfileAuthority(
      { agent: "future-harness", harnessPackage: installed.identity },
      { storeRoot },
    );
    const registry = new ChannelManifestRegistry();

    expect(() => listMessagingChannelsForProfile(authority, registry)).toThrow(
      HarnessMessagingSupportError,
    );
  });

  it("rejects package hook ids outside the core-owned channel workflow", () => {
    writeFuturePackage(VALID_MODULE, undefined, ["untrusted-hook"]);
    const installed = installHarnessPackage(
      { packageRoot: sourceRoot, sourceIdentity: SOURCE_IDENTITY },
      { storeRoot },
    );
    const authority = resolveSandboxMessagingProfileAuthority(
      { agent: "future-harness", harnessPackage: installed.identity },
      { storeRoot },
    );
    const registry = new ChannelManifestRegistry([futureChannelService()]);

    expect(() => listMessagingChannelsForProfile(authority, registry)).toThrow(
      HarnessMessagingSupportError,
    );
  });

  it("rejects unsafe package-owned channel state paths", () => {
    writeFuturePackage(VALID_MODULE, undefined, [], ["../outside"]);
    const installed = installHarnessPackage(
      { packageRoot: sourceRoot, sourceIdentity: SOURCE_IDENTITY },
      { storeRoot },
    );

    expect(() => loadHarnessMessagingIntegration(installed.identity, { storeRoot })).toThrow(
      /unsafe state path/u,
    );
  });

  it("rejects an adapter result for a different package id", () => {
    const installed = installFuturePackage(
      `module.exports = {
        describeMessagingIntegration() {
          return {
            kind: "channels",
            packageId: "other-harness",
            channelIds: ["future-channel"],
            profilePath: "messaging/profile.json",
            build: { configRoot: "~/.future-harness", packageManagers: [] },
          };
        },
      };`,
    );

    expect(() => loadHarnessMessagingIntegration(installed.identity, { storeRoot })).toThrow(
      /does not match its package identity/u,
    );
  });

  it("rejects disagreement between the manifest and adapter channel lists", () => {
    const installed = installFuturePackage(
      `module.exports = {
        describeMessagingIntegration(request) {
          return {
            kind: "channels",
            packageId: request.packageId,
            channelIds: ["other-channel"],
            profilePath: "messaging/profile.json",
            build: { configRoot: "~/.future-harness", packageManagers: [] },
          };
        },
      };`,
    );

    expect(() => loadHarnessMessagingIntegration(installed.identity, { storeRoot })).toThrow(
      /does not match its manifest declaration/u,
    );
  });

  it("rejects credential-shaped fields at the static adapter boundary", () => {
    const installed = installFuturePackage(
      `module.exports = {
        describeMessagingIntegration(request) {
          return {
            kind: "channels",
            packageId: request.packageId,
            channelIds: ["future-channel"],
            profilePath: "messaging/profile.json",
            token: "not-allowed",
          };
        },
      };`,
    );

    expect(() => loadHarnessMessagingIntegration(installed.identity, { storeRoot })).toThrow(
      /returned an invalid messaging integration/u,
    );
  });

  it("rejects a missing fixed adapter before package support can be used", () => {
    const installed = installFuturePackageWithoutAdapter();

    expect(() => loadHarnessMessagingIntegration(installed.identity, { storeRoot })).toThrow(
      HarnessMessagingModuleError,
    );
  });

  it("rejects adapter bytes that no longer match the package receipt", () => {
    const installed = installFuturePackage();
    fs.appendFileSync(
      path.join(
        installed.packageRoot,
        "packages/nemoclaw-future-harness/host/messaging-adapter.cts",
      ),
      "\n",
    );

    expect(() => loadHarnessMessagingIntegration(installed.identity, { storeRoot })).toThrow(
      /integrity validation/u,
    );
  });
});
