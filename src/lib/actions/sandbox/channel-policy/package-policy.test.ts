// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as gatewayRuntime from "../../../gateway-runtime-action";
import type { AgentDefinition } from "../../../agent/defs";
import { validateHarnessPackageTree } from "../../../agent-runtime/package/tree";
import * as credentialStore from "../../../credentials/store";
import type {
  ChannelManifest,
  SandboxMessagingNetworkPolicyEntryPlan,
  SandboxMessagingPlan,
} from "../../../messaging";
import * as policies from "../../../policy";
import {
  captureSandboxCommandAgentAuthority,
  type SandboxCommandAgentAuthority,
} from "../../../sandbox/command-agent";
import * as registry from "../../../state/registry";
import * as registryMessaging from "../../../state/registry-messaging";
import * as registryRead from "../../../state/registry/read";
import { createHarnessPackageFixture } from "../../../../../test/helpers/harness-packages";
import { makeMessagingPlan } from "../../../../../test/helpers/messaging-plan-fixtures";
import {
  applyPreparedPackageChannelPolicy,
  applyPreparedPackageChannelPolicyWithReceipt,
  preparePackageChannelPolicy,
  removePreparedPackageChannelPolicy,
  rollbackPackagePolicyMutations,
  type PreparedPackageChannelPolicy,
} from "./package-policy";
import {
  addSandboxChannel,
  applyChannelPresetIfAvailable,
  removeChannelPresetIfPresent,
} from "../policy-channel";
import { policyChannelDependencies } from "../policy-channel-dependencies";
import * as policyContextRefresh from "../policy-context-refresh";

const commandAgentMocks = vi.hoisted(() => ({
  requireCurrentAuthority: vi.fn(),
}));

vi.mock("../../../sandbox/command-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../sandbox/command-agent")>()),
  requireCurrentSandboxCommandAgentAuthority: commandAgentMocks.requireCurrentAuthority,
}));

const sandboxName = "alpha";
const packageId = "future-harness";
let packageRoot: string;
let authority: SandboxCommandAgentAuthority;
let policyContext: policies.PolicyMutationContext;

function packageAgent(ownedPresets: readonly string[]): AgentDefinition {
  return {
    name: packageId,
    agentDir: packageRoot,
    packageRoot,
    policyCapability: {
      owned_presets: ownedPresets,
      automatic_presets: [],
      baseline_exclusion_impacts: {},
    },
  } as unknown as AgentDefinition;
}

function packageAuthority(agent: AgentDefinition): SandboxCommandAgentAuthority {
  const contentDigest = validateHarnessPackageTree(agent.packageRoot, {
    sourceTrust: "mutable",
  }).contentDigest;
  return Object.freeze({
    agent: packageId,
    harnessPackage: Object.freeze({
      kind: "agent-runtime" as const,
      id: packageId,
      packageVersion: "1.0.0",
      contentDigest,
    }),
    harnessPackageMigration: null,
    definition: agent,
  });
}

function policyValue(host: string): Record<string, unknown> {
  return {
    name: host,
    endpoints: [
      {
        host,
        port: 443,
        protocol: "rest",
        rules: [{ allow: { method: "GET", path: "/**" } }],
      },
    ],
  };
}

function writePackagePreset(name: string, networkPolicies: Record<string, unknown>): void {
  const directory = path.join(packageRoot, "policies", "presets");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, `${name}.yaml`),
    YAML.stringify({
      preset: { name, description: `${name} test policy` },
      network_policies: networkPolicies,
    }),
    { mode: 0o600 },
  );
}

function channelManifest(
  channelId: string,
  policyPresets: NonNullable<ChannelManifest["policyPresets"]>,
): ChannelManifest {
  return {
    schemaVersion: 1,
    id: channelId,
    displayName: channelId,
    supportedAgents: [packageId],
    auth: { mode: "none" },
    inputs: [],
    credentials: [],
    policyPresets,
    render: [],
    hooks: [],
  };
}

function messagingPlan(
  entries: readonly SandboxMessagingNetworkPolicyEntryPlan[],
): SandboxMessagingPlan {
  const channelIds = [...new Set(entries.map((entry) => entry.channelId))];
  return {
    schemaVersion: 1,
    sandboxName,
    agent: packageId,
    workflow: "rebuild",
    channels: channelIds.map((channelId) => ({
      channelId,
      displayName: channelId,
      authMode: "none",
      active: true,
      selected: true,
      configured: true,
      disabled: false,
      inputs: [],
      hooks: [],
    })),
    disabledChannels: [],
    credentialBindings: [],
    networkPolicy: {
      presets: [...new Set(entries.map((entry) => entry.presetName))],
      entries,
    },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

function contextWithPolicy(basePolicyDocument: string): policies.PolicyMutationContext {
  return {
    gatewayName: "test-gateway",
    inspection: {} as policies.PolicyMutationContext["inspection"],
    basePolicyDocument,
    agentAuthority: authority,
  };
}

function preparedPolicy(
  basePolicyDocument: string,
  entries: readonly SandboxMessagingNetworkPolicyEntryPlan[],
  contents: readonly string[],
): PreparedPackageChannelPolicy {
  return {
    authority,
    channelId: entries[0]?.channelId ?? "future-chat",
    context: contextWithPolicy(basePolicyDocument),
    includeCredentialBindings: true,
    retainedEntries: [],
    resolvedEntries: entries.map((entry, index) => ({
      entry,
      content: contents[index] ?? "",
    })),
  };
}

function resolvedContent(networkPolicies: Record<string, unknown>): string {
  return YAML.stringify({ network_policies: networkPolicies });
}

function microsoftPolicy(key: "teams" | "outlook_graph", binding?: string) {
  return {
    name: key,
    endpoints: [
      {
        host: "login.microsoftonline.com",
        port: 443,
        protocol: "rest",
        rules: [{ allow: { method: "POST", path: "/**" } }],
        ...(binding ? { credential_binding: { provider: binding } } : {}),
      },
    ],
  };
}

beforeEach(() => {
  packageRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-channel-policy-")));
  authority = packageAuthority(packageAgent([]));
  policyContext = contextWithPolicy("version: 1\nnetwork_policies: {}\n");
  commandAgentMocks.requireCurrentAuthority.mockReset();

  vi.spyOn(registry, "getSandbox").mockReturnValue({
    name: sandboxName,
    agent: packageId,
    harnessPackage: authority.harnessPackage ?? undefined,
  });
  vi.spyOn(registry, "getHydratedMessagingPlanFromEntry").mockReturnValue(null);
  vi.spyOn(registryRead, "getSandbox").mockImplementation((name) => registry.getSandbox(name));
  vi.spyOn(registryMessaging, "getHydratedMessagingPlanFromEntry").mockImplementation(
    (entry, options) => registry.getHydratedMessagingPlanFromEntry(entry, options),
  );
  vi.spyOn(policies, "inspectPolicyMutationContext").mockImplementation(() => policyContext);
  vi.spyOn(policies, "recheckPolicyMutationContext").mockImplementation(() => policyContext);
  vi.spyOn(policies, "getPresetContentGatewayState").mockReturnValue("absent");
  vi.spyOn(policies, "logPresetScopeForState").mockImplementation(() => undefined);
  vi.spyOn(policies, "setPolicyDocument").mockReturnValue(true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(packageRoot, { recursive: true, force: true });
});

describe("receipt-backed channel policy preparation", () => {
  it.each([
    { command: "add", workflow: "add-channel" as const, disclose: true },
    { command: "start", workflow: "start-channel" as const, disclose: true },
    { command: "stop", workflow: "stop-channel" as const, disclose: false },
    { command: "remove", workflow: "remove-channel" as const, disclose: false },
  ])(
    "compiles $command for an unknown package ID from preset names that differ from the channel ID",
    ({ workflow, disclose }) => {
      writePackagePreset("future-transport", {
        future_primary: policyValue("primary.example.com"),
        future_shared: policyValue("shared.example.com"),
      });
      writePackagePreset("future-extra", {
        future_extra: policyValue("extra.example.com"),
      });
      authority = packageAuthority(packageAgent(["future-transport", "future-extra"]));
      policyContext = contextWithPolicy("version: 1\nnetwork_policies: {}\n");
      const manifest = channelManifest("future-chat", [
        {
          name: "future-transport",
          policyKeys: ["future_primary", "future_shared"],
        },
        { name: "future-extra", policyKeys: ["future_extra"] },
      ]);

      const prepared = preparePackageChannelPolicy({
        allowedCredentialProviderNames: new Set(),
        authority,
        availableChannels: [manifest],
        channelId: "future-chat",
        disclose,
        includeCredentialBindings: true,
        sandboxName,
        workflow,
      });

      expect(prepared.resolvedEntries.map(({ entry }) => entry.presetName)).toEqual([
        "future-transport",
        "future-extra",
      ]);
      expect(prepared.resolvedEntries.flatMap(({ entry }) => entry.policyKeys)).toEqual([
        "future_primary",
        "future_shared",
        "future_extra",
      ]);
      expect(policies.logPresetScopeForState).toHaveBeenCalledTimes(disclose ? 2 : 0);
    },
  );

  it("never falls back to a legacy preset when the receipt-owned package asset is missing", () => {
    authority = packageAuthority(packageAgent(["future-transport"]));
    policyContext = contextWithPolicy("version: 1\nnetwork_policies: {}\n");
    const manifest = channelManifest("future-chat", [
      { name: "future-transport", policyKeys: ["future_primary"] },
    ]);
    const legacyLoad = vi
      .spyOn(policies, "loadPresetForSandbox")
      .mockReturnValue(resolvedContent({ future_primary: policyValue("legacy.example.com") }));

    expect(() =>
      preparePackageChannelPolicy({
        allowedCredentialProviderNames: new Set(),
        authority,
        availableChannels: [manifest],
        channelId: "future-chat",
        disclose: true,
        includeCredentialBindings: true,
        sandboxName,
        workflow: "add-channel",
      }),
    ).toThrow("package asset is unavailable");
    expect(legacyLoad).not.toHaveBeenCalled();
    expect(policies.logPresetScopeForState).not.toHaveBeenCalled();
    expect(policies.setPolicyDocument).not.toHaveBeenCalled();
  });

  it("rejects a package policy reached through a replaced parent directory", () => {
    const outsideRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-channel-policy-outside-")),
    );
    const agent = packageAgent(["future-transport"]);
    authority = packageAuthority(agent);
    policyContext = contextWithPolicy("version: 1\nnetwork_policies: {}\n");
    const outsidePresetDirectory = path.join(outsideRoot, "presets");
    fs.mkdirSync(outsidePresetDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(outsidePresetDirectory, "future-transport.yaml"),
      YAML.stringify({
        preset: { name: "future-transport", description: "Outside policy" },
        network_policies: { future_primary: policyValue("outside.example.com") },
      }),
      { mode: 0o600 },
    );
    fs.symlinkSync(outsideRoot, path.join(packageRoot, "policies"), "dir");
    const manifest = channelManifest("future-chat", [
      { name: "future-transport", policyKeys: ["future_primary"] },
    ]);

    try {
      expect(() =>
        preparePackageChannelPolicy({
          allowedCredentialProviderNames: new Set(),
          authority,
          availableChannels: [manifest],
          channelId: "future-chat",
          disclose: false,
          includeCredentialBindings: true,
          sandboxName,
          workflow: "add-channel",
        }),
      ).toThrow("policy tree failed integrity validation");
      expect(policies.setPolicyDocument).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("rejects policy bytes added after the package receipt was captured", () => {
    const agent = packageAgent(["future-transport"]);
    authority = packageAuthority(agent);
    writePackagePreset("future-transport", {
      future_primary: policyValue("changed.example.com"),
    });
    policyContext = contextWithPolicy("version: 1\nnetwork_policies: {}\n");
    const manifest = channelManifest("future-chat", [
      { name: "future-transport", policyKeys: ["future_primary"] },
    ]);

    expect(() =>
      preparePackageChannelPolicy({
        allowedCredentialProviderNames: new Set(),
        authority,
        availableChannels: [manifest],
        channelId: "future-chat",
        disclose: false,
        includeCredentialBindings: true,
        sandboxName,
        workflow: "add-channel",
      }),
    ).toThrow("policy tree does not match its installed receipt");
    expect(policies.setPolicyDocument).not.toHaveBeenCalled();
  });

  it("allows identical policy keys shared with another active channel", () => {
    writePackagePreset("future-target", {
      shared_transport: policyValue("shared.example.com"),
      target_only: policyValue("target.example.com"),
    });
    writePackagePreset("future-retained", {
      shared_transport: policyValue("shared.example.com"),
    });
    authority = packageAuthority(packageAgent(["future-target", "future-retained"]));
    policyContext = contextWithPolicy(
      resolvedContent({ shared_transport: policyValue("shared.example.com") }),
    );
    const targetManifest = channelManifest("future-chat", [
      { name: "future-target", policyKeys: ["shared_transport", "target_only"] },
    ]);
    const retainedManifest = channelManifest("other-chat", [
      { name: "future-retained", policyKeys: ["shared_transport"] },
    ]);
    vi.mocked(registry.getHydratedMessagingPlanFromEntry).mockReturnValue(
      messagingPlan([
        {
          channelId: "other-chat",
          presetName: "future-retained",
          policyKeys: ["shared_transport"],
          source: "manifest",
        },
      ]),
    );

    expect(() =>
      preparePackageChannelPolicy({
        allowedCredentialProviderNames: new Set(),
        authority,
        availableChannels: [targetManifest, retainedManifest],
        channelId: "future-chat",
        disclose: true,
        includeCredentialBindings: true,
        sandboxName,
        workflow: "add-channel",
      }),
    ).not.toThrow();
    expect(policies.logPresetScopeForState).toHaveBeenCalledTimes(1);
  });

  it("rejects conflicting policy keys shared with another active channel before disclosure or set", () => {
    writePackagePreset("future-target", {
      shared_transport: policyValue("target.example.com"),
    });
    writePackagePreset("future-retained", {
      shared_transport: policyValue("retained.example.com"),
    });
    authority = packageAuthority(packageAgent(["future-target", "future-retained"]));
    policyContext = contextWithPolicy("version: 1\nnetwork_policies: {}\n");
    const targetManifest = channelManifest("future-chat", [
      { name: "future-target", policyKeys: ["shared_transport"] },
    ]);
    const retainedManifest = channelManifest("other-chat", [
      { name: "future-retained", policyKeys: ["shared_transport"] },
    ]);
    vi.mocked(registry.getHydratedMessagingPlanFromEntry).mockReturnValue(
      messagingPlan([
        {
          channelId: "other-chat",
          presetName: "future-retained",
          policyKeys: ["shared_transport"],
          source: "manifest",
        },
      ]),
    );

    expect(() =>
      preparePackageChannelPolicy({
        allowedCredentialProviderNames: new Set(),
        authority,
        availableChannels: [targetManifest, retainedManifest],
        channelId: "future-chat",
        disclose: true,
        includeCredentialBindings: true,
        sandboxName,
        workflow: "add-channel",
      }),
    ).toThrow("policy key 'shared_transport' conflicts with another active channel");
    expect(policies.logPresetScopeForState).not.toHaveBeenCalled();
    expect(policies.setPolicyDocument).not.toHaveBeenCalled();
  });

  it("rejects a credential provider outside the typed channel plan before disclosure or set", () => {
    writePackagePreset("future-target", {
      future_primary: {
        ...policyValue("target.example.com"),
        endpoints: [
          {
            host: "target.example.com",
            port: 443,
            protocol: "rest",
            credential_binding: { provider: "foreign-provider" },
            rules: [{ allow: { method: "GET", path: "/**" } }],
          },
        ],
      },
    });
    authority = packageAuthority(packageAgent(["future-target"]));
    policyContext = contextWithPolicy("version: 1\nnetwork_policies: {}\n");
    const manifest = channelManifest("future-chat", [
      { name: "future-target", policyKeys: ["future_primary"] },
    ]);

    expect(() =>
      preparePackageChannelPolicy({
        allowedCredentialProviderNames: new Set([`${sandboxName}-future-chat-bridge`]),
        authority,
        availableChannels: [manifest],
        channelId: "future-chat",
        disclose: true,
        includeCredentialBindings: true,
        sandboxName,
        workflow: "add-channel",
      }),
    ).toThrow("credential provider outside its typed package plan");
    expect(policies.logPresetScopeForState).not.toHaveBeenCalled();
    expect(policies.setPolicyDocument).not.toHaveBeenCalled();
  });

  it("rejects terminal control characters in package provider names without rendering them", () => {
    writePackagePreset("future-target", {
      target_only: {
        ...policyValue("target.example.com"),
        endpoints: [
          {
            host: "target.example.com",
            port: 443,
            protocol: "rest",
            credential_binding: { provider: "foreign\u001b[2J" },
          },
        ],
      },
    });
    authority = packageAuthority(packageAgent(["future-target"]));
    policyContext = contextWithPolicy("version: 1\nnetwork_policies: {}\n");
    const manifest = channelManifest("future-chat", [
      { name: "future-target", policyKeys: ["target_only"] },
    ]);
    const renderedErrors: string[] = [];

    expect(() =>
      preparePackageChannelPolicy({
        allowedCredentialProviderNames: new Set(["future-chat-provider"]),
        authority,
        availableChannels: [manifest],
        channelId: "future-chat",
        disclose: false,
        includeCredentialBindings: true,
        sandboxName,
        workflow: "add-channel",
      }),
    ).toThrow("invalid credential provider name");
    renderedErrors.push(...vi.mocked(console.error).mock.calls.flat().map(String));
    expect(renderedErrors.join("\n")).not.toContain("\u001b");
    expect(policies.setPolicyDocument).not.toHaveBeenCalled();
  });

  it("rejects a same-named foreign live policy key before disclosure or set", () => {
    writePackagePreset("future-target", {
      future_primary: policyValue("target.example.com"),
    });
    authority = packageAuthority(packageAgent(["future-target"]));
    policyContext = contextWithPolicy(
      resolvedContent({ future_primary: policyValue("foreign.example.com") }),
    );
    const manifest = channelManifest("future-chat", [
      { name: "future-target", policyKeys: ["future_primary"] },
    ]);

    expect(() =>
      preparePackageChannelPolicy({
        allowedCredentialProviderNames: new Set(),
        authority,
        availableChannels: [manifest],
        channelId: "future-chat",
        disclose: true,
        includeCredentialBindings: true,
        sandboxName,
        workflow: "add-channel",
      }),
    ).toThrow("policy key 'future_primary' conflicts with live policy state");
    expect(policies.logPresetScopeForState).not.toHaveBeenCalled();
    expect(policies.setPolicyDocument).not.toHaveBeenCalled();
  });

  it("rejects an identical unowned live policy key before policy, provider, or registry mutation", () => {
    writePackagePreset("future-target", {
      future_primary: policyValue("target.example.com"),
    });
    authority = packageAuthority(packageAgent(["future-target"]));
    policyContext = contextWithPolicy(
      resolvedContent({ future_primary: policyValue("target.example.com") }),
    );
    const manifest = channelManifest("future-chat", [
      { name: "future-target", policyKeys: ["future_primary"] },
    ]);
    const providerUpsert = vi.spyOn(policyChannelDependencies, "upsertMessagingProviders");
    const registryUpdate = vi.spyOn(registry, "updateSandbox");
    const gatewayRecovery = vi.spyOn(gatewayRuntime, "recoverNamedGatewayRuntime");

    expect(() =>
      preparePackageChannelPolicy({
        allowedCredentialProviderNames: new Set(),
        authority,
        availableChannels: [manifest],
        channelId: "future-chat",
        disclose: true,
        includeCredentialBindings: true,
        sandboxName,
        workflow: "add-channel",
      }),
    ).toThrow("policy key 'future_primary' exists without active package plan authority");

    expect(policies.logPresetScopeForState).not.toHaveBeenCalled();
    expect(policies.setPolicyDocument).not.toHaveBeenCalled();
    expect(providerUpsert).not.toHaveBeenCalled();
    expect(gatewayRecovery).not.toHaveBeenCalled();
    expect(registryUpdate).not.toHaveBeenCalled();
  });
});

describe("receipt-backed channel policy mutation", () => {
  it("restores an ambiguously accepted policy submission with compare-and-set authority", () => {
    const entry: SandboxMessagingNetworkPolicyEntryPlan = {
      channelId: "future-chat",
      presetName: "future-target",
      policyKeys: ["target_only"],
      source: "manifest",
    };
    const original = resolvedContent({ baseline: policyValue("baseline.example.com") });
    const prepared = preparedPolicy(
      original,
      [entry],
      [resolvedContent({ target_only: policyValue("target.example.com") })],
    );
    let livePolicy = original;
    vi.mocked(policies.setPolicyDocument).mockImplementation((_sandbox, policy) => {
      livePolicy = policy;
      return false;
    });
    vi.mocked(policies.inspectPolicyMutationContext).mockImplementation(() => ({
      ...contextWithPolicy(livePolicy),
      basePolicyDocument: livePolicy,
    }));

    const mutation = applyPreparedPackageChannelPolicyWithReceipt(sandboxName, prepared);
    expect(mutation.accepted).toBe(false);
    vi.mocked(policies.setPolicyDocument).mockImplementation((_sandbox, policy) => {
      livePolicy = policy;
      return true;
    });

    expect(rollbackPackagePolicyMutations(sandboxName, [mutation.receipt])).toBe(true);
    expect(YAML.parse(livePolicy)).toEqual(YAML.parse(original));
  });

  it("fails package policy compensation when live state is neither pre-state nor expected state", () => {
    const entry: SandboxMessagingNetworkPolicyEntryPlan = {
      channelId: "future-chat",
      presetName: "future-target",
      policyKeys: ["target_only"],
      source: "manifest",
    };
    const prepared = preparedPolicy(
      resolvedContent({}),
      [entry],
      [resolvedContent({ target_only: policyValue("target.example.com") })],
    );
    const mutation = applyPreparedPackageChannelPolicyWithReceipt(sandboxName, prepared);
    vi.mocked(policies.setPolicyDocument).mockClear();
    vi.mocked(policies.inspectPolicyMutationContext).mockReturnValue(
      contextWithPolicy(resolvedContent({ foreign: policyValue("foreign.example.com") })),
    );

    expect(rollbackPackagePolicyMutations(sandboxName, [mutation.receipt])).toBe(false);
    expect(policies.setPolicyDocument).not.toHaveBeenCalled();
  });

  it("rolls back credential-free and bound policy mutations in reverse order", () => {
    const original = resolvedContent({ baseline: policyValue("baseline.example.com") });
    const credentialFree = resolvedContent({
      baseline: policyValue("baseline.example.com"),
      channel: policyValue("channel.example.com"),
    });
    const bound = resolvedContent({
      baseline: policyValue("baseline.example.com"),
      channel: {
        ...policyValue("channel.example.com"),
        credential_binding: { provider: "alpha-channel-bridge" },
      },
    });
    let livePolicy = bound;
    vi.mocked(policies.inspectPolicyMutationContext).mockImplementation(() =>
      contextWithPolicy(livePolicy),
    );
    vi.mocked(policies.setPolicyDocument).mockImplementation((_sandbox, policy) => {
      livePolicy = policy;
      return true;
    });

    expect(
      rollbackPackagePolicyMutations(sandboxName, [
        {
          authority,
          channelId: "future-chat",
          expectedPolicyDocument: credentialFree,
          previousPolicyDocument: original,
          submissionContext: contextWithPolicy(original),
        },
        {
          authority,
          channelId: "future-chat",
          expectedPolicyDocument: bound,
          previousPolicyDocument: credentialFree,
          submissionContext: contextWithPolicy(credentialFree),
        },
      ]),
    ).toBe(true);
    expect(vi.mocked(policies.setPolicyDocument).mock.calls.map((call) => call[1])).toEqual([
      credentialFree,
      original,
    ]);
    expect(YAML.parse(livePolicy)).toEqual(YAML.parse(original));
  });

  it("reports a residual without mutation when package authority drifts before compensation", () => {
    const policy = resolvedContent({ baseline: policyValue("baseline.example.com") });
    commandAgentMocks.requireCurrentAuthority.mockImplementation(() => {
      throw new Error("captured package authority changed");
    });

    expect(
      rollbackPackagePolicyMutations(sandboxName, [
        {
          authority,
          channelId: "future-chat",
          expectedPolicyDocument: resolvedContent({ target: policyValue("target.example.com") }),
          previousPolicyDocument: policy,
          submissionContext: contextWithPolicy(policy),
        },
      ]),
    ).toBe(false);
    expect(policies.setPolicyDocument).not.toHaveBeenCalled();
  });

  it.each([
    { includeCredentialBindings: false, expectedBinding: undefined },
    { includeCredentialBindings: true, expectedBinding: `${sandboxName}-teams-bridge` },
  ])(
    "reconciles Outlook once when applying Teams with credential bindings=$includeCredentialBindings",
    ({ includeCredentialBindings, expectedBinding }) => {
      const entry: SandboxMessagingNetworkPolicyEntryPlan = {
        channelId: "teams",
        presetName: "teams-policy",
        policyKeys: ["teams"],
        source: "manifest",
      };
      const prepared = {
        ...preparedPolicy(
          resolvedContent({ outlook_graph: microsoftPolicy("outlook_graph") }),
          [entry],
          [
            resolvedContent({
              teams: microsoftPolicy(
                "teams",
                includeCredentialBindings ? `${sandboxName}-teams-bridge` : undefined,
              ),
            }),
          ],
        ),
        credentialPolicyReconciliation: "teams-outlook-shared-login" as const,
        includeCredentialBindings,
      };

      expect(applyPreparedPackageChannelPolicy(sandboxName, prepared)).toBe(true);
      const desired = YAML.parse(vi.mocked(policies.setPolicyDocument).mock.calls[0]?.[1] ?? "");
      expect(desired.network_policies.outlook_graph.endpoints[0].credential_binding?.provider).toBe(
        expectedBinding,
      );
    },
  );

  it("restores unbound Outlook when Teams is removed", () => {
    const entry: SandboxMessagingNetworkPolicyEntryPlan = {
      channelId: "teams",
      presetName: "teams-policy",
      policyKeys: ["teams"],
      source: "manifest",
    };
    const retained: SandboxMessagingNetworkPolicyEntryPlan = {
      channelId: "outlook",
      presetName: "outlook-policy",
      policyKeys: ["outlook_graph"],
      source: "manifest",
    };
    const prepared = {
      ...preparedPolicy(
        resolvedContent({
          teams: microsoftPolicy("teams", `${sandboxName}-teams-bridge`),
          outlook_graph: microsoftPolicy("outlook_graph", `${sandboxName}-teams-bridge`),
        }),
        [entry],
        [resolvedContent({ teams: microsoftPolicy("teams") })],
      ),
      credentialPolicyReconciliation: "teams-outlook-shared-login" as const,
      retainedEntries: [retained],
    };

    expect(removePreparedPackageChannelPolicy(sandboxName, prepared, [retained])).toBe(true);
    const desired = YAML.parse(vi.mocked(policies.setPolicyDocument).mock.calls[0]?.[1] ?? "");
    expect(desired.network_policies.outlook_graph.endpoints[0]).not.toHaveProperty(
      "credential_binding",
    );
  });

  it("fails closed when Outlook has a foreign credential binding", () => {
    const entry: SandboxMessagingNetworkPolicyEntryPlan = {
      channelId: "teams",
      presetName: "teams-policy",
      policyKeys: ["teams"],
      source: "manifest",
    };
    const prepared = {
      ...preparedPolicy(
        resolvedContent({ outlook_graph: microsoftPolicy("outlook_graph", "foreign-provider") }),
        [entry],
        [resolvedContent({ teams: microsoftPolicy("teams", `${sandboxName}-teams-bridge`) })],
      ),
      credentialPolicyReconciliation: "teams-outlook-shared-login" as const,
    };

    expect(applyPreparedPackageChannelPolicy(sandboxName, prepared)).toBe(false);
    expect(policies.setPolicyDocument).not.toHaveBeenCalled();
  });

  it("applies multiple compiled presets in one policy-set mutation", () => {
    const entries: readonly SandboxMessagingNetworkPolicyEntryPlan[] = [
      {
        channelId: "future-chat",
        presetName: "future-transport",
        policyKeys: ["future_primary"],
        source: "manifest",
      },
      {
        channelId: "future-chat",
        presetName: "future-extra",
        policyKeys: ["future_extra"],
        source: "manifest",
      },
    ];
    const prepared = preparedPolicy(
      resolvedContent({ baseline: policyValue("baseline.example.com") }),
      entries,
      [
        resolvedContent({ future_primary: policyValue("primary.example.com") }),
        resolvedContent({ future_extra: policyValue("extra.example.com") }),
      ],
    );

    expect(applyPreparedPackageChannelPolicy(sandboxName, prepared)).toBe(true);

    expect(policies.setPolicyDocument).toHaveBeenCalledTimes(1);
    const desiredPolicy = YAML.parse(
      vi.mocked(policies.setPolicyDocument).mock.calls[0]?.[1] ?? "",
    ).network_policies;
    expect(Object.keys(desiredPolicy)).toEqual(["baseline", "future_primary", "future_extra"]);
    expect(policies.setPolicyDocument).toHaveBeenCalledWith(
      sandboxName,
      expect.any(String),
      expect.objectContaining({ context: prepared.context }),
    );
  });

  it("retains a shared key required by another active channel during atomic removal", () => {
    const targetEntry: SandboxMessagingNetworkPolicyEntryPlan = {
      channelId: "future-chat",
      presetName: "future-target",
      policyKeys: ["shared_transport", "target_only"],
      source: "manifest",
    };
    const retainedEntry: SandboxMessagingNetworkPolicyEntryPlan = {
      channelId: "other-chat",
      presetName: "future-retained",
      policyKeys: ["shared_transport"],
      source: "manifest",
    };
    const basePolicy = resolvedContent({
      shared_transport: policyValue("shared.example.com"),
      target_only: policyValue("target.example.com"),
      unrelated: policyValue("unrelated.example.com"),
    });
    const prepared = preparedPolicy(
      basePolicy,
      [targetEntry],
      [
        resolvedContent({
          shared_transport: policyValue("shared.example.com"),
          target_only: policyValue("target.example.com"),
        }),
      ],
    );

    expect(removePreparedPackageChannelPolicy(sandboxName, prepared, [retainedEntry])).toBe(true);

    expect(policies.setPolicyDocument).toHaveBeenCalledTimes(1);
    const desiredPolicy = YAML.parse(
      vi.mocked(policies.setPolicyDocument).mock.calls[0]?.[1] ?? "",
    ).network_policies;
    expect(desiredPolicy).toHaveProperty("shared_transport");
    expect(desiredPolicy).not.toHaveProperty("target_only");
    expect(desiredPolicy).toHaveProperty("unrelated");
  });

  it("fails closed on malformed live policy instead of treating removal as a no-op", () => {
    const entry: SandboxMessagingNetworkPolicyEntryPlan = {
      channelId: "future-chat",
      presetName: "future-target",
      policyKeys: ["target_only"],
      source: "manifest",
    };
    const prepared = preparedPolicy(
      "network_policies: [unterminated",
      [entry],
      [resolvedContent({ target_only: policyValue("target.example.com") })],
    );

    expect(() => removePreparedPackageChannelPolicy(sandboxName, prepared, [])).toThrow(
      "live policy is invalid YAML",
    );
    expect(policies.setPolicyDocument).not.toHaveBeenCalled();
  });

  it("fails receipt drift before an idempotent apply can be accepted", () => {
    const entry: SandboxMessagingNetworkPolicyEntryPlan = {
      channelId: "future-chat",
      presetName: "future-target",
      policyKeys: ["target_only"],
      source: "manifest",
    };
    const entryContent = resolvedContent({
      target_only: policyValue("target.example.com"),
    });
    const matchingPolicy = YAML.stringify({
      version: 1,
      network_policies: {
        target_only: policyValue("target.example.com"),
      },
    });
    const prepared = preparedPolicy(matchingPolicy, [entry], [entryContent]);
    commandAgentMocks.requireCurrentAuthority.mockImplementation(() => {
      throw new Error("Sandbox command agent authority changed before mutation");
    });

    expect(() => applyPreparedPackageChannelPolicy(sandboxName, prepared)).toThrow(
      "authority changed before mutation",
    );
    expect(policies.setPolicyDocument).not.toHaveBeenCalled();
  });
});

describe("receipt-backed add rollback", () => {
  it("refuses legacy fallback when a package rollback has no prepared policy", () => {
    const legacyPresetApply = vi.spyOn(policies, "applyPreset");

    expect(applyChannelPresetIfAvailable(sandboxName, "telegram", "add")).toBe(false);

    expect(legacyPresetApply).not.toHaveBeenCalled();
  });

  it(
    "rejects a foreign policy provider before provider, policy, or registry mutation",
    { timeout: 15_000 },
    async () => {
      const fixtureParent = path.join(
        process.cwd(),
        "node_modules/.cache/nemoclaw-channel-policy-provider-authority",
      );
      fs.mkdirSync(fixtureParent, { recursive: true, mode: 0o700 });
      const home = fs.mkdtempSync(path.join(fixtureParent, "home-"));
      const fixture = createHarnessPackageFixture({
        fixtureParent: path.join(home, "fixture"),
        storeRoot: path.join(home, ".nemoclaw", "harnesses"),
        messaging: { packageId: "openclaw", channelIds: ["telegram"] },
      });
      try {
        const openclawRoot = fixture.packageRoots.get("openclaw");
        expect(openclawRoot).toBeDefined();
        const manifestPath = path.join(openclawRoot!, "manifest.yaml");
        fs.writeFileSync(
          manifestPath,
          fs
            .readFileSync(manifestPath, "utf8")
            .replace("  owned_presets: []", "  owned_presets:\n    - telegram"),
          { mode: 0o600 },
        );
        const presetDirectory = path.join(openclawRoot!, "policies", "presets");
        fs.mkdirSync(presetDirectory, { recursive: true });
        fs.writeFileSync(
          path.join(presetDirectory, "telegram.yaml"),
          YAML.stringify({
            preset: { name: "telegram", description: "Telegram test policy" },
            network_policies: {
              telegram_bot: {
                name: "telegram_bot",
                endpoints: [
                  {
                    host: "api.telegram.org",
                    port: 443,
                    protocol: "rest",
                    credential_binding: { provider: "foreign-provider" },
                    rules: [{ allow: { method: "GET", path: "/**" } }],
                  },
                ],
              },
            },
          }),
          { mode: 0o600 },
        );
        const installed = fixture.install("openclaw");
        vi.stubEnv("HOME", home);
        const entry: registry.SandboxEntry = {
          name: sandboxName,
          agent: "openclaw",
          harnessPackage: installed.identity,
          messaging: {
            schemaVersion: 1,
            plan: makeMessagingPlan({ sandboxName, channels: [], agent: "openclaw" }),
          },
        };
        vi.mocked(registry.getSandbox).mockReturnValue(entry);
        authority = captureSandboxCommandAgentAuthority(entry);
        policyContext = contextWithPolicy("version: 1\nnetwork_policies: {}\n");
        const providerUpsert = vi.spyOn(policyChannelDependencies, "upsertMessagingProviders");
        const registryUpdate = vi.spyOn(registry, "updateSandbox");
        const gatewayRecovery = vi.spyOn(gatewayRuntime, "recoverNamedGatewayRuntime");
        vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
          throw new Error(`process.exit(${code ?? 0})`);
        }) as never);

        await expect(addSandboxChannel(sandboxName, { channel: "telegram" })).rejects.toThrow(
          "process.exit(1)",
        );

        expect(providerUpsert).not.toHaveBeenCalled();
        expect(gatewayRecovery).not.toHaveBeenCalled();
        expect(policies.setPolicyDocument).not.toHaveBeenCalled();
        expect(registryUpdate).not.toHaveBeenCalled();
      } finally {
        fixture.cleanup();
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it.each(["disappeared", "replaced"])(
    "uses captured package authority when the current receipt has %s",
    () => {
      const entry: SandboxMessagingNetworkPolicyEntryPlan = {
        channelId: "future-chat",
        presetName: "future-target",
        policyKeys: ["target_only"],
        source: "manifest",
      };
      const prepared = preparedPolicy(
        resolvedContent({ target_only: policyValue("target.example.com") }),
        [entry],
        [resolvedContent({ target_only: policyValue("target.example.com") })],
      );
      commandAgentMocks.requireCurrentAuthority.mockImplementation(() => {
        throw new Error("captured package authority changed");
      });
      const legacyRemove = vi.spyOn(policies, "removePreset");

      expect(
        removeChannelPresetIfPresent(sandboxName, "future-chat", { packagePolicy: prepared }),
      ).toBe(false);
      expect(legacyRemove).not.toHaveBeenCalled();
      expect(policies.setPolicyDocument).not.toHaveBeenCalled();
    },
  );

  it(
    "restores package policy through exact receipt authority without legacy fallback",
    { timeout: 15_000 },
    async () => {
      const fixtureParent = path.join(
        process.cwd(),
        "node_modules/.cache/nemoclaw-channel-policy-rollback",
      );
      fs.mkdirSync(fixtureParent, { recursive: true, mode: 0o700 });
      const home = fs.mkdtempSync(path.join(fixtureParent, "home-"));
      const fixture = createHarnessPackageFixture({
        fixtureParent: path.join(home, "fixture"),
        storeRoot: path.join(home, ".nemoclaw", "harnesses"),
        messaging: { packageId: "openclaw", channelIds: ["telegram"] },
      });
      try {
        const openclawRoot = fixture.packageRoots.get("openclaw");
        expect(openclawRoot).toBeDefined();
        const manifestPath = path.join(openclawRoot!, "manifest.yaml");
        fs.writeFileSync(
          manifestPath,
          fs
            .readFileSync(manifestPath, "utf8")
            .replace("  owned_presets: []", "  owned_presets:\n    - telegram"),
          { mode: 0o600 },
        );
        const presetDirectory = path.join(openclawRoot!, "policies", "presets");
        fs.mkdirSync(presetDirectory, { recursive: true });
        fs.writeFileSync(
          path.join(presetDirectory, "telegram.yaml"),
          YAML.stringify({
            preset: { name: "telegram", description: "Telegram test policy" },
            network_policies: {
              telegram_bot: policyValue("api.telegram.org"),
            },
          }),
          { mode: 0o600 },
        );
        const installed = fixture.install("openclaw");
        vi.stubEnv("HOME", home);
        vi.stubEnv("NEMOCLAW_NON_INTERACTIVE", "1");
        vi.stubEnv("NEMOCLAW_SKIP_TELEGRAM_REACHABILITY", "1");
        vi.stubEnv("TELEGRAM_BOT_TOKEN", "prior-telegram-token");

        const priorPlan = makeMessagingPlan({
          sandboxName,
          channels: ["telegram"],
          agent: "openclaw",
          providerReceipts: [
            {
              channelId: "telegram",
              providerName: `${sandboxName}-telegram-bridge`,
              providerId: "provider-telegram-original",
              createdByNemoClaw: true,
              attachmentAddedByNemoClaw: true,
            },
          ],
        });
        const entry: registry.SandboxEntry = {
          name: sandboxName,
          agent: "openclaw",
          gatewayName: "nemoclaw",
          harnessPackage: installed.identity,
          lifecycleGeneration: "generation-1",
          lifecycleLiveIdentityFingerprint: "f".repeat(64),
          messaging: { schemaVersion: 1, plan: priorPlan },
        };
        vi.mocked(registry.getSandbox).mockReturnValue(entry);
        vi.mocked(registry.getHydratedMessagingPlanFromEntry).mockReturnValue(priorPlan);
        vi.spyOn(registry, "listSandboxes").mockReturnValue({
          sandboxes: [entry],
          defaultSandbox: sandboxName,
        });
        vi.spyOn(registry, "updateSandbox").mockReturnValue(true);

        authority = captureSandboxCommandAgentAuthority(entry);
        policyContext = contextWithPolicy("version: 1\nnetwork_policies: {}\n");
        vi.mocked(policies.setPolicyDocument)
          .mockReset()
          .mockImplementationOnce((_sandbox, desiredPolicy) => {
            policyContext = contextWithPolicy(desiredPolicy);
            return false;
          })
          .mockImplementationOnce(() => true);
        const legacyPresetLoad = vi.spyOn(policies, "loadPresetForSandbox");
        const legacyPresetApply = vi.spyOn(policies, "applyPreset");
        vi.spyOn(policies, "getAppliedPresets").mockReturnValue([]);
        vi.spyOn(credentialStore, "getCredential").mockImplementation(
          (key) => process.env[key] ?? null,
        );
        vi.spyOn(credentialStore, "saveCredential").mockImplementation(() => undefined);
        vi.spyOn(credentialStore, "deleteCredential").mockReturnValue(true);
        vi.spyOn(policyContextRefresh, "refreshSandboxPolicyContextFile").mockReturnValue({
          outcome: "ok",
          written: true,
        });
        vi.spyOn(policyChannelDependencies, "revalidateChannelProviderPolicy").mockImplementation(
          () => undefined,
        );
        vi.spyOn(
          policyChannelDependencies,
          "inspectMessagingProviderAttachmentTarget",
        ).mockReturnValue("f".repeat(64));
        const providerUpsert = vi
          .spyOn(policyChannelDependencies, "upsertMessagingProviders")
          .mockImplementation((_definitions, _gatewayName, options) => {
            options?.recordMutationReceipt?.({
              createdProviderNames: [],
              mutatedProviderNames: [],
              providerNames: [],
              providerIds: {},
            });
            return [];
          });
        vi.spyOn(policyChannelDependencies, "inspectMessagingProviderAttachments").mockReturnValue(
          [],
        );
        vi.spyOn(gatewayRuntime, "recoverNamedGatewayRuntime").mockResolvedValue({
          recovered: true,
          attempted: false,
          before: {
            state: "healthy_named",
            status: "",
            gatewayInfo: "",
            activeGateway: "nemoclaw",
          },
          after: {
            state: "healthy_named",
            status: "",
            gatewayInfo: "",
            activeGateway: "nemoclaw",
          },
        });
        const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
          throw new Error(`process.exit(${code ?? 0})`);
        }) as never);

        await expect(addSandboxChannel(sandboxName, { channel: "telegram" })).rejects.toThrow(
          "process.exit(1)",
        );

        expect(exit).toHaveBeenCalledWith(1);
        expect(policies.setPolicyDocument).toHaveBeenCalledTimes(2);
        expect(providerUpsert).toHaveBeenCalledTimes(2);
        expect(providerUpsert.mock.calls[1]?.[0]).toEqual([
          expect.objectContaining({
            name: `${sandboxName}-telegram-bridge`,
            expectedProviderId: "provider-telegram-original",
          }),
        ]);
        expect(providerUpsert.mock.calls[1]?.[2]).toEqual(
          expect.objectContaining({
            requireExistingProvider: true,
            requireOwnedExistingProvider: true,
          }),
        );
        expect(legacyPresetLoad).not.toHaveBeenCalled();
        expect(legacyPresetApply).not.toHaveBeenCalled();
        const restoredPolicy = YAML.parse(
          vi.mocked(policies.setPolicyDocument).mock.calls[1]?.[1] ?? "",
        ).network_policies;
        expect(restoredPolicy).toEqual({});
      } finally {
        fixture.cleanup();
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );
});
