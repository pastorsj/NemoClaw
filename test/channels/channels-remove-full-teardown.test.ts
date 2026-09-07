// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression test for #3998. Channel removal must clear durable QR-pairing state before it
// changes policy or persists the removal tombstone. These integration tests use real installed
// harness-package receipts and the isolated Vitest registry. Only OpenShell/process boundaries
// are replaced, so package messaging authority and registry persistence remain production code.

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";

import { removeSandboxChannel } from "../../src/lib/actions/sandbox/policy-channel";
import { policyChannelDependencies } from "../../src/lib/actions/sandbox/policy-channel-dependencies";
import * as processRecovery from "../../src/lib/actions/sandbox/process-recovery";
import type { HarnessPackageIdentity } from "../../src/lib/agent-runtime/package/types";
import * as gatewayRuntime from "../../src/lib/gateway-runtime-action";
import {
  MESSAGING_CREDENTIAL_PROVIDER_TYPE,
  type SandboxMessagingPlan,
  type SandboxMessagingProviderReceipt,
} from "../../src/lib/messaging";
import type { GatewayProviderMetadata } from "../../src/lib/onboard/gateway-provider-metadata";
import { materializeMessagingChannelPolicyContent } from "../../src/lib/messaging/channels";
import * as policies from "../../src/lib/policy";
import { captureSandboxCommandAgentAuthority } from "../../src/lib/sandbox/command-agent";
import * as registry from "../../src/lib/state/registry";
import type { SandboxEntry } from "../../src/lib/state/registry/types";
import {
  createHarnessPackageFixture,
  type HarnessPackageFixture,
} from "../helpers/harness-packages";
import { restoreEnv } from "../helpers/env-test-helpers";
import { makeMessagingPlan } from "../helpers/messaging-plan-fixtures";

const SANDBOX_NAME = "test-sb";
const LIVE_SANDBOX_FINGERPRINT = "f".repeat(64);
const MESSAGING_ENV_PREFIXES = [
  "TELEGRAM_",
  "DISCORD_",
  "SLACK_",
  "WECHAT_",
  "WEIXIN_",
  "WHATSAPP_",
];

type AgentUnderTest = "openclaw" | "hermes";
type ReceiptBackedChannel = "telegram" | "wechat";
type SandboxCommandResult = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
};
type StoppedCleanupResult =
  | { readonly cleared: true }
  | {
      readonly cleared: false;
      readonly failure: string;
      readonly cleanupHelperName?: string;
    };

let packageFixtures: HarnessPackageFixture[] = [];
let packageIdentities: Record<AgentUnderTest, HarnessPackageIdentity>;
let packageRoots: Record<AgentUnderTest, string>;
let livePolicyDocument = YAML.stringify({ version: 1, network_policies: {} });
let previousNonInteractive: string | undefined;
let removedMessagingEnvironment = new Map<string, string>();

let exitSpy: MockInstance;
let logSpy: MockInstance;
let errorSpy: MockInstance;
let listPresetsSpy: MockInstance;
let getAppliedPresetsSpy: MockInstance;
let removePresetSpy: MockInstance;
let setPolicyDocumentSpy: MockInstance;
let sandboxExecSpy: MockInstance;
let sandboxSshSpy: MockInstance;
let stoppedCleanupSpy: MockInstance;
let attachedProviderNames = new Set<string>();
let liveProviderMetadata = new Map<string, GatewayProviderMetadata>();

function providerNameForChannel(channelId: ReceiptBackedChannel): string {
  return `${SANDBOX_NAME}-${channelId}-bridge`;
}

function providerCredentialKeyForChannel(channelId: ReceiptBackedChannel): string {
  return channelId === "telegram" ? "TELEGRAM_BOT_TOKEN" : "WECHAT_BOT_TOKEN";
}

function providerIdForChannel(channelId: ReceiptBackedChannel): string {
  return `${channelId}-provider-id`;
}

function buildProviderReceipt(channelId: ReceiptBackedChannel): SandboxMessagingProviderReceipt {
  return {
    channelId,
    providerName: providerNameForChannel(channelId),
    providerId: providerIdForChannel(channelId),
    createdByNemoClaw: true,
    attachmentAddedByNemoClaw: true,
  };
}

function installLiveProvider(channelId: ReceiptBackedChannel): void {
  const providerName = providerNameForChannel(channelId);
  liveProviderMetadata.set(providerName, {
    id: providerIdForChannel(channelId),
    name: providerName,
    type: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
    credentialKeys: [providerCredentialKeyForChannel(channelId)],
    configKeys: [],
  });
  attachedProviderNames.add(providerName);
}

function buildStoredMessagingPlan(
  agent: AgentUnderTest,
  channelInRegistry: string,
  providerReceiptChannels: readonly ReceiptBackedChannel[],
): SandboxMessagingPlan {
  const plan = makeMessagingPlan({
    sandboxName: SANDBOX_NAME,
    agent,
    channels: channelInRegistry ? [channelInRegistry] : [],
    providerReceipts: providerReceiptChannels.map(buildProviderReceipt),
    ...(channelInRegistry === "wechat" ? { authMode: "host-qr" as const } : {}),
  });
  return {
    ...plan,
    channels: plan.channels.map((channel) =>
      channel.channelId === "wechat"
        ? {
            ...channel,
            inputs: [
              {
                channelId: "wechat",
                inputId: "accountId",
                kind: "config",
                required: true,
                statePath: "wechatConfig.accountId",
                value: "test-wechat-account",
              },
            ],
          }
        : channel,
    ),
  };
}

function buildInstalledPackagePolicyDocument(
  agent: AgentUnderTest,
  presetNames: readonly string[],
): string {
  const networkPolicies = Object.fromEntries(
    presetNames.flatMap((presetName) => {
      const presetPath = path.join(
        packageRoots[agent],
        "policies",
        "presets",
        `${presetName}.yaml`,
      );
      const materialized = fs.existsSync(presetPath)
        ? materializeMessagingChannelPolicyContent(
            fs.readFileSync(presetPath, "utf8"),
            presetName,
            {
              sandboxName: SANDBOX_NAME,
            },
          )
        : null;
      const document = YAML.parse(materialized ?? "") as {
        readonly network_policies?: Readonly<Record<string, unknown>>;
      } | null;
      return Object.entries(document?.network_policies ?? {});
    }),
  );
  return YAML.stringify({ version: 1, network_policies: networkPolicies });
}

function registerSandboxScenario({
  presetNamesApplied = ["npm", "pypi", "huggingface", "brew", "whatsapp"],
  agent = "openclaw",
  channelInRegistry = "whatsapp",
  receiptBacked = true,
  providerReceiptChannels,
  sandboxExecResult = {
    status: 0,
    stdout: "NEMOCLAW_CHANNEL_CLEAR_OK",
    stderr: "",
  } as SandboxCommandResult | null,
  sshFallbackResult = null as SandboxCommandResult | null,
  stoppedDockerCleanupResult = {
    cleared: false,
    failure: "state-resource-unavailable",
  } as StoppedCleanupResult,
}: {
  readonly presetNamesApplied?: readonly string[];
  readonly agent?: AgentUnderTest;
  readonly channelInRegistry?: string;
  readonly receiptBacked?: boolean;
  readonly providerReceiptChannels?: readonly ReceiptBackedChannel[];
  readonly sandboxExecResult?: SandboxCommandResult | null;
  readonly sshFallbackResult?: SandboxCommandResult | null;
  readonly stoppedDockerCleanupResult?: StoppedCleanupResult;
} = {}): SandboxEntry {
  listPresetsSpy.mockReturnValue(
    presetNamesApplied.map((name) => ({ file: `${name}.yaml`, name, description: "test preset" })),
  );
  getAppliedPresetsSpy.mockReturnValue([...presetNamesApplied]);
  livePolicyDocument = buildInstalledPackagePolicyDocument(agent, presetNamesApplied);
  sandboxExecSpy.mockReturnValue(sandboxExecResult);
  sandboxSshSpy.mockReturnValue(sshFallbackResult);
  stoppedCleanupSpy.mockReturnValue(stoppedDockerCleanupResult);
  const storedProviderReceiptChannels =
    providerReceiptChannels ??
    (receiptBacked && (channelInRegistry === "telegram" || channelInRegistry === "wechat")
      ? [channelInRegistry]
      : []);

  registry.registerSandbox({
    name: SANDBOX_NAME,
    agent,
    ...(receiptBacked
      ? {
          gatewayName: "nemoclaw",
          harnessPackage: packageIdentities[agent],
          lifecycleGeneration: "generation-1",
          lifecycleLiveIdentityFingerprint: LIVE_SANDBOX_FINGERPRINT,
        }
      : {}),
    messaging: {
      schemaVersion: 1,
      plan: buildStoredMessagingPlan(agent, channelInRegistry, storedProviderReceiptChannels),
    },
  });
  const persisted = registry.getSandbox(SANDBOX_NAME);
  expect(persisted, "sandbox removal fixture was not persisted").not.toBeNull();
  return persisted!;
}

function expectCleanupBeforeQueuedRebuild(): void {
  const lines = logSpy.mock.calls.map((call) => call.map(String).join(" "));
  const cleanupIndex = lines.findIndex((line) => line.includes("Cleared in-sandbox"));
  const queuedRebuildIndex = lines.findIndex((line) => line.includes("Change queued"));
  expect(cleanupIndex).toBeGreaterThanOrEqual(0);
  expect(queuedRebuildIndex).toBeGreaterThan(cleanupIndex);
}

function expectRemovedPreset(channelId: string): void {
  const agent = registry.getSandbox(SANDBOX_NAME)?.agent;
  const policyKey =
    channelId === "telegram" && agent === "openclaw"
      ? "telegram_bot"
      : channelId === "wechat"
        ? "wechat_bridge"
        : channelId;
  expect(setPolicyDocumentSpy).toHaveBeenCalledTimes(1);
  const desiredPolicy = YAML.parse(
    String(setPolicyDocumentSpy.mock.calls[0]?.[1] ?? ""),
  ).network_policies;
  expect(desiredPolicy).not.toHaveProperty(policyKey);
  expect(removePresetSpy).not.toHaveBeenCalled();
}

function registeredMessagingChannels(): SandboxMessagingPlan["channels"] {
  return registry.getSandbox(SANDBOX_NAME)?.messaging?.plan.channels ?? [];
}

beforeAll(() => {
  const home = process.env.HOME;
  expect(home, "channel removal integration tests require an isolated HOME").toBeTruthy();
  expect(path.isAbsolute(home!), "channel removal test HOME must be absolute").toBe(true);
  const fixtureParent = path.join(home!, "channel-removal-packages");
  const storeRoot = path.join(home!, ".nemoclaw", "harnesses");

  const openclawFixture = createHarnessPackageFixture({
    fixtureParent,
    storeRoot,
    messaging: {
      packageId: "openclaw",
      channelIds: ["telegram", "wechat", "whatsapp"],
    },
  });
  const hermesFixture = createHarnessPackageFixture({
    fixtureParent,
    storeRoot,
    messaging: {
      packageId: "hermes",
      channelIds: ["telegram", "whatsapp"],
    },
  });
  for (const [fixture, agent, presets] of [
    [openclawFixture, "openclaw", ["telegram", "wechat", "whatsapp"]],
    [hermesFixture, "hermes", ["telegram", "whatsapp"]],
  ] as const) {
    const packageRoot = fixture.packageRoots.get(agent);
    expect(packageRoot, `${agent} fixture package root is unavailable`).toBeDefined();
    const manifestPath = path.join(packageRoot!, "manifest.yaml");
    fs.writeFileSync(
      manifestPath,
      fs
        .readFileSync(manifestPath, "utf8")
        .replace(
          "  owned_presets: []",
          `  owned_presets:\n${presets.map((preset) => `    - ${preset}`).join("\n")}`,
        ),
      { mode: 0o600 },
    );
    const fixturePresetDirectory = path.join(packageRoot!, "policies", "presets");
    fs.mkdirSync(fixturePresetDirectory, { recursive: true, mode: 0o700 });
    for (const preset of presets) {
      fs.copyFileSync(
        path.join(
          process.cwd(),
          "packages",
          `nemoclaw-${agent}`,
          "policies",
          "presets",
          `${preset}.yaml`,
        ),
        path.join(fixturePresetDirectory, `${preset}.yaml`),
      );
    }
  }
  const installedOpenclaw = openclawFixture.install("openclaw");
  const installedHermes = hermesFixture.install("hermes");
  packageFixtures = [openclawFixture, hermesFixture];
  packageIdentities = {
    openclaw: installedOpenclaw.identity,
    hermes: installedHermes.identity,
  };
  packageRoots = {
    openclaw: installedOpenclaw.packageRoot,
    hermes: installedHermes.packageRoot,
  };
});

beforeEach(() => {
  registry.clearAll();
  attachedProviderNames = new Set();
  liveProviderMetadata = new Map();
  livePolicyDocument = YAML.stringify({ version: 1, network_policies: {} });
  previousNonInteractive = process.env.NEMOCLAW_NON_INTERACTIVE;
  process.env.NEMOCLAW_NON_INTERACTIVE = "1";
  removedMessagingEnvironment = new Map(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        MESSAGING_ENV_PREFIXES.some((prefix) => entry[0].startsWith(prefix)),
    ),
  );
  for (const key of removedMessagingEnvironment.keys()) delete process.env[key];

  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as never);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  listPresetsSpy = vi.spyOn(policies, "listPresets");
  getAppliedPresetsSpy = vi.spyOn(policies, "getAppliedPresets");
  removePresetSpy = vi.spyOn(policies, "removePreset").mockReturnValue(true);
  const policyMutationContext = (): policies.PolicyMutationContext => {
    const sandbox = registry.getSandbox(SANDBOX_NAME);
    return {
      gatewayName: "nemoclaw",
      inspection: {} as policies.PolicyMutationContext["inspection"],
      basePolicyDocument: livePolicyDocument,
      ...(sandbox?.harnessPackage
        ? { agentAuthority: captureSandboxCommandAgentAuthority(sandbox) }
        : {}),
    };
  };
  vi.spyOn(policies, "inspectPolicyMutationContext").mockImplementation(policyMutationContext);
  vi.spyOn(policies, "recheckPolicyMutationContext").mockImplementation(policyMutationContext);
  setPolicyDocumentSpy = vi.spyOn(policies, "setPolicyDocument").mockReturnValue(true);
  sandboxExecSpy = vi.spyOn(processRecovery, "executeSandboxExecCommand");
  sandboxSshSpy = vi.spyOn(processRecovery, "executeSandboxCommand");
  stoppedCleanupSpy = vi.spyOn(policyChannelDependencies, "clearStoppedSandboxStateRoots");
  vi.spyOn(policyChannelDependencies, "runOpenshell").mockReturnValue({
    status: 0,
    stdout: "",
    stderr: "",
  } as never);
  vi.spyOn(policyChannelDependencies, "runGatewayOpenshell").mockImplementation(
    (_gatewayName, args) => {
      if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "detach") {
        attachedProviderNames.delete(String(args[4]));
      }
      return { status: 0, stdout: "", stderr: "" } as never;
    },
  );
  vi.spyOn(policyChannelDependencies, "deleteMessagingProviderWithRecovery").mockImplementation(
    (providerName) => {
      liveProviderMetadata.delete(providerName);
      attachedProviderNames.delete(providerName);
      return { ok: true, status: 0, stdout: "", stderr: "" } as never;
    },
  );
  vi.spyOn(policyChannelDependencies, "cleanupMessagingProviders").mockImplementation(
    async (providerNames, _sandboxName, _gatewayName, revalidateSandboxIdentity, options = {}) => {
      const detachOnly = new Set(options.detachOnlyProviderNames ?? []);
      const outcomes = providerNames.map((providerName) => {
        revalidateSandboxIdentity(`clean up messaging provider ${JSON.stringify(providerName)}`);
        const metadata = liveProviderMetadata.get(providerName);
        const expectedProviderId = options.expectedProviderIds?.[providerName];
        const absent = metadata === undefined;
        const identityDrift = Boolean(
          metadata && expectedProviderId && metadata.id !== expectedProviderId,
        );
        const mayMutate = !absent && !identityDrift;
        const detached = mayMutate && attachedProviderNames.delete(providerName);
        const removed = mayMutate && !detachOnly.has(providerName);
        removed ? liveProviderMetadata.delete(providerName) : undefined;
        return { absent, detached, identityDrift, providerName, removed };
      });
      return {
        removedProviderNames: outcomes
          .filter(({ removed }) => removed)
          .map(({ providerName }) => providerName),
        absentProviderNames: outcomes
          .filter(({ absent }) => absent)
          .map(({ providerName }) => providerName),
        detachedAttachments: outcomes
          .filter(({ detached }) => detached)
          .map(({ providerName }) => ({ providerName, sandboxName: SANDBOX_NAME })),
        residualProviders: outcomes
          .filter(({ identityDrift }) => identityDrift)
          .map(({ providerName }) => ({
            providerName,
            error: {
              kind: "validation" as const,
              message: `Messaging provider '${providerName}' changed from its recorded stable identity.`,
            },
          })),
      };
    },
  );
  vi.spyOn(policyChannelDependencies, "inspectMessagingProviderAttachmentTarget").mockReturnValue(
    LIVE_SANDBOX_FINGERPRINT,
  );
  vi.spyOn(policyChannelDependencies, "inspectMessagingProviderBinding").mockImplementation(
    (binding) => ({ kind: liveProviderMetadata.has(binding.name) ? "exact" : "missing" }),
  );
  vi.spyOn(policyChannelDependencies, "inspectMessagingProviderMetadata").mockImplementation(
    (providerName) => liveProviderMetadata.get(providerName) ?? null,
  );
  vi.spyOn(policyChannelDependencies, "inspectMessagingProviderAttachments").mockImplementation(
    () =>
      [...attachedProviderNames].flatMap((providerName) => {
        const metadata = liveProviderMetadata.get(providerName);
        return metadata?.id
          ? [
              {
                name: providerName,
                providerId: metadata.id,
                credentialKeys: metadata.credentialKeys,
              },
            ]
          : [];
      }),
  );
  vi.spyOn(gatewayRuntime, "recoverNamedGatewayRuntime").mockResolvedValue({
    recovered: true,
    attempted: false,
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnv("NEMOCLAW_NON_INTERACTIVE", previousNonInteractive);
  const currentMessagingEnvironment = Object.keys(process.env).filter((key) =>
    MESSAGING_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)),
  );
  for (const key of currentMessagingEnvironment) delete process.env[key];
  Object.assign(process.env, Object.fromEntries(removedMessagingEnvironment));
  registry.clearAll();
});

afterAll(() => {
  for (const fixture of packageFixtures) fixture.cleanup();
});

describe.sequential("channels remove full teardown (#3998)", () => {
  it("clears both OpenClaw WeChat state generations before queuing rebuild", async () => {
    registerSandboxScenario({
      presetNamesApplied: ["npm", "pypi", "wechat"],
      agent: "openclaw",
      channelInRegistry: "wechat",
    });

    await expect(
      removeSandboxChannel(SANDBOX_NAME, { channel: "wechat" }),
    ).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
    const cleanupCommand = String(sandboxExecSpy.mock.calls[0]?.[1] ?? "");
    expect(cleanupCommand).toContain("/sandbox/.openclaw/wechat");
    expect(cleanupCommand).toContain("/sandbox/.openclaw/openclaw-weixin");
    expectCleanupBeforeQueuedRebuild();
  });

  it("recovers WeChat cleanup from its stopped provider state resource", async () => {
    registerSandboxScenario({
      presetNamesApplied: ["npm", "pypi", "wechat"],
      agent: "openclaw",
      channelInRegistry: "wechat",
      sandboxExecResult: { status: 1, stdout: "", stderr: "startup failed" },
      sshFallbackResult: { status: 255, stdout: "", stderr: "sandbox stopped" },
      stoppedDockerCleanupResult: { cleared: true },
    });

    await expect(
      removeSandboxChannel(SANDBOX_NAME, { channel: "wechat" }),
    ).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(stoppedCleanupSpy).toHaveBeenCalledWith(SANDBOX_NAME, [
      "/sandbox/.openclaw/wechat",
      "/sandbox/.openclaw/openclaw-weixin",
    ]);
    expectRemovedPreset("wechat");
    expect(registeredMessagingChannels()).toEqual([
      expect.objectContaining({ channelId: "wechat", pendingRemoval: true }),
    ]);
  });

  it("recovers stopped WeChat residue after logical teardown already completed", async () => {
    registerSandboxScenario({
      presetNamesApplied: ["npm", "pypi"],
      agent: "openclaw",
      channelInRegistry: "telegram",
      providerReceiptChannels: ["wechat"],
      sandboxExecResult: { status: 1, stdout: "", stderr: "sandbox stopped" },
      sshFallbackResult: { status: 255, stdout: "", stderr: "sandbox stopped" },
      stoppedDockerCleanupResult: { cleared: true },
    });

    await expect(
      removeSandboxChannel(SANDBOX_NAME, { channel: "wechat" }),
    ).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(stoppedCleanupSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      failure: "cleanup-state-tree-unsafe",
      cleanup: { cleared: false, failure: "cleanup-state-tree-unsafe" },
      guidance:
        "Inspect the stopped sandbox volume; recreate the sandbox if its state tree is untrusted.",
    },
    {
      failure: "cleanup-deletion-unconfirmed",
      cleanup: { cleared: false, failure: "cleanup-deletion-unconfirmed" },
      guidance: "Restore writable access to the stopped sandbox volume.",
    },
    {
      failure: "cleanup-helper-failed",
      cleanup: { cleared: false, failure: "cleanup-helper-failed" },
      guidance: "Inspect the stopped sandbox and selected runtime provider.",
    },
    {
      failure: "cleanup-helper-ownership-invalid",
      cleanup: {
        cleared: false,
        failure: "cleanup-helper-ownership-invalid",
        cleanupHelperName: "nemoclaw-channel-cleanup-owned-helper",
      },
      guidance:
        "Inspect or remove cleanup helper 'nemoclaw-channel-cleanup-owned-helper' for sandbox 'test-sb'.",
    },
    {
      failure: "cleanup-helper-reconciliation-failed",
      cleanup: {
        cleared: false,
        failure: "cleanup-helper-reconciliation-failed",
        cleanupHelperName: "nemoclaw-channel-cleanup-reconcile-helper",
      },
      guidance:
        "Inspect or remove cleanup helper 'nemoclaw-channel-cleanup-reconcile-helper' for sandbox 'test-sb'.",
    },
  ] as const)(
    "retains WeChat state and reports recovery guidance for $failure",
    async ({ cleanup, failure, guidance }) => {
      const original = registerSandboxScenario({
        presetNamesApplied: ["npm", "pypi", "wechat"],
        agent: "openclaw",
        channelInRegistry: "wechat",
        sandboxExecResult: { status: 1, stdout: "", stderr: "sandbox stopped" },
        sshFallbackResult: { status: 255, stdout: "", stderr: "sandbox stopped" },
        stoppedDockerCleanupResult: cleanup,
      });

      await expect(removeSandboxChannel(SANDBOX_NAME, { channel: "wechat" })).rejects.toThrow(
        "process.exit(1)",
      );

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stoppedCleanupSpy).toHaveBeenCalledTimes(1);
      expect(removePresetSpy).not.toHaveBeenCalled();
      expect(registry.getSandbox(SANDBOX_NAME)).toEqual(original);
      expect(logSpy.mock.calls.flat().map(String)).not.toContainEqual(
        expect.stringContaining("Change queued"),
      );
      const diagnostics = errorSpy.mock.calls.flat().map(String).join("\n");
      expect(diagnostics).toContain(`Stopped-runtime cleanup failed (${failure}).`);
      expect(diagnostics).toContain(guidance);
    },
  );

  it.each(["openclaw", "hermes"] as const)(
    "removes the live '%s' policy and clears every package-declared WhatsApp state path",
    async (agent) => {
      registerSandboxScenario({ agent });

      await expect(
        removeSandboxChannel(SANDBOX_NAME, { channel: "whatsapp" }),
      ).resolves.toBeUndefined();

      expect(exitSpy).not.toHaveBeenCalled();
      expectRemovedPreset("whatsapp");
      const cleanupCommand = String(sandboxExecSpy.mock.calls[0]?.[1] ?? "");
      const expectedPath =
        agent === "openclaw"
          ? "/sandbox/.openclaw/whatsapp"
          : "/sandbox/.hermes/platforms/whatsapp";
      expect(cleanupCommand).toContain(expectedPath);
      expect(cleanupCommand.includes(`/sandbox/.${agent}/profiles/dashboard-home`)).toBe(
        agent === "hermes",
      );
      expectCleanupBeforeQueuedRebuild();
    },
  );

  it("falls back to SSH when sandbox-exec does not return the cleanup sentinel", async () => {
    registerSandboxScenario({
      sandboxExecResult: null,
      sshFallbackResult: { status: 0, stdout: "NEMOCLAW_CHANNEL_CLEAR_OK", stderr: "" },
    });

    await expect(
      removeSandboxChannel(SANDBOX_NAME, { channel: "whatsapp" }),
    ).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(sandboxExecSpy).toHaveBeenCalledTimes(1);
    expect(sandboxSshSpy).toHaveBeenCalledTimes(1);
    expectRemovedPreset("whatsapp");
    expect(logSpy.mock.calls.flat().map(String)).toContainEqual(
      expect.stringContaining("Change queued"),
    );
  });

  it("aborts before policy and registry changes when both QR cleanup transports fail", async () => {
    const original = registerSandboxScenario({
      sandboxExecResult: { status: 1, stdout: "", stderr: "sandbox is not running" },
      sshFallbackResult: {
        status: 255,
        stdout: "",
        stderr: "ssh: connect to host failed",
      },
    });

    await expect(removeSandboxChannel(SANDBOX_NAME, { channel: "whatsapp" })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(sandboxExecSpy).toHaveBeenCalledTimes(1);
    expect(sandboxSshSpy).toHaveBeenCalledTimes(1);
    expect(String(sandboxSshSpy.mock.calls[0]?.[1] ?? "")).toContain("rm -rf");
    expect(removePresetSpy).not.toHaveBeenCalled();
    expect(registry.getSandbox(SANDBOX_NAME)).toEqual(original);
    expect(logSpy.mock.calls.flat().map(String)).not.toContainEqual(
      expect.stringContaining("Change queued"),
    );
  });

  it("keeps a never-configured QR removal inert for a legacy no-receipt sandbox", async () => {
    registerSandboxScenario({
      presetNamesApplied: ["npm", "pypi"],
      agent: "openclaw",
      channelInRegistry: "telegram",
      receiptBacked: false,
      sandboxExecResult: { status: 1, stdout: "", stderr: "sandbox is not running" },
      sshFallbackResult: {
        status: 255,
        stdout: "",
        stderr: "ssh: connect to host failed",
      },
    });

    await expect(
      removeSandboxChannel(SANDBOX_NAME, { channel: "whatsapp" }),
    ).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(sandboxExecSpy).not.toHaveBeenCalled();
    expect(sandboxSshSpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().map(String)).toContainEqual(
      expect.stringContaining("Change queued"),
    );
  });

  it("removes the live preset and persists a token-channel removal tombstone", async () => {
    registerSandboxScenario({
      presetNamesApplied: ["npm", "pypi", "telegram", "brew"],
      agent: "openclaw",
      channelInRegistry: "telegram",
    });
    process.env.TELEGRAM_BOT_TOKEN = "stub";

    await expect(
      removeSandboxChannel(SANDBOX_NAME, { channel: "telegram" }),
    ).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
    expectRemovedPreset("telegram");
    expect(registeredMessagingChannels()).toEqual([
      expect.objectContaining({
        channelId: "telegram",
        active: false,
        selected: false,
        configured: false,
        disabled: true,
        pendingRemoval: true,
      }),
    ]);
  });

  it("detaches and deletes only an exact receipt-owned static provider", async () => {
    registerSandboxScenario({
      presetNamesApplied: ["npm", "pypi", "telegram"],
      agent: "openclaw",
      channelInRegistry: "telegram",
    });
    installLiveProvider("telegram");

    await expect(
      removeSandboxChannel(SANDBOX_NAME, { channel: "telegram" }),
    ).resolves.toBeUndefined();

    expect(policyChannelDependencies.inspectMessagingProviderBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialKey: "TELEGRAM_BOT_TOKEN",
        credentialShape: "only",
        name: "test-sb-telegram-bridge",
      }),
      "nemoclaw",
    );
    expect(policyChannelDependencies.cleanupMessagingProviders).toHaveBeenCalledWith(
      ["test-sb-telegram-bridge"],
      SANDBOX_NAME,
      "nemoclaw",
      expect.any(Function),
      {
        expectedProviderIds: {
          "test-sb-telegram-bridge": "telegram-provider-id",
        },
        detachOnlyProviderNames: [],
      },
    );
  });

  it.each([
    ["colliding", { kind: "collision" }],
    ["indeterminate", { kind: "indeterminate", message: "gateway unavailable" }],
  ] as const)(
    "refuses a %s receipt-owned provider before changing channel state",
    async (_description, inspection) => {
      process.env.TELEGRAM_BOT_TOKEN = "test-token-that-must-remain";
      const original = registerSandboxScenario({
        presetNamesApplied: ["npm", "pypi", "telegram"],
        agent: "openclaw",
        channelInRegistry: "telegram",
      });
      vi.mocked(policyChannelDependencies.inspectMessagingProviderBinding).mockReturnValue(
        inspection,
      );

      await expect(removeSandboxChannel(SANDBOX_NAME, { channel: "telegram" })).rejects.toThrow(
        "process.exit(1)",
      );

      expect(policyChannelDependencies.inspectMessagingProviderBinding).toHaveBeenCalledWith(
        expect.objectContaining({ credentialShape: "only" }),
        "nemoclaw",
      );
      expect(sandboxExecSpy).not.toHaveBeenCalled();
      expect(setPolicyDocumentSpy).not.toHaveBeenCalled();
      expect(policyChannelDependencies.cleanupMessagingProviders).not.toHaveBeenCalled();
      expect(registry.getSandbox(SANDBOX_NAME)).toEqual(original);
      expect(process.env.TELEGRAM_BOT_TOKEN).toBe("test-token-that-must-remain");
    },
  );

  it("refuses provider teardown when the live sandbox identity drifts", async () => {
    const original = registerSandboxScenario({
      presetNamesApplied: ["npm", "pypi", "telegram"],
      agent: "openclaw",
      channelInRegistry: "telegram",
    });
    vi.mocked(policyChannelDependencies.inspectMessagingProviderAttachmentTarget)
      .mockReturnValueOnce(LIVE_SANDBOX_FINGERPRINT)
      .mockReturnValue("0".repeat(64));

    await expect(removeSandboxChannel(SANDBOX_NAME, { channel: "telegram" })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(policyChannelDependencies.inspectMessagingProviderBinding).not.toHaveBeenCalled();
    expect(setPolicyDocumentSpy).not.toHaveBeenCalled();
    expect(policyChannelDependencies.cleanupMessagingProviders).not.toHaveBeenCalled();
    expect(registry.getSandbox(SANDBOX_NAME)).toEqual(original);
  });
});
