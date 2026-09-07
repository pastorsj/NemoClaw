// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Regression: stageMessagingManifestPlanForRebuild() must clear any stale
// NEMOCLAW_MESSAGING_PLAN_B64 and skip planning for agents unsupported by
// channel manifests, so a non-messaging sandbox rebuild cannot
// carry messaging-plan state into the Dockerfile patch step.
//
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentDefinition } from "../../agent/defs";
import { MessagingSetupApplier } from "../../messaging/applier/setup-applier";
import type { SandboxMessagingPlan } from "../../messaging/manifest";
import type { SandboxMessagingProfileAuthority } from "../../messaging/profile-authority";
import type { ResolvedSandboxAgent } from "../../onboard/sandbox-agent";
import { hashCredential } from "../../security/credential-hash";
import type { SandboxEntry } from "../../state/registry";
import { stageRebuildMessagingPlanOrBail } from "./rebuild-messaging-phase";
import { stageMessagingManifestPlanForRebuild } from "./rebuild-messaging-stage";

const emptyStoredMessagingPlan = {
  schemaVersion: 1,
  sandboxName: "openclaw-sandbox",
  agent: "openclaw",
  workflow: "remove-channel",
  channels: [],
  disabledChannels: [],
  credentialBindings: [],
  networkPolicy: { presets: [], entries: [] },
  agentRender: [],
  buildSteps: [],
  stateUpdates: [],
  healthChecks: [],
} satisfies SandboxMessagingPlan;

function pinnedAgent(name: string): AgentDefinition {
  return { name, packageRoot: `/pinned/${name}` } as AgentDefinition;
}

const OPENCLAW_PACKAGE = {
  kind: "agent-runtime",
  id: "openclaw",
  packageVersion: "1.0.0",
  contentDigest: "a".repeat(64),
} as const;

const OPENCLAW_PACKAGE_MIGRATION = {
  schemaVersion: 1,
  source: "legacy-current-bundle",
  legacyAgent: null,
  migratedAt: "2026-09-07T00:00:00.000Z",
} as const;

const OPENCLAW_AUTHORITY = {
  recordedAgent: null,
  effectiveAgentId: "openclaw",
  definition: pinnedAgent("openclaw"),
  harnessPackage: OPENCLAW_PACKAGE,
  harnessPackageMigration: null,
} satisfies ResolvedSandboxAgent;

const MIGRATED_OPENCLAW_AUTHORITY = {
  ...OPENCLAW_AUTHORITY,
  harnessPackageMigration: OPENCLAW_PACKAGE_MIGRATION,
} satisfies ResolvedSandboxAgent;

const receiptTelegramPlan = {
  ...emptyStoredMessagingPlan,
  channels: [
    {
      channelId: "telegram",
      displayName: "Telegram",
      authMode: "token-paste",
      active: true,
      selected: true,
      configured: true,
      disabled: false,
      inputs: [{ inputId: "botToken", credentialAvailable: true }],
      hooks: [],
    },
  ],
  packageBuild: {
    configRoot: "~/.source-openclaw",
    packageManagers: [],
  },
} as unknown as SandboxMessagingPlan;

function exactReceiptMessagingProfile(): SandboxMessagingProfileAuthority {
  return {
    agent: OPENCLAW_AUTHORITY.definition,
    packageAuthority: OPENCLAW_AUTHORITY,
    integration: {
      kind: "channels",
      packageId: "openclaw",
      build: {
        configRoot: "~/.receipt-openclaw",
        packageManagers: [],
      },
      channels: [
        {
          channelId: "telegram",
          config: {
            visibility: [],
            renders: [
              {
                id: "receipt-telegram-render",
                kind: "json-fragment",
                target: "~/.receipt-openclaw/receipt.json",
                path: "channels.telegram",
                value: { enabled: true },
              },
            ],
          },
          policy: [],
          lifecycle: { hookIds: [] },
        },
      ],
    },
  };
}

function exactMigratedMessagingProfile(): SandboxMessagingProfileAuthority {
  return {
    agent: MIGRATED_OPENCLAW_AUTHORITY.definition,
    packageAuthority: MIGRATED_OPENCLAW_AUTHORITY,
    integration: {
      kind: "channels",
      packageId: "openclaw",
      build: {
        configRoot: "~/.receipt-openclaw",
        packageManagers: [],
      },
      channels: [
        {
          channelId: "telegram",
          config: {
            visibility: [],
            renders: [
              {
                id: "receipt-telegram-render",
                kind: "json-fragment",
                target: "~/.receipt-openclaw/receipt.json",
                path: "channels.telegram",
                value: { enabled: true },
              },
            ],
          },
          policy: [
            {
              presetName: "package-telegram-egress",
              policyKeys: ["package_telegram_bot"],
              requiredAtCreate: true,
            },
          ],
          lifecycle: { hookIds: [] },
        },
        {
          channelId: "wechat",
          config: {
            visibility: [],
            renders: [
              {
                id: "receipt-wechat-render",
                kind: "json-fragment",
                target: "~/.receipt-openclaw/receipt.json",
                path: "channels.wechat",
                value: { enabled: true },
              },
            ],
          },
          policy: [
            {
              presetName: "package-wechat-egress",
              policyKeys: ["package_wechat_bridge"],
              requiredAtCreate: true,
            },
          ],
          lifecycle: { hookIds: [] },
        },
      ],
    },
  };
}

describe("stageMessagingManifestPlanForRebuild non-messaging agent guard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("emits the skip message for any agent whose name is not supported by channel manifests", async () => {
    const clearPlanEnvSpy = vi.spyOn(MessagingSetupApplier, "clearPlanEnv");
    const agent = pinnedAgent("future-non-messaging-agent");

    const messages: string[] = [];
    const result = await stageMessagingManifestPlanForRebuild(
      "future-sandbox",
      { name: "future-sandbox" },
      agent,
      (msg) => messages.push(msg),
    );

    expect(clearPlanEnvSpy).toHaveBeenCalledTimes(1);
    expect(messages).toContain(
      "Messaging manifest rebuild plan skipped: agent 'future-non-messaging-agent' is not supported by any channel manifest",
    );
    expect(messages.some((msg) => msg.includes("has no supported messaging channels"))).toBe(false);
    expect(result).toBeNull();
  });

  it("stages an explicit empty rebuild plan so token-backed channels are not rediscovered", async () => {
    const clearPlanEnvSpy = vi.spyOn(MessagingSetupApplier, "clearPlanEnv");
    const writePlanEnvSpy = vi
      .spyOn(MessagingSetupApplier, "writePlanToEnv")
      .mockImplementation(() => undefined);

    const messages: string[] = [];
    const result = await stageMessagingManifestPlanForRebuild(
      "openclaw-sandbox",
      {
        name: "openclaw-sandbox",
        messaging: { schemaVersion: 1, plan: emptyStoredMessagingPlan },
      },
      pinnedAgent("openclaw"),
      (msg) => messages.push(msg),
    );

    expect(clearPlanEnvSpy).not.toHaveBeenCalled();
    expect(writePlanEnvSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: "rebuild",
        channels: [],
      }),
    );
    expect(messages).toContain("Messaging manifest rebuild plan staged: no configured channels");
    expect(result).toMatchObject({ workflow: "rebuild", channels: [] });
  });

  it("stages a plan for a known agent using channel-manifest supported channels", async () => {
    const clearPlanEnvSpy = vi.spyOn(MessagingSetupApplier, "clearPlanEnv");
    const writePlanEnvSpy = vi.spyOn(MessagingSetupApplier, "writePlanToEnv");

    const sandboxEntryWithStoredPlan = {
      name: "openclaw-sandbox",
      messaging: {
        schemaVersion: 1,
        plan: {
          schemaVersion: 1,
          sandboxName: "openclaw-sandbox",
          agent: "openclaw",
          workflow: "rebuild",
          channels: [
            {
              channelId: "telegram",
              displayName: "telegram",
              authMode: "token-paste",
              active: true,
              selected: true,
              configured: true,
              disabled: false,
              inputs: [],
              hooks: [],
            },
          ],
          disabledChannels: [],
          credentialBindings: [],
          networkPolicy: { presets: [], entries: [] },
          agentRender: [],
          buildSteps: [],
          stateUpdates: [],
          healthChecks: [],
        },
      },
    } satisfies SandboxEntry;

    const messages: string[] = [];
    const result = await stageMessagingManifestPlanForRebuild(
      "openclaw-sandbox",
      sandboxEntryWithStoredPlan,
      pinnedAgent("openclaw"),
      (msg) => messages.push(msg),
    );

    expect(clearPlanEnvSpy).not.toHaveBeenCalled();
    expect(writePlanEnvSpy).toHaveBeenCalledTimes(1);
    expect(messages).toContain("Messaging manifest rebuild plan staged: telegram");
    expect(result).not.toBeNull();
  });

  it("uses same-ID receipt profile content instead of source catalogue content", async () => {
    const writePlanEnvSpy = vi
      .spyOn(MessagingSetupApplier, "writePlanToEnv")
      .mockImplementation(() => undefined);
    const resolveProfile = vi.fn(() => exactReceiptMessagingProfile());

    const driftedCredentialPlan = {
      ...receiptTelegramPlan,
      channels: [
        {
          ...receiptTelegramPlan.channels[0],
          credentialProvider: {
            profilePath: "provider-profiles/legacy-provider.yaml",
            profileId: "legacy-provider",
            credentialEnv: "LEGACY_TELEGRAM_TOKEN",
            sourceInputId: "botToken",
            sourceSecretEnv: "LEGACY_TELEGRAM_TOKEN",
          },
        },
      ],
      credentialBindings: [
        {
          channelId: "telegram",
          credentialId: "legacyTelegramToken",
          sourceInput: "botToken",
          providerName: "legacy-provider",
          providerEnvKey: "LEGACY_TELEGRAM_TOKEN",
          placeholder: "legacy-placeholder",
          credentialAvailable: true,
          credentialHash: "c".repeat(64),
        },
      ],
    } satisfies SandboxMessagingPlan;
    const result = await stageMessagingManifestPlanForRebuild(
      "openclaw-sandbox",
      {
        name: "openclaw-sandbox",
        agent: null,
        harnessPackage: OPENCLAW_PACKAGE,
        messaging: { schemaVersion: 1, plan: driftedCredentialPlan },
      },
      OPENCLAW_AUTHORITY.definition,
      vi.fn(),
      {
        agentAuthority: OPENCLAW_AUTHORITY,
        resolveMessagingProfileAuthority: resolveProfile,
      },
    );

    expect(resolveProfile).toHaveBeenCalledWith(OPENCLAW_AUTHORITY);
    expect(result?.packageBuild?.configRoot).toBe("~/.receipt-openclaw");
    expect(result?.agentRender).toContainEqual(
      expect.objectContaining({
        renderId: "receipt-telegram-render",
        target: "~/.receipt-openclaw/receipt.json",
      }),
    );
    expect(result?.agentRender.some((render) => render.target.includes("~/.openclaw/"))).toBe(
      false,
    );
    expect(result?.credentialBindings).toEqual([
      expect.objectContaining({
        credentialId: "telegramBotToken",
        providerName: "openclaw-sandbox-telegram-bridge",
        providerEnvKey: "TELEGRAM_BOT_TOKEN",
        placeholder: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
        credentialAvailable: true,
        credentialHash: "c".repeat(64),
      }),
    ]);
    expect(result?.channels[0]).not.toHaveProperty("credentialProvider");
    expect(writePlanEnvSpy).toHaveBeenCalledWith(result);
  });

  it("restores a migrated session-only WeChat channel through the pinned package profile", async () => {
    vi.stubEnv("WECHAT_ACCOUNT_ID", "legacy-account");
    const writePlanEnvSpy = vi
      .spyOn(MessagingSetupApplier, "writePlanToEnv")
      .mockImplementation(() => undefined);
    const log = vi.fn();

    const result = await stageMessagingManifestPlanForRebuild(
      "openclaw-sandbox",
      {
        name: "openclaw-sandbox",
        agent: null,
        harnessPackage: OPENCLAW_PACKAGE,
        harnessPackageMigration: OPENCLAW_PACKAGE_MIGRATION,
      },
      MIGRATED_OPENCLAW_AUTHORITY.definition,
      log,
      {
        agentAuthority: MIGRATED_OPENCLAW_AUTHORITY,
        legacyMessagingConfig: {
          WECHAT_ACCOUNT_ID: "legacy-account",
        },
        legacyCredentialHashes: { WECHAT_BOT_TOKEN: "a".repeat(64) },
        resolveMessagingProfileAuthority: () => exactMigratedMessagingProfile(),
      },
    );

    expect(result?.channels).toContainEqual(
      expect.objectContaining({ channelId: "wechat", active: true, disabled: false }),
    );
    expect(result?.channels[0]?.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ inputId: "botToken", credentialAvailable: true }),
        expect.objectContaining({ inputId: "accountId", value: "legacy-account" }),
      ]),
    );
    expect(
      result?.channels[0]?.inputs.find((input) => input.inputId === "baseUrl"),
    ).not.toHaveProperty("value");
    expect(result?.networkPolicy.entries).toEqual([
      {
        channelId: "wechat",
        presetName: "package-wechat-egress",
        policyKeys: ["package_wechat_bridge"],
        source: "manifest",
      },
    ]);
    expect(result?.credentialBindings[0]?.credentialHash).toBe("a".repeat(64));
    expect(result?.agentRender).toContainEqual(
      expect.objectContaining({ renderId: "receipt-wechat-render" }),
    );
    expect(result?.packageBuild?.configRoot).toBe("~/.receipt-openclaw");
    expect(writePlanEnvSpy).toHaveBeenCalledWith(result);
    expect(log).toHaveBeenCalledWith(
      "Messaging manifest rebuild plan restored from legacy session state",
    );
  });

  it.each([
    {
      name: "Telegram only",
      legacyMessagingConfig: { TELEGRAM_REQUIRE_MENTION: "0", WECHAT_ACCOUNT_ID: "" },
      expectedChannelIds: ["telegram"],
      expectedPolicyKeys: ["package_telegram_bot"],
      legacyCredentialHashes: {
        TELEGRAM_BOT_TOKEN: "b".repeat(64),
        WECHAT_BOT_TOKEN: "",
      },
    },
    {
      name: "coexisting Telegram and WeChat",
      legacyMessagingConfig: {
        TELEGRAM_REQUIRE_MENTION: "1",
        WECHAT_ACCOUNT_ID: "legacy-account",
      },
      expectedChannelIds: ["telegram", "wechat"],
      expectedPolicyKeys: ["package_telegram_bot", "package_wechat_bridge"],
      legacyCredentialHashes: {
        TELEGRAM_BOT_TOKEN: "b".repeat(64),
        WECHAT_BOT_TOKEN: "a".repeat(64),
      },
    },
  ])("restores $name legacy state through exact package manifests", async (testCase) => {
    vi.stubEnv("TELEGRAM_REQUIRE_MENTION", testCase.legacyMessagingConfig.TELEGRAM_REQUIRE_MENTION);
    vi.stubEnv("WECHAT_ACCOUNT_ID", testCase.legacyMessagingConfig.WECHAT_ACCOUNT_ID);
    const result = await stageMessagingManifestPlanForRebuild(
      "openclaw-sandbox",
      {
        name: "openclaw-sandbox",
        agent: null,
        harnessPackage: OPENCLAW_PACKAGE,
        harnessPackageMigration: OPENCLAW_PACKAGE_MIGRATION,
      },
      MIGRATED_OPENCLAW_AUTHORITY.definition,
      vi.fn(),
      {
        agentAuthority: MIGRATED_OPENCLAW_AUTHORITY,
        legacyCredentialHashes: testCase.legacyCredentialHashes,
        legacyMessagingConfig: testCase.legacyMessagingConfig,
        resolveMessagingProfileAuthority: () => exactMigratedMessagingProfile(),
      },
    );

    expect(result?.channels.map((channel) => channel.channelId)).toEqual(
      testCase.expectedChannelIds,
    );
    expect(result?.networkPolicy.entries.flatMap((entry) => entry.policyKeys)).toEqual(
      testCase.expectedPolicyKeys,
    );
  });

  it("uses a validated current credential hash instead of stale migration provenance", async () => {
    const currentToken = "123456:rotated-telegram-token";
    vi.stubEnv("TELEGRAM_BOT_TOKEN", currentToken);

    const result = await stageMessagingManifestPlanForRebuild(
      "openclaw-sandbox",
      {
        name: "openclaw-sandbox",
        agent: null,
        harnessPackage: OPENCLAW_PACKAGE,
        harnessPackageMigration: OPENCLAW_PACKAGE_MIGRATION,
      },
      MIGRATED_OPENCLAW_AUTHORITY.definition,
      vi.fn(),
      {
        agentAuthority: MIGRATED_OPENCLAW_AUTHORITY,
        legacyCredentialHashes: { TELEGRAM_BOT_TOKEN: "b".repeat(64) },
        legacyMessagingConfig: { TELEGRAM_REQUIRE_MENTION: "1" },
        resolveMessagingProfileAuthority: () => exactMigratedMessagingProfile(),
      },
    );

    expect(result?.credentialBindings[0]?.credentialHash).toBe(hashCredential(currentToken));
  });

  it("rejects migrated messaging without a current credential or stored credential hash", async () => {
    await expect(
      stageMessagingManifestPlanForRebuild(
        "openclaw-sandbox",
        {
          name: "openclaw-sandbox",
          agent: null,
          harnessPackage: OPENCLAW_PACKAGE,
          harnessPackageMigration: OPENCLAW_PACKAGE_MIGRATION,
        },
        MIGRATED_OPENCLAW_AUTHORITY.definition,
        vi.fn(),
        {
          agentAuthority: MIGRATED_OPENCLAW_AUTHORITY,
          legacyMessagingConfig: { TELEGRAM_REQUIRE_MENTION: "1" },
          resolveMessagingProfileAuthority: () => exactMigratedMessagingProfile(),
        },
      ),
    ).rejects.toThrow("cannot prove its legacy 'telegram' credential");
  });

  it.each([
    [
      "malformed",
      {} as SandboxMessagingPlan,
      "could not be reconstructed from its exact package manifests",
    ],
    [
      "unsupported-channel",
      {
        ...receiptTelegramPlan,
        channels: [
          {
            ...receiptTelegramPlan.channels[0],
            channelId: "discord",
            displayName: "Discord",
          },
        ],
      } as SandboxMessagingPlan,
      "channel is missing from its exact composed manifests",
    ],
  ])("rejects %s persisted package messaging authority", async (_name, plan, expected) => {
    const clearPlanEnvSpy = vi.spyOn(MessagingSetupApplier, "clearPlanEnv");
    const writePlanEnvSpy = vi.spyOn(MessagingSetupApplier, "writePlanToEnv");
    const log = vi.fn();
    const sandboxEntry = {
      name: "openclaw-sandbox",
      agent: null,
      harnessPackage: OPENCLAW_PACKAGE,
      harnessPackageMigration: OPENCLAW_PACKAGE_MIGRATION,
      messaging: { schemaVersion: 1, plan },
    } satisfies SandboxEntry;

    await expect(
      stageMessagingManifestPlanForRebuild(
        "openclaw-sandbox",
        sandboxEntry,
        MIGRATED_OPENCLAW_AUTHORITY.definition,
        log,
        {
          agentAuthority: MIGRATED_OPENCLAW_AUTHORITY,
          resolveMessagingProfileAuthority: () => exactMigratedMessagingProfile(),
        },
      ),
    ).rejects.toThrow(expected);

    expect(clearPlanEnvSpy).not.toHaveBeenCalled();
    expect(writePlanEnvSpy).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalledWith(
      "Messaging manifest rebuild plan restored from legacy session state",
    );
  });

  it("fails closed when a receipt-backed staging caller omits package authority", async () => {
    const writePlanEnvSpy = vi.spyOn(MessagingSetupApplier, "writePlanToEnv");

    await expect(
      stageMessagingManifestPlanForRebuild(
        "openclaw-sandbox",
        {
          name: "openclaw-sandbox",
          agent: null,
          harnessPackage: OPENCLAW_PACKAGE,
          messaging: { schemaVersion: 1, plan: receiptTelegramPlan },
        },
        OPENCLAW_AUTHORITY.definition,
        vi.fn(),
      ),
    ).rejects.toThrow("Receipt-backed messaging rebuild requires exact pinned package authority");
    expect(writePlanEnvSpy).not.toHaveBeenCalled();
  });

  it("fails closed when the resolved messaging profile mismatches package authority", async () => {
    const mismatchedAuthority = {
      ...OPENCLAW_AUTHORITY,
      harnessPackage: { ...OPENCLAW_PACKAGE, packageVersion: "2.0.0" },
    } satisfies ResolvedSandboxAgent;
    const mismatchedProfile = {
      ...exactReceiptMessagingProfile(),
      packageAuthority: mismatchedAuthority,
    } satisfies SandboxMessagingProfileAuthority;
    const writePlanEnvSpy = vi.spyOn(MessagingSetupApplier, "writePlanToEnv");

    await expect(
      stageMessagingManifestPlanForRebuild(
        "openclaw-sandbox",
        {
          name: "openclaw-sandbox",
          agent: null,
          harnessPackage: OPENCLAW_PACKAGE,
          messaging: { schemaVersion: 1, plan: receiptTelegramPlan },
        },
        OPENCLAW_AUTHORITY.definition,
        vi.fn(),
        {
          agentAuthority: OPENCLAW_AUTHORITY,
          resolveMessagingProfileAuthority: () => mismatchedProfile,
        },
      ),
    ).rejects.toThrow("Receipt-backed messaging profile does not match pinned package authority");
    expect(writePlanEnvSpy).not.toHaveBeenCalled();
  });
});

describe("stageRebuildMessagingPlanOrBail agent authority", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects package authority drift before staging messaging state", async () => {
    const sandboxEntry = {
      name: "openclaw-sandbox",
      agent: null,
      harnessPackage: OPENCLAW_PACKAGE,
    } satisfies SandboxEntry;
    const bail = (message: string): never => {
      throw new Error(message);
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      stageRebuildMessagingPlanOrBail(
        "openclaw-sandbox",
        sandboxEntry,
        {
          ...OPENCLAW_AUTHORITY,
          harnessPackage: { ...OPENCLAW_PACKAGE, packageVersion: "1.0.1" },
        },
        vi.fn(),
        bail,
      ),
    ).rejects.toThrow("Pinned rebuild agent authority does not match messaging registry state.");
  });

  it("rejects absent package authority for a standard agent", async () => {
    const bail = (message: string): never => {
      throw new Error(message);
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      stageRebuildMessagingPlanOrBail(
        "openclaw-sandbox",
        { name: "openclaw-sandbox", agent: null },
        { ...OPENCLAW_AUTHORITY, harnessPackage: null },
        vi.fn(),
        bail,
      ),
    ).rejects.toThrow("Pinned rebuild agent authority does not match messaging registry state.");
  });

  it("rejects a standard package whose id does not name the effective agent", async () => {
    const wrongPackage = { ...OPENCLAW_PACKAGE, id: "hermes" } as const;
    const bail = (message: string): never => {
      throw new Error(message);
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      stageRebuildMessagingPlanOrBail(
        "openclaw-sandbox",
        { name: "openclaw-sandbox", agent: null, harnessPackage: wrongPackage },
        { ...OPENCLAW_AUTHORITY, harnessPackage: wrongPackage },
        vi.fn(),
        bail,
      ),
    ).rejects.toThrow("Pinned rebuild agent authority does not match messaging registry state.");
  });

  it("rejects a pinned definition whose name does not match its effective agent", async () => {
    const bail = (message: string): never => {
      throw new Error(message);
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      stageRebuildMessagingPlanOrBail(
        "openclaw-sandbox",
        {
          name: "openclaw-sandbox",
          agent: null,
          harnessPackage: OPENCLAW_PACKAGE,
        },
        { ...OPENCLAW_AUTHORITY, definition: pinnedAgent("hermes") },
        vi.fn(),
        bail,
      ),
    ).rejects.toThrow("Pinned rebuild agent authority does not match messaging registry state.");
  });

  it("preserves qualified NemoCUA messaging staging without fabricated package authority", async () => {
    const agentId = "nemocua";
    const clearPlanEnvSpy = vi.spyOn(MessagingSetupApplier, "clearPlanEnv");
    const result = await stageRebuildMessagingPlanOrBail(
      `${agentId}-sandbox`,
      { name: `${agentId}-sandbox`, agent: agentId },
      {
        recordedAgent: agentId,
        effectiveAgentId: agentId,
        definition: pinnedAgent(agentId),
        harnessPackage: null,
        harnessPackageMigration: null,
      },
      vi.fn(),
      (message): never => {
        throw new Error(message);
      },
    );

    expect(result).toBeNull();
    expect(clearPlanEnvSpy).toHaveBeenCalledOnce();
  });
});
