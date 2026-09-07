// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression test for #3998. Channel removal must clear durable QR-pairing state before it
// changes policy or persists the removal tombstone. These integration tests use real installed
// harness-package receipts and the isolated Vitest registry. Only OpenShell/process boundaries
// are replaced, so package messaging authority and registry persistence remain production code.

import path from "node:path";

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
import type { MessagingAgentId, SandboxMessagingPlan } from "../../src/lib/messaging";
import * as policies from "../../src/lib/policy";
import * as registry from "../../src/lib/state/registry";
import type { SandboxEntry } from "../../src/lib/state/registry/types";
import {
  createHarnessPackageFixture,
  type HarnessPackageFixture,
} from "../helpers/harness-packages";
import { restoreEnv } from "../helpers/env-test-helpers";
import { makeMessagingPlan } from "../helpers/messaging-plan-fixtures";

const SANDBOX_NAME = "test-sb";
const MESSAGING_ENV_PREFIXES = [
  "TELEGRAM_",
  "DISCORD_",
  "SLACK_",
  "WECHAT_",
  "WEIXIN_",
  "WHATSAPP_",
];

type AgentUnderTest = Extract<MessagingAgentId, "openclaw" | "hermes">;
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
let previousNonInteractive: string | undefined;
let removedMessagingEnvironment = new Map<string, string>();

let exitSpy: MockInstance;
let logSpy: MockInstance;
let errorSpy: MockInstance;
let listPresetsSpy: MockInstance;
let getAppliedPresetsSpy: MockInstance;
let removePresetSpy: MockInstance;
let sandboxExecSpy: MockInstance;
let sandboxSshSpy: MockInstance;
let stoppedCleanupSpy: MockInstance;

function buildStoredMessagingPlan(
  agent: AgentUnderTest,
  channelInRegistry: string,
): SandboxMessagingPlan {
  const plan = makeMessagingPlan({
    sandboxName: SANDBOX_NAME,
    agent,
    channels: channelInRegistry ? [channelInRegistry] : [],
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

function registerSandboxScenario({
  presetNamesApplied = ["npm", "pypi", "huggingface", "brew", "whatsapp"],
  agent = "openclaw",
  channelInRegistry = "whatsapp",
  receiptBacked = true,
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
  readonly sandboxExecResult?: SandboxCommandResult | null;
  readonly sshFallbackResult?: SandboxCommandResult | null;
  readonly stoppedDockerCleanupResult?: StoppedCleanupResult;
} = {}): SandboxEntry {
  listPresetsSpy.mockReturnValue(
    presetNamesApplied.map((name) => ({ file: `${name}.yaml`, name, description: "test preset" })),
  );
  getAppliedPresetsSpy.mockReturnValue([...presetNamesApplied]);
  sandboxExecSpy.mockReturnValue(sandboxExecResult);
  sandboxSshSpy.mockReturnValue(sshFallbackResult);
  stoppedCleanupSpy.mockReturnValue(stoppedDockerCleanupResult);

  registry.registerSandbox({
    name: SANDBOX_NAME,
    agent,
    ...(receiptBacked ? { harnessPackage: packageIdentities[agent] } : {}),
    messaging: {
      schemaVersion: 1,
      plan: buildStoredMessagingPlan(agent, channelInRegistry),
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
  expect(removePresetSpy).toHaveBeenCalledTimes(1);
  expect(removePresetSpy).toHaveBeenCalledWith(SANDBOX_NAME, channelId);
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
  packageFixtures = [openclawFixture, hermesFixture];
  packageIdentities = {
    openclaw: openclawFixture.install("openclaw").identity,
    hermes: hermesFixture.install("hermes").identity,
  };
});

beforeEach(() => {
  registry.clearAll();
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
  sandboxExecSpy = vi.spyOn(processRecovery, "executeSandboxExecCommand");
  sandboxSshSpy = vi.spyOn(processRecovery, "executeSandboxCommand");
  stoppedCleanupSpy = vi.spyOn(policyChannelDependencies, "clearStoppedSandboxStateRoots");
  vi.spyOn(policyChannelDependencies, "runOpenshell").mockReturnValue({
    status: 0,
    stdout: "",
    stderr: "",
  } as never);
  vi.spyOn(policyChannelDependencies, "runGatewayOpenshell").mockReturnValue({
    status: 0,
    stdout: "",
    stderr: "",
  } as never);
  vi.spyOn(policyChannelDependencies, "deleteMessagingProviderWithRecovery").mockReturnValue({
    ok: true,
    status: 0,
    stdout: "",
    stderr: "",
  } as never);
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
});
