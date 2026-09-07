// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { makeAgent } from "../../../../test/helpers/base-image-test-harness";
import type { SandboxMessagingPlan } from "../../messaging/manifest";
import type { ResolvedSandboxAgent } from "../../onboard/sandbox-agent";
import { createSession } from "../../state/onboard-session";
import {
  authorizeLegacyMessagingFallbackSession,
  preflightRebuildMessagingPolicyAuthority,
  preflightRebuildMessagingProviderAuthority,
} from "./rebuild-messaging-phase";
import { restoreEnvBulk } from "../../../../test/helpers/env-test-helpers";
import type {
  ProviderRecoveryReceipt,
  RegistryInferenceRoute,
} from "../../onboard/rebuild-route-handoff";
import type { SandboxBaseImageResolutionMetadata } from "../../sandbox-base-image";
import {
  pinRebuildTargetGatewayForReadiness,
  resolveRebuildMcpRuntimeSelection,
  runRebuildGatewayRecoveryAfterReadiness,
  stageRebuildBaseImageResolutionHandoff,
  stageRegistryProviderRecoveryReceipt,
} from "./rebuild-preflight-target-phase";

const originalOpenShellEnv = {
  OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY,
  OPENSHELL_GATEWAY_ENDPOINT: process.env.OPENSHELL_GATEWAY_ENDPOINT,
  OPENSHELL_LOCAL_TLS_DIR: process.env.OPENSHELL_LOCAL_TLS_DIR,
  OPENSHELL_TOKEN: process.env.OPENSHELL_TOKEN,
  OPENSHELL_WORKSPACE: process.env.OPENSHELL_WORKSPACE,
};

const mocks = vi.hoisted(() => ({
  runOpenshell: vi.fn(),
}));

vi.mock("../../adapters/openshell/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/openshell/runtime")>()),
  runOpenshell: mocks.runOpenshell,
}));

afterEach(() => {
  mocks.runOpenshell.mockReset();
  restoreEnvBulk(originalOpenShellEnv);
});

describe("receipt-backed rebuild messaging policy authority", () => {
  const migratedOpenClawAuthority = {
    recordedAgent: null,
    effectiveAgentId: "openclaw",
    definition: makeAgent({ name: "openclaw" }),
    harnessPackage: {
      kind: "agent-runtime",
      id: "openclaw",
      packageVersion: "1.0.0",
      contentDigest: "a".repeat(64),
    },
    harnessPackageMigration: {
      schemaVersion: 1,
      source: "legacy-current-bundle",
      legacyAgent: null,
      migratedAt: "2026-09-07T00:00:00.000Z",
    },
  } satisfies ResolvedSandboxAgent;

  it("admits same-sandbox legacy messaging state for the migrated agent", () => {
    const session = createSession({
      agent: null,
      sandboxName: "alpha",
      telegramConfig: { requireMention: true },
      migratedLegacyValueHashes: { TELEGRAM_BOT_TOKEN: "b".repeat(64) },
    });

    expect(
      authorizeLegacyMessagingFallbackSession("alpha", session, migratedOpenClawAuthority),
    ).toBe(session);
  });

  it("rejects same-sandbox legacy messaging state from another agent", () => {
    const session = createSession({
      agent: "hermes",
      sandboxName: "alpha",
      telegramConfig: { requireMention: true },
      migratedLegacyValueHashes: { TELEGRAM_BOT_TOKEN: "b".repeat(64) },
    });

    expect(() =>
      authorizeLegacyMessagingFallbackSession("alpha", session, migratedOpenClawAuthority),
    ).toThrow("session agent does not match");
  });

  it("rejects same-sandbox legacy messaging state with a foreign package receipt", () => {
    const session = createSession({
      agent: null,
      sandboxName: "alpha",
      harnessPackage: {
        ...migratedOpenClawAuthority.harnessPackage,
        contentDigest: "b".repeat(64),
      },
      harnessPackageMigration: migratedOpenClawAuthority.harnessPackageMigration,
      telegramConfig: { requireMention: true },
      migratedLegacyValueHashes: { TELEGRAM_BOT_TOKEN: "b".repeat(64) },
    });

    expect(() =>
      authorizeLegacyMessagingFallbackSession("alpha", session, migratedOpenClawAuthority),
    ).toThrow("session package receipt does not match");
  });

  it.each([
    ["Telegram", { telegramConfig: { requireMention: false } }],
    ["WeChat required account", { wechatConfig: { accountId: "legacy-account" } }],
    ["WeChat optional endpoint", { wechatConfig: { baseUrl: "https://idc-3.weixin.qq.com" } }],
    ["WeChat optional user", { wechatConfig: { userId: "legacy-user" } }],
  ])("rejects legacy session-only %s state before mutation", (_label, sessionState) => {
    const definition = makeAgent({ name: "future-harness" });

    expect(() =>
      preflightRebuildMessagingPolicyAuthority({
        agentAuthority: {
          recordedAgent: "future-harness",
          effectiveAgentId: "future-harness",
          definition,
          harnessPackage: {
            kind: "agent-runtime",
            id: "future-harness",
            packageVersion: "1.0.0",
            contentDigest: "f".repeat(64),
          },
          harnessPackageMigration: null,
        },
        fallbackMessagingSession: createSession({
          sandboxName: "alpha",
          ...sessionState,
        }),
        messagingPlan: null,
        sandboxName: "alpha",
      }),
    ).toThrow("cannot use legacy messaging state");
  });

  it.each([
    {
      name: "exact",
      result: {
        status: 0,
        stdout:
          "Id: telegram-provider-id\nName: alpha-telegram-bridge\nType: nemoclaw-mcp-v1\nCredential keys: TELEGRAM_BOT_TOKEN\nConfig keys: <none>\n",
      },
      hostToken: undefined,
      expected: null,
      expectedProbeCount: 2,
    },
    {
      name: "missing",
      result: { status: 1, stderr: "provider 'alpha-telegram-bridge' not found" },
      hostToken: undefined,
      expected: "was not found",
      expectedProbeCount: 1,
    },
    {
      name: "collision",
      result: {
        status: 0,
        stdout:
          "Name: alpha-telegram-bridge\nType: generic\nCredential keys: TELEGRAM_BOT_TOKEN\nConfig keys: <none>\n",
      },
      hostToken: undefined,
      expected: "does not match its exact credential binding",
      expectedProbeCount: 1,
    },
    {
      name: "indeterminate",
      result: { status: 1, stderr: "gateway unavailable" },
      hostToken: undefined,
      expected: "could not be inspected",
      expectedProbeCount: 1,
    },
    {
      name: "repairable missing",
      result: { status: 1, stderr: "provider 'alpha-telegram-bridge' not found" },
      hostToken: "123456:replacement-telegram-token",
      expected: null,
      expectedProbeCount: 1,
    },
    {
      name: "colliding with a recoverable credential",
      result: {
        status: 0,
        stdout:
          "Name: alpha-telegram-bridge\nType: generic\nCredential keys: TELEGRAM_BOT_TOKEN\nConfig keys: <none>\n",
      },
      hostToken: "123456:replacement-telegram-token",
      expected: "does not match its exact credential binding",
      expectedProbeCount: 1,
    },
    {
      name: "indeterminate with a recoverable credential",
      result: { status: 1, stderr: "gateway unavailable" },
      hostToken: "123456:replacement-telegram-token",
      expected: "could not be inspected",
      expectedProbeCount: 1,
    },
  ])("classifies an $name receipt messaging provider before mutation", (testCase) => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", testCase.hostToken);
    mocks.runOpenshell.mockReturnValue(testCase.result);
    const definition = makeAgent({ name: "future-harness" });
    const authority = {
      recordedAgent: "future-harness",
      effectiveAgentId: "future-harness",
      definition,
      harnessPackage: {
        kind: "agent-runtime",
        id: "future-harness",
        packageVersion: "1.0.0",
        contentDigest: "f".repeat(64),
      },
      harnessPackageMigration: null,
    } satisfies ResolvedSandboxAgent;
    const plan = {
      schemaVersion: 1,
      sandboxName: "alpha",
      agent: "future-harness",
      workflow: "rebuild",
      channels: [
        {
          channelId: "telegram",
          displayName: "Telegram",
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
      credentialBindings: [
        {
          channelId: "telegram",
          credentialId: "telegramBotToken",
          sourceInput: "botToken",
          providerName: "alpha-telegram-bridge",
          providerEnvKey: "TELEGRAM_BOT_TOKEN",
          placeholder: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
          credentialAvailable: true,
        },
      ],
      providerReceipts: [
        {
          channelId: "telegram",
          providerName: "alpha-telegram-bridge",
          providerId: "telegram-provider-id",
          createdByNemoClaw: true,
          attachmentAddedByNemoClaw: true,
        },
      ],
      networkPolicy: { presets: [], entries: [] },
      agentRender: [],
      buildSteps: [],
      stateUpdates: [],
      healthChecks: [],
    } satisfies SandboxMessagingPlan;

    const preflight = () => preflightRebuildMessagingProviderAuthority(plan, authority);
    testCase.expected
      ? expect(preflight).toThrow(testCase.expected)
      : expect(preflight).not.toThrow();
    expect(mocks.runOpenshell).toHaveBeenCalledTimes(testCase.expectedProbeCount);
  });

  it.each([
    {
      name: "missing source secret",
      sourceSecret: undefined,
      expected: "was not found",
      expectedProbeCount: 1,
    },
    {
      name: "malformed source secret",
      sourceSecret: "not-json",
      expected: "was not found",
      expectedProbeCount: 1,
    },
    {
      name: "valid source secret",
      sourceSecret: JSON.stringify({
        client_email: "agent@example.test",
        private_key: "private-key-material",
      }),
      expected: null,
      expectedProbeCount: 1,
    },
    {
      name: "valid source secret and colliding provider",
      sourceSecret: JSON.stringify({
        client_email: "agent@example.test",
        private_key: "private-key-material",
      }),
      providerResult: {
        status: 0,
        stdout:
          "Name: alpha-googlechat-bridge\nType: generic\nCredential keys: GOOGLE_CHAT_ACCESS_TOKEN\nConfig keys: <none>\n",
      },
      expected: "does not match its exact credential binding",
      expectedProbeCount: 1,
    },
    {
      name: "valid source secret and indeterminate provider",
      sourceSecret: JSON.stringify({
        client_email: "agent@example.test",
        private_key: "private-key-material",
      }),
      providerResult: { status: 1, stderr: "gateway unavailable" },
      expected: "could not be inspected",
      expectedProbeCount: 1,
    },
  ])("handles a receipt bridge provider with a $name", (testCase) => {
    vi.stubEnv("GOOGLECHAT_SERVICE_ACCOUNT", testCase.sourceSecret);
    mocks.runOpenshell.mockReturnValue(
      "providerResult" in testCase
        ? testCase.providerResult
        : {
            status: 1,
            stderr: "provider 'alpha-googlechat-bridge' not found",
          },
    );
    const definition = makeAgent({ name: "future-harness" });
    const authority = {
      recordedAgent: "future-harness",
      effectiveAgentId: "future-harness",
      definition,
      harnessPackage: {
        kind: "agent-runtime",
        id: "future-harness",
        packageVersion: "1.0.0",
        contentDigest: "f".repeat(64),
      },
      harnessPackageMigration: null,
    } satisfies ResolvedSandboxAgent;
    const plan = {
      schemaVersion: 1,
      sandboxName: "alpha",
      agent: "future-harness",
      workflow: "rebuild",
      channels: [
        {
          channelId: "googlechat",
          displayName: "Google Chat",
          authMode: "token-paste",
          active: true,
          selected: true,
          configured: true,
          disabled: false,
          credentialProvider: {
            profilePath: "provider-profiles/googlechat.yaml",
            profileId: "future-googlechat",
            credentialEnv: "GOOGLE_CHAT_ACCESS_TOKEN",
            sourceInputId: "serviceAccount",
            sourceSecretEnv: "GOOGLECHAT_SERVICE_ACCOUNT",
            refresh: {
              strategy: "google_service_account_jwt",
              scopes: ["https://www.googleapis.com/auth/chat.bot"],
              secretMaterialKeys: ["private_key"],
            },
          },
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
      packageBuild: { configRoot: "~/.future-harness", packageManagers: [] },
    } satisfies SandboxMessagingPlan;

    const preflight = () => preflightRebuildMessagingProviderAuthority(plan, authority);
    testCase.expected
      ? expect(preflight).toThrow(testCase.expected)
      : expect(preflight).not.toThrow();
    expect(mocks.runOpenshell).toHaveBeenCalledTimes(testCase.expectedProbeCount);
  });

  it.each([
    {
      name: "Telegram with a valid current credential",
      channelId: "telegram",
      displayName: "Telegram",
      credentialId: "telegramBotToken",
      sourceInput: "botToken",
      envKey: "TELEGRAM_BOT_TOKEN",
      token: "123456:replacement-telegram-token",
      expected: null,
      expectedProbeCount: 1,
    },
    {
      name: "WeChat with a valid current credential",
      channelId: "wechat",
      displayName: "WeChat",
      credentialId: "wechatBotToken",
      sourceInput: "botToken",
      envKey: "WECHAT_BOT_TOKEN",
      token: "replacement-wechat-token",
      expected: null,
      expectedProbeCount: 1,
    },
    {
      name: "Telegram with a valid current credential and colliding provider",
      channelId: "telegram",
      displayName: "Telegram",
      credentialId: "telegramBotToken",
      sourceInput: "botToken",
      envKey: "TELEGRAM_BOT_TOKEN",
      token: "123456:replacement-telegram-token",
      providerResult: {
        status: 0,
        stdout:
          "Name: alpha-telegram-bridge\nType: generic\nCredential keys: TELEGRAM_BOT_TOKEN\nConfig keys: <none>\n",
      },
      expected: "does not match its exact credential binding",
      expectedProbeCount: 1,
    },
    {
      name: "WeChat with a valid current credential and indeterminate provider",
      channelId: "wechat",
      displayName: "WeChat",
      credentialId: "wechatBotToken",
      sourceInput: "botToken",
      envKey: "WECHAT_BOT_TOKEN",
      token: "replacement-wechat-token",
      providerResult: { status: 1, stderr: "gateway unavailable" },
      expected: "could not be inspected",
      expectedProbeCount: 1,
    },
    {
      name: "Telegram with an invalid current credential",
      channelId: "telegram",
      displayName: "Telegram",
      credentialId: "telegramBotToken",
      sourceInput: "botToken",
      envKey: "TELEGRAM_BOT_TOKEN",
      token: " ",
      expected: "was not found",
      expectedProbeCount: 1,
    },
    {
      name: "WeChat with an invalid current credential",
      channelId: "wechat",
      displayName: "WeChat",
      credentialId: "wechatBotToken",
      sourceInput: "botToken",
      envKey: "WECHAT_BOT_TOKEN",
      token: " ",
      expected: "was not found",
      expectedProbeCount: 1,
    },
    {
      name: "Telegram without a current credential",
      channelId: "telegram",
      displayName: "Telegram",
      credentialId: "telegramBotToken",
      sourceInput: "botToken",
      envKey: "TELEGRAM_BOT_TOKEN",
      token: undefined,
      expected: "was not found",
      expectedProbeCount: 1,
    },
    {
      name: "WeChat without a current credential",
      channelId: "wechat",
      displayName: "WeChat",
      credentialId: "wechatBotToken",
      sourceInput: "botToken",
      envKey: "WECHAT_BOT_TOKEN",
      token: undefined,
      expected: "was not found",
      expectedProbeCount: 1,
    },
  ])("handles migrated $name without weakening credential provenance", (testCase) => {
    vi.stubEnv(testCase.envKey, testCase.token);
    mocks.runOpenshell.mockReturnValue(
      "providerResult" in testCase
        ? testCase.providerResult
        : {
            status: 1,
            stderr: `provider 'alpha-${testCase.channelId}-bridge' not found`,
          },
    );
    const definition = makeAgent({ name: "future-harness" });
    const authority = {
      recordedAgent: "future-harness",
      effectiveAgentId: "future-harness",
      definition,
      harnessPackage: {
        kind: "agent-runtime",
        id: "future-harness",
        packageVersion: "1.0.0",
        contentDigest: "f".repeat(64),
      },
      harnessPackageMigration: {
        schemaVersion: 1,
        source: "legacy-current-bundle",
        legacyAgent: "future-harness",
        migratedAt: "2026-09-07T00:00:00.000Z",
      },
    } satisfies ResolvedSandboxAgent;
    const plan = {
      schemaVersion: 1,
      sandboxName: "alpha",
      agent: "future-harness",
      workflow: "rebuild",
      channels: [
        {
          channelId: testCase.channelId,
          displayName: testCase.displayName,
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
      credentialBindings: [
        {
          channelId: testCase.channelId,
          credentialId: testCase.credentialId,
          sourceInput: testCase.sourceInput,
          providerName: `alpha-${testCase.channelId}-bridge`,
          providerEnvKey: testCase.envKey,
          placeholder: `openshell:resolve:env:${testCase.envKey}`,
          credentialAvailable: true,
          credentialHash: "a".repeat(64),
        },
      ],
      networkPolicy: { presets: [], entries: [] },
      agentRender: [],
      buildSteps: [],
      stateUpdates: [],
      healthChecks: [],
    } satisfies SandboxMessagingPlan;

    const preflight = () => preflightRebuildMessagingProviderAuthority(plan, authority);
    testCase.expected
      ? expect(preflight).toThrow(testCase.expected)
      : expect(preflight).not.toThrow();
    expect(mocks.runOpenshell).toHaveBeenCalledTimes(testCase.expectedProbeCount);
  });
});

describe("rebuild readiness gateway pin", () => {
  it("does not require runtime authority for prepared-only MCP state", () => {
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });

    expect(
      resolveRebuildMcpRuntimeSelection(
        {
          mcp: {
            bridges: {
              github: { addState: "prepared" },
            },
          },
        } as never,
        bail,
      ),
    ).toBeUndefined();
    expect(bail).not.toHaveBeenCalled();
  });

  it("pins the recorded target without selecting or recovering a gateway (#7411)", () => {
    const log = vi.fn();
    process.env.OPENSHELL_GATEWAY = "hostile-gateway";
    process.env.OPENSHELL_GATEWAY_ENDPOINT = "https://hostile.invalid";
    process.env.OPENSHELL_LOCAL_TLS_DIR = "/hostile/tls";
    process.env.OPENSHELL_TOKEN = "hostile-token";
    process.env.OPENSHELL_WORKSPACE = "hostile-workspace";
    const runtimeSelection = { gatewayName: "nemoclaw-9443", workspace: "default" };

    expect(
      pinRebuildTargetGatewayForReadiness(
        "alpha",
        { gatewayName: "nemoclaw-9443", gatewayPort: 9443 } as never,
        log,
        runtimeSelection,
      ),
    ).toBe("nemoclaw-9443");
    expect(process.env.OPENSHELL_GATEWAY).toBe("nemoclaw-9443");
    expect(process.env.OPENSHELL_WORKSPACE).toBe("default");
    expect(process.env.OPENSHELL_GATEWAY_ENDPOINT).toBeUndefined();
    expect(process.env.OPENSHELL_LOCAL_TLS_DIR).toBeUndefined();
    expect(process.env.OPENSHELL_TOKEN).toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      "Pinned rebuild readiness probes for 'alpha' to target gateway 'nemoclaw-9443'",
    );
  });

  it("keeps non-MCP ambient selectors while pinning the recorded gateway (#10514)", () => {
    process.env.OPENSHELL_GATEWAY = "hostile-gateway";
    process.env.OPENSHELL_GATEWAY_ENDPOINT = "https://hostile.invalid";
    process.env.OPENSHELL_LOCAL_TLS_DIR = "/hostile/tls";
    process.env.OPENSHELL_TOKEN = "hostile-token";
    process.env.OPENSHELL_WORKSPACE = "hostile-workspace";

    expect(
      pinRebuildTargetGatewayForReadiness(
        "alpha",
        { gatewayName: "nemoclaw-9443", gatewayPort: 9443 } as never,
        vi.fn(),
      ),
    ).toBe("nemoclaw-9443");
    expect(process.env.OPENSHELL_GATEWAY).toBe("nemoclaw-9443");
    expect(process.env.OPENSHELL_GATEWAY_ENDPOINT).toBe("https://hostile.invalid");
    expect(process.env.OPENSHELL_LOCAL_TLS_DIR).toBe("/hostile/tls");
    expect(process.env.OPENSHELL_TOKEN).toBe("hostile-token");
    expect(process.env.OPENSHELL_WORKSPACE).toBe("hostile-workspace");
  });

  it("does not select or recover the gateway when readiness rejects (#7411)", async () => {
    const afterReadiness = vi.fn();
    const recoverGateway = vi.fn(async () => true);

    await expect(
      runRebuildGatewayRecoveryAfterReadiness({
        assertReadiness: async () => false,
        afterReadiness,
        recoverGateway,
      }),
    ).resolves.toBe(false);
    expect(afterReadiness).not.toHaveBeenCalled();
    expect(recoverGateway).not.toHaveBeenCalled();
  });

  it("recovers the gateway only after readiness and post-admission staging (#7411)", async () => {
    const calls: string[] = [];

    await expect(
      runRebuildGatewayRecoveryAfterReadiness({
        assertReadiness: async () => {
          calls.push("readiness");
          return true;
        },
        afterReadiness: () => calls.push("stage-receipt"),
        recoverGateway: async () => {
          calls.push("recover-gateway");
          return true;
        },
      }),
    ).resolves.toBe(true);
    expect(calls).toEqual(["readiness", "stage-receipt", "recover-gateway"]);
  });
});

const target = {
  sandboxName: "alpha",
  gatewayName: "nemoclaw",
  provider: "compatible-endpoint",
  model: "nvidia/model",
};

const registryRoute: RegistryInferenceRoute = {
  provider: target.provider,
  model: target.model,
  endpointUrl: "https://inference.example.test/v1",
  endpointSource: null,
  preferredInferenceApi: "openai-completions",
  source: "registry",
};

describe("stageRegistryProviderRecoveryReceipt", () => {
  it("leaves recovery authority absent without a registry-derived route", () => {
    const recreateOptions: { providerRecoveryReceipt?: ProviderRecoveryReceipt } = {};

    stageRegistryProviderRecoveryReceipt(recreateOptions, target, null, {
      nonce: "nonce-without-route",
      expiresAtMs: 1_000,
    });

    expect(recreateOptions).not.toHaveProperty("providerRecoveryReceipt");
  });

  it("binds recovery authority to the captured registry route", () => {
    const recreateOptions: { providerRecoveryReceipt?: ProviderRecoveryReceipt } = {};

    stageRegistryProviderRecoveryReceipt(recreateOptions, target, registryRoute, {
      nonce: "nonce-with-route",
      expiresAtMs: 1_000,
    });

    expect(recreateOptions.providerRecoveryReceipt).toEqual({
      ...target,
      route: registryRoute,
      nonce: "nonce-with-route",
      expiresAtMs: 1_000,
      sessionId: null,
    });
  });
});

describe("stageRebuildBaseImageResolutionHandoff", () => {
  it("binds outer resolver provenance to its immutable local handoff (#7144)", () => {
    const imageId = `sha256:${"a".repeat(64)}`;
    const current = { key: "current", imageId } as SandboxBaseImageResolutionMetadata;
    const recreateOptions: { preResolvedBaseImageMetadata?: SandboxBaseImageResolutionMetadata } =
      {};

    stageRebuildBaseImageResolutionHandoff(recreateOptions, {
      ok: true,
      imageRef: `nemoclaw-hermes-sandbox-base-local:image-${"a".repeat(64)}`,
      overrideEnvVar: "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF",
      resolutionMetadata: current,
    });

    expect(recreateOptions.preResolvedBaseImageMetadata).toBe(current);
  });

  it("binds provenance to a temporary immutable rebuild handoff (#7144)", () => {
    const imageId = `sha256:${"a".repeat(64)}`;
    const current = { key: "current", imageId } as SandboxBaseImageResolutionMetadata;
    const recreateOptions: { preResolvedBaseImageMetadata?: SandboxBaseImageResolutionMetadata } =
      {};

    stageRebuildBaseImageResolutionHandoff(recreateOptions, {
      ok: true,
      imageRef: `nemoclaw-hermes-sandbox-base-local:rebuild-123-${"b".repeat(16)}-image-${"a".repeat(64)}`,
      overrideEnvVar: "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF",
      resolutionMetadata: current,
    });

    expect(recreateOptions.preResolvedBaseImageMetadata).toBe(current);
  });

  it("binds provenance to the exact immutable remote rebuild handoff (#7144)", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const imageRef = `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@${digest}`;
    const current = {
      key: "current",
      imageName: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base",
      imageId: `sha256:${"b".repeat(64)}`,
      ref: imageRef,
      digest,
      source: "pinned",
    } as SandboxBaseImageResolutionMetadata;
    const recreateOptions: { preResolvedBaseImageMetadata?: SandboxBaseImageResolutionMetadata } =
      {};

    stageRebuildBaseImageResolutionHandoff(recreateOptions, {
      ok: true,
      imageRef,
      overrideEnvVar: "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF",
      resolutionMetadata: current,
    });

    expect(recreateOptions.preResolvedBaseImageMetadata).toBe(current);
  });

  it("rejects provenance that is not bound to the immutable local handoff", () => {
    const current = {
      key: "current",
      imageId: `sha256:${"a".repeat(64)}`,
    } as SandboxBaseImageResolutionMetadata;
    const recreateOptions: { preResolvedBaseImageMetadata?: SandboxBaseImageResolutionMetadata } =
      {};

    expect(() =>
      stageRebuildBaseImageResolutionHandoff(recreateOptions, {
        ok: true,
        imageRef: `nemoclaw-hermes-sandbox-base-local:image-${"b".repeat(64)}`,
        overrideEnvVar: "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF",
        resolutionMetadata: current,
      }),
    ).toThrow("provenance did not match its immutable handoff");
  });
});
