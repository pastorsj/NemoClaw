// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { makeAgent } from "../../../../test/helpers/base-image-test-harness";
import type { AgentDefinition } from "../../agent/defs";
import { validateHarnessPackageTree } from "../../agent-runtime/package/tree";
import type { HarnessPackageIdentity } from "../../agent-runtime/package/types";
import {
  compactSandboxMessagingPlanForPersistence,
  createBuiltInChannelManifestRegistry,
  createBuiltInMessagingHookRegistry,
  createBuiltInRenderTemplateResolver,
  loadMessagingChannelPolicyPreset,
  MessagingWorkflowPlanner,
  type SandboxMessagingPlan,
} from "../../messaging";
import type { Session } from "../../state/onboard-session";
import {
  getMessagingChannelConfigFromPlan,
  getStoredMessagingChannelConfig,
} from "../messaging-config";

import {
  bindRebuildPolicyProvidersToCreateArgs,
  resolveRebuildMessagingPolicyDeltas,
  resolveRebuildObservabilityPolicyDelta,
  resolveRebuildPolicyProviderAuthority,
  selectRebuildCreatePolicy,
} from "./orchestration";

const tempRoots: string[] = [];

function tempPolicy(source: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wechat-rebuild-policy-test-"));
  tempRoots.push(root);
  const policyPath = path.join(root, "policy.yaml");
  fs.writeFileSync(policyPath, source, { mode: 0o600 });
  return policyPath;
}

function packagePolicyAgent(
  presetName: string,
  source: string | null,
  options: {
    readonly agentName?: string;
    readonly automaticObservability?: boolean;
    readonly owned?: boolean;
  } = {},
): AgentDefinition {
  const agentDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-package-policy-test-")),
  );
  tempRoots.push(agentDir);
  const presetDirectory = path.join(agentDir, "policies", "presets");
  fs.mkdirSync(presetDirectory, { recursive: true });
  switch (source) {
    case null:
      break;
    default:
      fs.writeFileSync(path.join(presetDirectory, `${presetName}.yaml`), source, { mode: 0o600 });
  }
  return makeAgent({
    name: options.agentName ?? "future-harness",
    agentDir,
    packageRoot: agentDir,
    policyCapability: {
      owned_presets: options.owned === false ? [] : [presetName],
      automatic_presets: options.automaticObservability
        ? [
            {
              name: presetName,
              activation: { kind: "observability-enabled" },
              apply_during_create: true,
              suppress_in_tiers: ["restricted"],
            },
          ]
        : [],
      baseline_exclusion_impacts: {},
    },
  });
}

function packagePolicyIdentity(agent: AgentDefinition): HarnessPackageIdentity {
  return {
    kind: "agent-runtime",
    id: agent.name,
    packageVersion: "1.0.0",
    contentDigest: validateHarnessPackageTree(agent.packageRoot, {
      sourceTrust: "mutable",
    }).contentDigest,
  };
}

function expectSelectedPolicyKeyRemoved(
  select: () => ReturnType<typeof selectRebuildCreatePolicy>,
  policyKey: string,
): void {
  const rebuilt = select();
  try {
    expect(
      YAML.parse(rebuilt.sourceBytes?.toString("utf8") ?? "").network_policies,
    ).not.toHaveProperty(policyKey);
  } finally {
    rebuilt.cleanup?.();
  }
}

function expectPolicySelectionRejected(
  select: () => ReturnType<typeof selectRebuildCreatePolicy>,
  livePolicyPath: string,
  errorMessage: string,
  preservedSource: string,
): void {
  expect(select).toThrow(errorMessage);
  expect(fs.readFileSync(livePolicyPath, "utf8")).toContain(preservedSource);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("rebuild policy provider handoff", () => {
  const preservedMcpState = {
    bridges: {
      github: {
        server: "github",
        agent: "openclaw",
        url: "https://mcp.example.com/",
        env: ["MCP_TOKEN"],
        providerName: "alpha-mcp-github",
        providerId: "provider-id",
        policyName: "mcp_github",
        addedAt: "2026-08-30T00:00:00.000Z",
      },
    },
  };

  it("derives legacy active additions and disabled removals from current channel manifests", () => {
    expect(
      resolveRebuildMessagingPolicyDeltas(
        {
          agent: "hermes",
          disabledChannels: ["telegram", "googlechat"],
          networkPolicy: {
            presets: ["wechat"],
            entries: [
              {
                channelId: "telegram",
                presetName: "telegram",
                policyKeys: ["telegram"],
                source: "agent-alias",
              },
              {
                channelId: "wechat",
                presetName: "wechat",
                policyKeys: ["wechat_bridge"],
                source: "manifest",
              },
            ],
          },
        },
        { agent: "hermes" },
      ),
    ).toEqual({
      requiredNetworkPolicyKeys: ["wechat_bridge"],
      requiredNetworkPolicyEntries: [
        {
          channelId: "wechat",
          presetName: "wechat",
          policyKeys: ["wechat_bridge"],
          source: "manifest",
        },
      ],
      requiredNetworkPolicyPresetNames: ["wechat"],
      removedNetworkPolicyKeys: ["telegram", "googlechat_hermes"],
      removedNetworkPolicyEntries: [
        {
          channelId: "telegram",
          presetName: "telegram",
          policyKeys: ["telegram"],
          source: "agent-alias",
        },
      ],
    });
  });

  it("does not infer a receipt package's disabled policy key without a typed entry", () => {
    expect(
      resolveRebuildMessagingPolicyDeltas({
        agent: "future-harness",
        disabledChannels: ["discord"],
        networkPolicy: { presets: [], entries: [] },
      }),
    ).toEqual({
      requiredNetworkPolicyKeys: [],
      requiredNetworkPolicyEntries: [],
      requiredNetworkPolicyPresetNames: [],
      removedNetworkPolicyKeys: [],
      removedNetworkPolicyEntries: [],
    });
  });

  it("uses a package plan's typed entries for an unknown agent's disabled policy keys", () => {
    expect(
      resolveRebuildMessagingPolicyDeltas({
        agent: "future-harness",
        disabledChannels: ["discord"],
        networkPolicy: {
          presets: ["future-channel-egress"],
          entries: [
            {
              channelId: "discord",
              presetName: "future-channel-egress",
              policyKeys: ["future_transport"],
              source: "manifest",
            },
          ],
        },
      }),
    ).toEqual({
      requiredNetworkPolicyKeys: [],
      requiredNetworkPolicyEntries: [],
      requiredNetworkPolicyPresetNames: [],
      removedNetworkPolicyKeys: ["future_transport"],
      removedNetworkPolicyEntries: [
        {
          channelId: "discord",
          presetName: "future-channel-egress",
          policyKeys: ["future_transport"],
          source: "manifest",
        },
      ],
    });
  });

  it("does not remove a disabled channel's policy key when an active channel still requires it", () => {
    expect(
      resolveRebuildMessagingPolicyDeltas({
        agent: "future-harness",
        disabledChannels: ["discord"],
        networkPolicy: {
          presets: ["future-discord-egress", "future-telegram-egress"],
          entries: [
            {
              channelId: "discord",
              presetName: "future-discord-egress",
              policyKeys: ["future_transport"],
              source: "manifest",
            },
            {
              channelId: "telegram",
              presetName: "future-telegram-egress",
              policyKeys: ["future_transport"],
              source: "manifest",
            },
          ],
        },
      }),
    ).toEqual({
      requiredNetworkPolicyKeys: ["future_transport"],
      requiredNetworkPolicyEntries: [
        {
          channelId: "telegram",
          presetName: "future-telegram-egress",
          policyKeys: ["future_transport"],
          source: "manifest",
        },
      ],
      requiredNetworkPolicyPresetNames: ["future-telegram-egress"],
      removedNetworkPolicyKeys: [],
      removedNetworkPolicyEntries: [],
    });
  });

  it.each([
    { name: "active", active: true, disabledChannels: [] as string[] },
    { name: "disabled", active: false, disabledChannels: ["teams"] },
  ])(
    "threads package-declared Teams reconciliation for a $name channel with a custom policy key",
    (testCase) => {
      const presetName = "future-collaboration-egress";
      const packageSource = `preset:
  name: ${presetName}
  description: Future collaboration access
network_policies:
  future_collaboration:
    endpoints:
      - host: login.microsoftonline.com
        port: 443
        credential_binding: {provider: alpha-teams-bridge}
`;
      const agentDefinition = packagePolicyAgent(presetName, packageSource);
      const liveTeamsPolicy = testCase.active
        ? ""
        : `
  future_collaboration:
    endpoints:
      - host: login.microsoftonline.com
        port: 443
        credential_binding: {provider: alpha-teams-bridge}`;
      const liveOutlookBinding = testCase.active
        ? ""
        : "\n        credential_binding: {provider: alpha-teams-bridge}";
      const livePolicyPath = tempPolicy(`version: 1
network_policies:
  outlook_graph:
    endpoints:
      - host: login.microsoftonline.com
        port: 443${liveOutlookBinding}${liveTeamsPolicy}
`);
      const plan = {
        schemaVersion: 1,
        sandboxName: "alpha",
        agent: agentDefinition.name,
        workflow: "rebuild",
        channels: [
          {
            channelId: "teams",
            displayName: "Teams",
            authMode: "token-paste",
            active: testCase.active,
            selected: true,
            configured: true,
            disabled: !testCase.active,
            inputs: [],
            hooks: [],
          },
        ],
        disabledChannels: testCase.disabledChannels,
        credentialBindings: [],
        networkPolicy: {
          presets: [presetName],
          entries: [
            {
              channelId: "teams",
              presetName,
              policyKeys: ["future_collaboration"],
              source: "manifest" as const,
            },
          ],
        },
        agentRender: [],
        buildSteps: [],
        stateUpdates: [],
        healthChecks: [],
        packageBuild: {
          configRoot: "~/.future-harness",
          packageManagers: [],
          credentialPolicyReconciliation: "teams-outlook-shared-login" as const,
        },
      } satisfies SandboxMessagingPlan;
      const deltas = resolveRebuildMessagingPolicyDeltas(plan);

      expect(deltas.credentialPolicyReconciliation).toEqual({
        mode: "teams-outlook-shared-login",
        teamsChannelState: testCase.active ? "active" : "removed",
      });
      const rebuilt = selectRebuildCreatePolicy({
        policySourcePath: livePolicyPath,
        generatedPolicy: {
          policyPath: livePolicyPath,
          appliedPresets: [],
          credentialBindingProviders: ["alpha-teams-bridge"],
          sourceBytes: Buffer.from(`version: 1
network_policies:
  outlook_graph:
    endpoints:
      - host: login.microsoftonline.com
        port: 443
`),
        },
        requiredNetworkPolicyKeys: deltas.requiredNetworkPolicyKeys,
        removedNetworkPolicyKeys: deltas.removedNetworkPolicyKeys,
        requiredNetworkPolicyPresetNames: deltas.requiredNetworkPolicyPresetNames,
        requiredNetworkPolicyEntries: deltas.requiredNetworkPolicyEntries,
        removedNetworkPolicyEntries: deltas.removedNetworkPolicyEntries,
        packageAgentDefinition: agentDefinition,
        harnessPackageIdentity: packagePolicyIdentity(agentDefinition),
        messagingAgent: agentDefinition.name,
        messagingConfig: null,
        sandboxName: "alpha",
        authorizedCredentialBindingProviders: ["alpha-teams-bridge"],
        credentialPolicyReconciliation: deltas.credentialPolicyReconciliation,
      });

      try {
        const policies = YAML.parse(rebuilt.sourceBytes?.toString("utf8") ?? "").network_policies;
        expect(policies.outlook_graph.endpoints[0].credential_binding).toEqual(
          testCase.active ? { provider: "alpha-teams-bridge" } : undefined,
        );
        expect(Object.hasOwn(policies, "future_collaboration")).toBe(testCase.active);
      } finally {
        rebuilt.cleanup?.();
      }
    },
  );

  it("does not infer Teams reconciliation from a receipt package's literal policy key", () => {
    const agentDefinition = packagePolicyAgent("unused-package-policy", null, { owned: false });
    const livePolicyPath = tempPolicy(`version: 1
network_policies:
  teams:
    endpoints:
      - host: login.microsoftonline.com
        port: 443
        credential_binding: {provider: alpha-teams-bridge}
  outlook_graph:
    endpoints:
      - host: login.microsoftonline.com
        port: 443
        credential_binding: {provider: alpha-teams-bridge}
`);
    expect(() =>
      selectRebuildCreatePolicy({
        policySourcePath: livePolicyPath,
        generatedPolicy: {
          policyPath: livePolicyPath,
          appliedPresets: [],
          credentialBindingProviders: ["alpha-teams-bridge"],
          sourceBytes: Buffer.from("version: 1\nnetwork_policies: {}\n"),
        },
        requiredNetworkPolicyKeys: [],
        removedNetworkPolicyKeys: ["teams"],
        requiredNetworkPolicyPresetNames: [],
        requiredNetworkPolicyEntries: [],
        packageAgentDefinition: agentDefinition,
        harnessPackageIdentity: packagePolicyIdentity(agentDefinition),
        messagingAgent: agentDefinition.name,
        messagingConfig: null,
        sandboxName: "alpha",
        authorizedCredentialBindingProviders: ["alpha-teams-bridge"],
      }),
    ).toThrow("receipt-backed network policy removal lacks exact package authority");
    expect(fs.readFileSync(livePolicyPath, "utf8")).toContain("teams:");
  });

  it.each([
    {
      name: "credential-bound",
      includeBinding: true,
      host: "package.example.test",
      verifySelection: (
        select: () => ReturnType<typeof selectRebuildCreatePolicy>,
        _livePolicyPath: string,
      ) => expectSelectedPolicyKeyRemoved(select, "future_transport"),
    },
    {
      name: "credential-unbound",
      includeBinding: false,
      host: "package.example.test",
      verifySelection: (
        select: () => ReturnType<typeof selectRebuildCreatePolicy>,
        _livePolicyPath: string,
      ) => expectSelectedPolicyKeyRemoved(select, "future_transport"),
    },
    {
      name: "foreign collision",
      includeBinding: false,
      host: "foreign.example.test",
      verifySelection: (
        select: () => ReturnType<typeof selectRebuildCreatePolicy>,
        livePolicyPath: string,
      ) =>
        expectPolicySelectionRejected(
          select,
          livePolicyPath,
          "does not match package removal authority",
          "foreign.example.test",
        ),
    },
  ])("removes only an exact $name disabled package messaging policy", (testCase) => {
    const presetName = "future-channel-egress";
    const packagePolicyValue = {
      name: "future_transport",
      endpoints: [
        {
          host: "package.example.test",
          port: 443,
          credential_binding: { provider: "alpha-future-bridge" },
        },
      ],
    };
    const agentDefinition = packagePolicyAgent(
      presetName,
      YAML.stringify({
        preset: { name: presetName, description: "Future channel policy" },
        network_policies: { future_transport: packagePolicyValue },
      }),
    );
    const liveValue = {
      ...packagePolicyValue,
      endpoints: [
        {
          host: testCase.host,
          port: 443,
          ...(testCase.includeBinding
            ? { credential_binding: { provider: "alpha-future-bridge" } }
            : {}),
        },
      ],
    };
    const livePolicyPath = tempPolicy(
      YAML.stringify({ version: 1, network_policies: { future_transport: liveValue } }),
    );
    const deltas = resolveRebuildMessagingPolicyDeltas({
      agent: agentDefinition.name,
      disabledChannels: ["discord"],
      networkPolicy: {
        presets: [presetName],
        entries: [
          {
            channelId: "discord",
            presetName,
            policyKeys: ["future_transport"],
            source: "manifest",
          },
        ],
      },
    });
    const select = () =>
      selectRebuildCreatePolicy({
        policySourcePath: livePolicyPath,
        generatedPolicy: {
          policyPath: livePolicyPath,
          appliedPresets: [],
          credentialBindingProviders: ["alpha-future-bridge"],
          sourceBytes: Buffer.from("version: 1\nnetwork_policies: {}\n"),
        },
        requiredNetworkPolicyKeys: deltas.requiredNetworkPolicyKeys,
        removedNetworkPolicyKeys: deltas.removedNetworkPolicyKeys,
        requiredNetworkPolicyPresetNames: deltas.requiredNetworkPolicyPresetNames,
        requiredNetworkPolicyEntries: deltas.requiredNetworkPolicyEntries,
        removedNetworkPolicyEntries: deltas.removedNetworkPolicyEntries,
        packageAgentDefinition: agentDefinition,
        harnessPackageIdentity: packagePolicyIdentity(agentDefinition),
        messagingAgent: agentDefinition.name,
        messagingConfig: null,
        sandboxName: "alpha",
        authorizedCredentialBindingProviders: ["alpha-future-bridge"],
      });

    testCase.verifySelection(select, livePolicyPath);
  });

  it.each(["openclaw", "hermes"] as const)(
    "preserves the QR-captured exact WeChat IDC endpoint through %s persistence and rebuild (#10606)",
    async (agent) => {
      const sandboxName = `rebuild-${agent}`;
      const legacyWechatPolicy = loadMessagingChannelPolicyPreset("wechat", {
        agent,
        sandboxName,
      });
      assert(legacyWechatPolicy);
      const packageAgentDefinition = packagePolicyAgent(
        "wechat",
        fs.readFileSync(
          path.join(process.cwd(), "packages", `nemoclaw-${agent}`, "policies/presets/wechat.yaml"),
          "utf8",
        ),
        { agentName: agent },
      );
      const livePolicyPath = tempPolicy(legacyWechatPolicy);
      const planner = new MessagingWorkflowPlanner(
        createBuiltInChannelManifestRegistry(),
        createBuiltInMessagingHookRegistry({
          common: {
            env: {},
            getCredential: () => null,
            saveCredential: () => {},
            prompt: async () => "unused",
            log: () => {},
          },
          wechat: {
            ilinkLogin: {
              env: {},
              saveCredential: () => {},
              log: () => {},
              runLogin: async () => ({
                kind: "ok",
                credentials: {
                  token: "test-wechat-token",
                  accountId: "test-wechat-account",
                  baseUrl: "https://idc-37.weixin.qq.com",
                  userId: "test-wechat-user",
                },
              }),
            },
            seedOpenClawAccount: { now: () => "2026-08-31T00:00:00.000Z" },
          },
        }),
        createBuiltInRenderTemplateResolver(),
      );
      const enrolled = await planner.buildPlan({
        sandboxName,
        agent,
        workflow: "onboard",
        isInteractive: true,
        configuredChannels: ["wechat"],
      });
      const persisted = compactSandboxMessagingPlanForPersistence(enrolled);
      const persistedBaseUrl = persisted.channels[0]?.inputs?.find(
        ({ inputId }) => inputId === "baseUrl",
      );

      expect(persistedBaseUrl?.value).toBe("https://idc-37.weixin.qq.com");
      expect(persisted).not.toHaveProperty("networkPolicy");

      const messagingPlan = await planner.buildRebuildPlanFromSandboxEntry({
        sandboxName,
        agent,
        sandboxEntry: {
          name: sandboxName,
          agent,
          messaging: {
            schemaVersion: 1,
            plan: persisted as unknown as SandboxMessagingPlan,
          },
        },
      });
      expect(messagingPlan).not.toBeNull();
      const providerName = messagingPlan?.credentialBindings.find(
        ({ channelId }) => channelId === "wechat",
      )?.providerName;
      expect(providerName).toBe(`${sandboxName}-wechat-bridge`);
      assert(providerName);

      const deltas = resolveRebuildMessagingPolicyDeltas(messagingPlan!);
      const rebuilt = selectRebuildCreatePolicy({
        policySourcePath: livePolicyPath,
        generatedPolicy: {
          policyPath: livePolicyPath,
          appliedPresets: [],
          credentialBindingProviders: [providerName],
          sourceBytes: Buffer.from("version: 1\nnetwork_policies: {}\n"),
        },
        requiredNetworkPolicyKeys: deltas.requiredNetworkPolicyKeys,
        removedNetworkPolicyKeys: deltas.removedNetworkPolicyKeys,
        requiredNetworkPolicyPresetNames: deltas.requiredNetworkPolicyPresetNames,
        requiredNetworkPolicyEntries: deltas.requiredNetworkPolicyEntries,
        removedNetworkPolicyEntries: deltas.removedNetworkPolicyEntries,
        packageAgentDefinition,
        harnessPackageIdentity: packagePolicyIdentity(packageAgentDefinition),
        messagingAgent: messagingPlan!.agent,
        messagingConfig: getMessagingChannelConfigFromPlan(messagingPlan),
        sandboxName,
        authorizedCredentialBindingProviders: [providerName],
      });

      try {
        const policy = YAML.parse(rebuilt.sourceBytes?.toString("utf8") ?? "") as {
          network_policies: {
            wechat_bridge: {
              endpoints: Array<{
                host: string;
                credential_binding: { provider: string };
              }>;
              binaries: Array<{ path: string }>;
            };
          };
        };
        const endpoints = policy.network_policies.wechat_bridge.endpoints;
        const configured = endpoints.find(({ host }) => host === "idc-37.weixin.qq.com");

        expect(configured).toMatchObject({
          host: "idc-37.weixin.qq.com",
          port: 443,
          protocol: "rest",
          enforcement: "enforce",
          credential_binding: { provider: providerName },
          rules: [
            { allow: { method: "GET", path: "/**" } },
            { allow: { method: "POST", path: "/**" } },
          ],
        });
        expect(endpoints.filter(({ host }) => host.startsWith("idc-"))).toHaveLength(1);
        expect(endpoints.map(({ host }) => host)).not.toContain("*.weixin.qq.com");
        expect(policy.network_policies.wechat_bridge.binaries.map(({ path }) => path)).toContain(
          agent === "hermes" ? "/usr/local/bin/hermes" : "/usr/local/bin/node",
        );
      } finally {
        rebuilt.cleanup?.();
      }
    },
  );

  it("uses a receipt package's non-channel preset and only its declared policy keys", () => {
    const presetName = "future-channel-egress";
    const agentDefinition = packagePolicyAgent(
      presetName,
      [
        "preset:",
        `  name: ${presetName}`,
        '  description: "Future harness messaging access"',
        "network_policies:",
        "  future_transport:",
        "    name: future_transport",
        "    endpoints:",
        "      - host: package-owned.example.test",
        "        port: 443",
        "        credential_binding:",
        '          provider: "{sandboxName}-future-bridge"',
        "    binaries: []",
        "  shared_policy:",
        "    name: shared_policy",
        "    endpoints:",
        "      - host: package-shadow.example.test",
        "        port: 443",
        "    binaries: []",
        "",
      ].join("\n"),
    );
    const livePolicyPath = tempPolicy("version: 1\nnetwork_policies:\n  host_preserved: {}\n");

    const rebuilt = selectRebuildCreatePolicy({
      policySourcePath: livePolicyPath,
      generatedPolicy: {
        policyPath: livePolicyPath,
        appliedPresets: [],
        credentialBindingProviders: [],
        sourceBytes: Buffer.from(
          [
            "version: 1",
            "network_policies:",
            "  shared_policy:",
            "    name: shared_policy",
            "    endpoints:",
            "      - host: replacement-authority.example.test",
            "        port: 443",
            "    binaries: []",
            "",
          ].join("\n"),
        ),
      },
      requiredNetworkPolicyKeys: ["future_transport", "shared_policy"],
      removedNetworkPolicyKeys: [],
      requiredNetworkPolicyPresetNames: [presetName],
      requiredNetworkPolicyEntries: [
        {
          channelId: "discord",
          presetName,
          policyKeys: ["future_transport"],
          source: "manifest",
        },
      ],
      packageAgentDefinition: agentDefinition,
      harnessPackageIdentity: packagePolicyIdentity(agentDefinition),
      messagingAgent: agentDefinition.name,
      messagingConfig: null,
      sandboxName: "alpha",
      authorizedCredentialBindingProviders: ["alpha-future-bridge"],
    });

    try {
      const source = rebuilt.sourceBytes?.toString("utf8") ?? "";
      expect(source).toContain("package-owned.example.test");
      expect(source).toContain("alpha-future-bridge");
      expect(source).toContain("host_preserved");
      expect(source).toContain("replacement-authority.example.test");
      expect(source).not.toContain("package-shadow.example.test");
    } finally {
      rebuilt.cleanup?.();
    }
  });

  it("materializes and upgrades an exact package WeChat policy under its declared key", () => {
    const presetName = "future-wechat-egress";
    const policyLines = [
      "preset:",
      `  name: ${presetName}`,
      '  description: "Future WeChat access"',
      "network_policies:",
      "  future_wechat:",
      "    name: future_wechat",
      "    endpoints:",
      "      - host: ilinkai.wechat.com",
      "        port: 443",
      "        protocol: rest",
      "        enforcement: enforce",
    ];
    const agentDefinition = packagePolicyAgent(
      presetName,
      [...policyLines, "    binaries: []", ""].join("\n"),
    );
    const livePolicyPath = tempPolicy(
      [
        ...policyLines,
        "      - host: idc-2.weixin.qq.com",
        "        port: 443",
        "        protocol: rest",
        "        enforcement: enforce",
        "    binaries: []",
        "",
      ].join("\n"),
    );
    const rebuilt = selectRebuildCreatePolicy({
      policySourcePath: livePolicyPath,
      generatedPolicy: {
        policyPath: livePolicyPath,
        appliedPresets: [],
        credentialBindingProviders: [],
        sourceBytes: Buffer.from("version: 1\nnetwork_policies: {}\n"),
      },
      requiredNetworkPolicyKeys: ["future_wechat"],
      removedNetworkPolicyKeys: [],
      requiredNetworkPolicyPresetNames: [presetName],
      requiredNetworkPolicyEntries: [
        {
          channelId: "wechat",
          presetName,
          policyKeys: ["future_wechat"],
          source: "manifest",
        },
      ],
      packageAgentDefinition: agentDefinition,
      harnessPackageIdentity: packagePolicyIdentity(agentDefinition),
      messagingAgent: agentDefinition.name,
      messagingConfig: { WECHAT_BASE_URL: "https://idc-3.weixin.qq.com" },
      sandboxName: "alpha",
      authorizedCredentialBindingProviders: [],
    });

    try {
      const source = rebuilt.sourceBytes?.toString("utf8") ?? "";
      expect(source).toContain("idc-3.weixin.qq.com");
      expect(source).not.toContain("idc-2.weixin.qq.com");
    } finally {
      rebuilt.cleanup?.();
    }
  });

  it.each([
    {
      name: "missing",
      source: null,
      owned: true,
      expected: "package asset is unavailable",
    },
    {
      name: "unowned",
      source: [
        "preset:",
        "  name: future-channel-egress",
        '  description: "Unowned source"',
        "network_policies:",
        "  future_transport: {}",
        "",
      ].join("\n"),
      owned: false,
      expected: "does not own required messaging policy preset",
    },
    {
      name: "malformed",
      source: "preset: [\n",
      owned: true,
      expected: "contains invalid YAML",
    },
    {
      name: "key mismatch",
      source: [
        "preset:",
        "  name: future-channel-egress",
        '  description: "Wrong key"',
        "network_policies:",
        "  another_transport: {}",
        "",
      ].join("\n"),
      owned: true,
      expected: "does not provide declared network policy key 'future_transport'",
    },
  ])("fails closed for a $name receipt package policy source", ({ source, owned, expected }) => {
    const presetName = "future-channel-egress";
    const agentDefinition = packagePolicyAgent(presetName, source, { owned });
    const livePolicyPath = tempPolicy("version: 1\nnetwork_policies: {}\n");

    expect(() =>
      selectRebuildCreatePolicy({
        policySourcePath: livePolicyPath,
        generatedPolicy: {
          policyPath: livePolicyPath,
          appliedPresets: [],
          credentialBindingProviders: [],
          sourceBytes: Buffer.from("version: 1\nnetwork_policies: {}\n"),
        },
        requiredNetworkPolicyKeys: ["future_transport"],
        removedNetworkPolicyKeys: [],
        requiredNetworkPolicyPresetNames: [presetName],
        requiredNetworkPolicyEntries: [
          {
            channelId: "discord",
            presetName,
            policyKeys: ["future_transport"],
            source: "manifest",
          },
        ],
        packageAgentDefinition: agentDefinition,
        harnessPackageIdentity: packagePolicyIdentity(agentDefinition),
        messagingAgent: agentDefinition.name,
        messagingConfig: null,
        sandboxName: "alpha",
        authorizedCredentialBindingProviders: [],
      }),
    ).toThrow(expected);
  });

  it("does not fall back to a core channel policy for a receipt-backed known agent", () => {
    const agentDefinition = packagePolicyAgent("telegram", null, {
      agentName: "openclaw",
      owned: false,
    });
    const livePolicyPath = tempPolicy("version: 1\nnetwork_policies: {}\n");

    expect(() =>
      selectRebuildCreatePolicy({
        policySourcePath: livePolicyPath,
        generatedPolicy: {
          policyPath: livePolicyPath,
          appliedPresets: [],
          credentialBindingProviders: [],
          sourceBytes: Buffer.from("version: 1\nnetwork_policies: {}\n"),
        },
        requiredNetworkPolicyKeys: ["telegram_bot"],
        removedNetworkPolicyKeys: [],
        requiredNetworkPolicyPresetNames: ["telegram"],
        requiredNetworkPolicyEntries: [
          {
            channelId: "telegram",
            presetName: "telegram",
            policyKeys: ["telegram_bot"],
            source: "manifest",
          },
        ],
        packageAgentDefinition: agentDefinition,
        harnessPackageIdentity: packagePolicyIdentity(agentDefinition),
        messagingAgent: "openclaw",
        messagingConfig: null,
        sandboxName: "alpha",
        authorizedCredentialBindingProviders: [],
      }),
    ).toThrow("does not own required messaging policy preset 'telegram'");
  });

  it("does not invoke the legacy session-only WeChat fallback for a receipt package", () => {
    const agentDefinition = packagePolicyAgent("wechat", null, {
      agentName: "openclaw",
      owned: false,
    });
    const livePolicyPath = tempPolicy("version: 1\nnetwork_policies: {}\n");
    const deltas = resolveRebuildMessagingPolicyDeltas(null, {
      agent: "openclaw",
      messagingConfig: { WECHAT_BASE_URL: "https://idc-3.weixin.qq.com" },
    });

    expect(() =>
      selectRebuildCreatePolicy({
        policySourcePath: livePolicyPath,
        generatedPolicy: {
          policyPath: livePolicyPath,
          appliedPresets: [],
          credentialBindingProviders: [],
          sourceBytes: Buffer.from("version: 1\nnetwork_policies: {}\n"),
        },
        requiredNetworkPolicyKeys: deltas.requiredNetworkPolicyKeys,
        removedNetworkPolicyKeys: deltas.removedNetworkPolicyKeys,
        requiredNetworkPolicyPresetNames: deltas.requiredNetworkPolicyPresetNames,
        requiredNetworkPolicyEntries: deltas.requiredNetworkPolicyEntries,
        removedNetworkPolicyEntries: deltas.removedNetworkPolicyEntries,
        packageAgentDefinition: agentDefinition,
        harnessPackageIdentity: packagePolicyIdentity(agentDefinition),
        messagingAgent: agentDefinition.name,
        messagingConfig: { WECHAT_BASE_URL: "https://idc-3.weixin.qq.com" },
        sandboxName: "alpha",
        authorizedCredentialBindingProviders: [],
      }),
    ).toThrow("receipt-backed messaging policies require typed package policy entries");
  });

  it.each(["openclaw", "hermes"] as const)(
    "upgrades a legacy session-only WeChat policy and keeps its provider attached for %s (#10606)",
    (agent) => {
      const sandboxName = agent === "hermes" ? "legacy-he" : "legacy-oc";
      const providerName = `${sandboxName}-wechat-bridge`;
      const legacyWechatPolicy = loadMessagingChannelPolicyPreset("wechat", {
        agent,
        sandboxName,
      });
      assert(legacyWechatPolicy);
      const livePolicyPath = tempPolicy(legacyWechatPolicy);
      const legacyMessagingConfig = getStoredMessagingChannelConfig(
        sandboxName,
        {
          sandboxName,
          messagingPlan: null,
          wechatConfig: {
            accountId: "legacy-account",
            baseUrl: "https://idc-3.weixin.qq.com",
            userId: "legacy-user",
          },
        } as Session,
        {
          readMessagingPlanFromEnv: () => null,
          getRegistryMessagingAuthority: () => ({ authoritative: false, plan: null }),
        },
      );
      expect(legacyMessagingConfig?.WECHAT_BASE_URL).toBe("https://idc-3.weixin.qq.com");
      expect(() =>
        resolveRebuildMessagingPolicyDeltas(null, {
          agent,
          messagingConfig: {
            WECHAT_BASE_URL: "https://idc-3.weixin.qq.com.evil.example",
          },
        }),
      ).toThrow("WeChat baseUrl must use an expected iLink host");
      const replacementWechatPolicy = loadMessagingChannelPolicyPreset("wechat", {
        agent,
        sandboxName,
        messagingConfig: legacyMessagingConfig,
      });
      assert(replacementWechatPolicy);

      const deltas = resolveRebuildMessagingPolicyDeltas(null, {
        agent,
        messagingConfig: legacyMessagingConfig,
      });
      expect(deltas).toEqual({
        requiredNetworkPolicyKeys: ["wechat_bridge"],
        requiredNetworkPolicyEntries: [],
        requiredNetworkPolicyPresetNames: ["wechat"],
        removedNetworkPolicyKeys: [],
        removedNetworkPolicyEntries: [],
      });
      const rebuilt = selectRebuildCreatePolicy({
        policySourcePath: livePolicyPath,
        generatedPolicy: {
          policyPath: livePolicyPath,
          appliedPresets: [],
          credentialBindingProviders: [providerName],
          sourceBytes: Buffer.from(replacementWechatPolicy),
        },
        requiredNetworkPolicyKeys: deltas.requiredNetworkPolicyKeys,
        removedNetworkPolicyKeys: deltas.removedNetworkPolicyKeys,
        requiredNetworkPolicyPresetNames: deltas.requiredNetworkPolicyPresetNames,
        requiredNetworkPolicyEntries: deltas.requiredNetworkPolicyEntries,
        messagingAgent: agent,
        messagingConfig: legacyMessagingConfig,
        sandboxName,
        authorizedCredentialBindingProviders: [providerName],
      });

      try {
        const policy = YAML.parse(rebuilt.sourceBytes?.toString("utf8") ?? "") as {
          network_policies: {
            wechat_bridge: {
              endpoints: Array<{
                host: string;
                credential_binding: { provider: string };
              }>;
            };
          };
        };
        const endpoints = policy.network_policies.wechat_bridge.endpoints;
        expect(endpoints.find(({ host }) => host === "idc-3.weixin.qq.com")).toMatchObject({
          port: 443,
          protocol: "rest",
          enforcement: "enforce",
          credential_binding: { provider: providerName },
          rules: [
            { allow: { method: "GET", path: "/**" } },
            { allow: { method: "POST", path: "/**" } },
          ],
        });
        expect(endpoints.filter(({ host }) => host.startsWith("idc-"))).toHaveLength(1);
        expect(endpoints.map(({ host }) => host)).not.toContain("*.weixin.qq.com");

        expect(bindRebuildPolicyProvidersToCreateArgs(["--from", "image"], rebuilt)).toEqual([
          "--from",
          "image",
          "--provider",
          providerName,
        ]);
      } finally {
        rebuilt.cleanup?.();
      }
    },
  );

  it.each([
    {
      name: "exact package value",
      host: "host.openshell.internal",
      verifySelection: (
        select: () => ReturnType<typeof selectRebuildCreatePolicy>,
        _livePolicyPath: string,
      ) => expectSelectedPolicyKeyRemoved(select, "future-observability"),
    },
    {
      name: "foreign same-key value",
      host: "operator.example.test",
      verifySelection: (
        select: () => ReturnType<typeof selectRebuildCreatePolicy>,
        livePolicyPath: string,
      ) =>
        expectPolicySelectionRejected(
          select,
          livePolicyPath,
          "does not match package removal authority",
          "operator.example.test",
        ),
    },
  ])("removes only an $name for package observability", (testCase) => {
    const presetName = "future-observability";
    const agentDefinition = packagePolicyAgent(
      presetName,
      YAML.stringify({
        preset: { name: presetName, description: "Future observability" },
        network_policies: {
          [presetName]: {
            name: presetName,
            endpoints: [{ host: "host.openshell.internal", port: 4318 }],
          },
        },
      }),
      { automaticObservability: true },
    );
    const delta = resolveRebuildObservabilityPolicyDelta({
      agent: agentDefinition.name,
      receiptBackedPackage: true,
      packagePolicy: agentDefinition.policyCapability,
      enabled: false,
      explicitlyRequested: true,
      tierName: "balanced",
    });
    expect(delta.removedAutomaticPolicyPresetNames).toEqual([presetName]);
    const livePolicyPath = tempPolicy(
      YAML.stringify({
        version: 1,
        network_policies: {
          [presetName]: {
            name: presetName,
            endpoints: [{ host: testCase.host, port: 4318 }],
          },
        },
      }),
    );
    const select = () =>
      selectRebuildCreatePolicy({
        policySourcePath: livePolicyPath,
        generatedPolicy: {
          policyPath: livePolicyPath,
          appliedPresets: [],
          credentialBindingProviders: [],
          sourceBytes: Buffer.from("version: 1\nnetwork_policies: {}\n"),
        },
        requiredNetworkPolicyKeys: delta.requiredNetworkPolicyKeys,
        removedNetworkPolicyKeys: delta.removedNetworkPolicyKeys,
        requiredNetworkPolicyPresetNames: [],
        requiredNetworkPolicyEntries: [],
        removedAutomaticPolicyPresetNames: delta.removedAutomaticPolicyPresetNames,
        packageAgentDefinition: agentDefinition,
        harnessPackageIdentity: packagePolicyIdentity(agentDefinition),
        messagingAgent: agentDefinition.name,
        messagingConfig: null,
        sandboxName: "alpha",
        authorizedCredentialBindingProviders: [],
      });

    testCase.verifySelection(select, livePolicyPath);
  });

  it.each([
    ["langchain-deepagents-code", true, true, "balanced", ["observability-otlp-local"], []],
    ["langchain-deepagents-code", false, true, "balanced", [], ["observability-otlp-local"]],
    ["langchain-deepagents-code", true, true, "restricted", [], ["observability-otlp-local"]],
    ["langchain-deepagents-code", true, false, null, [], []],
    ["openclaw", true, true, "balanced", [], []],
  ] as const)(
    "derives the rebuild observability delta for %s enabled=%s explicit=%s tier=%s",
    (
      agent,
      enabled,
      explicitlyRequested,
      tierName,
      requiredNetworkPolicyKeys,
      removedNetworkPolicyKeys,
    ) => {
      expect(
        resolveRebuildObservabilityPolicyDelta({
          agent,
          receiptBackedPackage: false,
          enabled,
          explicitlyRequested,
          tierName,
        }),
      ).toEqual({
        requiredNetworkPolicyKeys,
        removedNetworkPolicyKeys,
        removedAutomaticPolicyPresetNames: [],
      });
    },
  );

  it("does not enter the legacy DCode policy lane for a receipt without a declaration", () => {
    expect(
      resolveRebuildObservabilityPolicyDelta({
        agent: "langchain-deepagents-code",
        receiptBackedPackage: true,
        packagePolicy: null,
        enabled: true,
        explicitlyRequested: true,
        tierName: "balanced",
      }),
    ).toEqual({
      requiredNetworkPolicyKeys: [],
      removedNetworkPolicyKeys: [],
      removedAutomaticPolicyPresetNames: [],
    });
  });

  it("adds missing live-policy providers to the final create arguments", () => {
    expect(
      bindRebuildPolicyProvidersToCreateArgs(
        ["--from", "image", "--provider", "operator-provider"],
        {
          credentialBindingProviders: ["operator-provider", "wechat-provider"],
        },
      ),
    ).toEqual([
      "--from",
      "image",
      "--provider",
      "operator-provider",
      "--provider",
      "wechat-provider",
    ]);
  });

  it("inserts rebuild providers before the sandbox startup command separator", () => {
    expect(
      bindRebuildPolicyProvidersToCreateArgs(
        [
          "openshell",
          "sandbox",
          "create",
          "--provider",
          "inference-provider",
          "--",
          "env",
          "nemoclaw-start",
        ],
        {
          credentialBindingProviders: ["inference-provider", "mcp-provider"],
        },
      ),
    ).toEqual([
      "openshell",
      "sandbox",
      "create",
      "--provider",
      "inference-provider",
      "--provider",
      "mcp-provider",
      "--",
      "env",
      "nemoclaw-start",
    ]);
  });

  it("authorizes enabled messaging and managed MCP providers but rejects disabled channels", () => {
    expect(
      resolveRebuildPolicyProviderAuthority({
        createArgs: ["--from", "image", "--provider", "inference-provider"],
        messagingPlan: {
          disabledChannels: ["discord"],
          credentialBindings: [
            {
              channelId: "telegram",
              credentialId: "bot-token",
              sourceInput: "token",
              providerName: "alpha-telegram-bridge",
              providerEnvKey: "TELEGRAM_BOT_TOKEN",
              placeholder: "${TELEGRAM_BOT_TOKEN}",
              credentialAvailable: true,
            },
            {
              channelId: "discord",
              credentialId: "bot-token",
              sourceInput: "token",
              providerName: "alpha-discord-bridge",
              providerEnvKey: "DISCORD_BOT_TOKEN",
              placeholder: "${DISCORD_BOT_TOKEN}",
              credentialAvailable: true,
            },
          ],
        },
        preservedMcpState,
        managedMcpRebuildHandoff: true,
      }),
    ).toEqual(["inference-provider", "alpha-telegram-bridge", "alpha-mcp-github"]);
  });

  it("does not authorize MCP registry names without the managed rebuild handoff", () => {
    expect(
      resolveRebuildPolicyProviderAuthority({
        createArgs: [],
        messagingPlan: null,
        preservedMcpState,
        managedMcpRebuildHandoff: false,
      }),
    ).toEqual([]);
  });

  it("ignores incomplete MCP add records even with a managed rebuild handoff", () => {
    expect(
      resolveRebuildPolicyProviderAuthority({
        createArgs: [],
        messagingPlan: null,
        preservedMcpState: {
          bridges: {
            github: {
              ...preservedMcpState.bridges.github,
              addState: "prepared",
            },
          },
        },
        managedMcpRebuildHandoff: true,
      }),
    ).toEqual([]);
  });
});
