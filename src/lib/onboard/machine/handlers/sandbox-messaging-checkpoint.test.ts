// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type {
  MessagingAgentId,
  MessagingChannelId,
  SandboxMessagingCredentialBindingPlan,
  SandboxMessagingPlan,
} from "../../../messaging/manifest";
import type { RegistryMessagingAuthority } from "../../../messaging/plan-authority";
import { hashCredential } from "../../../security/credential-hash";
import { decisionSelected } from "../../../state/onboard-checkpoint-decision";
import { deriveCheckpointFromSession } from "../../../state/onboard-checkpoint-migrate";
import { createSession, type Session } from "../../../state/onboard-session";
import { makeMessagingPlan } from "../../../../../test/helpers/messaging-plan-fixtures";
import type { GatewayCredentialOnlyProviderInspection } from "../../gateway-provider-metadata";
import { selectedAgentResumesSandboxPrompts } from "../../web-search/support";
import { reconcileSandboxMessaging } from "./sandbox-messaging";

const credentialSpecs = {
  telegram: ["telegram", "botToken", "botToken", "alpha-telegram-bridge", "TELEGRAM_BOT_TOKEN"],
  discord: ["discord", "discordBotToken", "botToken", "alpha-discord-bridge", "DISCORD_BOT_TOKEN"],
} as const;

function credentialBinding(
  kind: keyof typeof credentialSpecs,
  credentialHash: string,
): SandboxMessagingCredentialBindingPlan {
  const [channelId, credentialId, sourceInput, providerName, providerEnvKey] =
    credentialSpecs[kind];
  return {
    channelId,
    credentialId,
    sourceInput,
    providerName,
    providerEnvKey,
    placeholder: `openshell:resolve:env:${providerEnvKey}`,
    credentialAvailable: true,
    credentialHash,
  };
}

function messagingPlan(
  channelId: MessagingChannelId,
  credentialBindings: readonly SandboxMessagingCredentialBindingPlan[],
  agent: MessagingAgentId,
): SandboxMessagingPlan {
  return makeMessagingPlan({
    sandboxName: "alpha",
    agent,
    channels: [channelId],
    credentialBindings,
  });
}

function telegramPlan(credentialHash: string): SandboxMessagingPlan {
  return messagingPlan("telegram", [credentialBinding("telegram", credentialHash)], "openclaw");
}

function discordPlan(credentialHash: string) {
  return messagingPlan("discord", [credentialBinding("discord", credentialHash)], "hermes");
}

function completedCheckpointSession(
  plan: SandboxMessagingPlan,
  stagedCredentialProviders: string[] = [],
) {
  const session = createSession({ sandboxName: plan.sandboxName, messagingPlan: plan });
  session.stagedCredentialProviders = stagedCredentialProviders;
  session.sandboxPromptProgress.sandboxName = true;
  session.sandboxPromptProgress.messaging = true;
  return session;
}

function withMessagingCheckpoint(session: Session, selectedChannels: string[]) {
  session.checkpoint = {
    ...deriveCheckpointFromSession(session),
    messaging: decisionSelected({ selectedChannels, disabledChannels: [] }),
  };
  return session;
}

function reconcileDeps(plans: readonly (SandboxMessagingPlan | null)[]) {
  return {
    note: vi.fn(),
    showMessagingStage: vi.fn(),
    getRecordedMessagingChannelsForResume: vi.fn((): string[] | null => null),
    setupMessagingChannels: vi.fn(
      async (
        _agent: unknown,
        _existingChannels: string[] | null,
        _sandboxName: string,
        _options?: { readonly selectionCompleted?: boolean },
      ) => ["telegram"],
    ),
    readMessagingPlanFromEnv: vi
      .fn()
      .mockReturnValueOnce(plans[0] ?? null)
      .mockReturnValue(plans[1] ?? plans[0] ?? null),
    writePlanToEnv: vi.fn(),
    clearPlanEnv: vi.fn(),
    getRegistrySandboxMessagingAuthority: vi.fn<() => RegistryMessagingAuthority>(() => ({
      authoritative: false,
      plan: null,
    })),
    inspectGatewayCredential: vi.fn<
      (name: string, type: string, credentialEnv: string) => GatewayCredentialOnlyProviderInspection
    >(() => ({ kind: "missing" })),
    providerMatchesGatewayCredential: vi.fn(() => false),
    selectedAgentResumesSandboxPrompts,
  };
}

describe("reconcileSandboxMessaging checkpoint authority", () => {
  it("reuses a missing Hermes Discord credential with the exact static provider binding", async () => {
    const persistedPlan = discordPlan(hashCredential("previous-discord-token") ?? "");
    const deps = reconcileDeps([null, persistedPlan]);
    deps.providerMatchesGatewayCredential.mockReturnValue(true);
    vi.stubEnv("DISCORD_BOT_TOKEN", "");

    const result = await reconcileSandboxMessaging({
      resume: true,
      session: completedCheckpointSession(persistedPlan, ["alpha-discord-bridge"]),
      sandboxName: "alpha",
      agent: {},
      deps,
    });

    expect(deps.providerMatchesGatewayCredential).toHaveBeenCalledWith(
      "alpha-discord-bridge",
      "discord-hermes-static-v1",
      "DISCORD_BOT_TOKEN",
    );
    expect(deps.setupMessagingChannels).not.toHaveBeenCalled();
    expect(result).toEqual({ plan: persistedPlan, selectedChannels: ["discord"] });
  });

  it("revalidates a missing Hermes Discord credential without the exact static binding", async () => {
    const persistedPlan = discordPlan(hashCredential("previous-discord-token") ?? "");
    const deps = reconcileDeps([null, persistedPlan]);
    deps.providerMatchesGatewayCredential.mockReturnValue(false);
    deps.setupMessagingChannels.mockResolvedValue(["discord"]);
    vi.stubEnv("DISCORD_BOT_TOKEN", "");

    await reconcileSandboxMessaging({
      resume: true,
      session: completedCheckpointSession(persistedPlan, ["alpha-discord-bridge"]),
      sandboxName: "alpha",
      agent: {},
      deps,
    });

    expect(deps.providerMatchesGatewayCredential).toHaveBeenCalledWith(
      "alpha-discord-bridge",
      "discord-hermes-static-v1",
      "DISCORD_BOT_TOKEN",
    );
    expect(deps.setupMessagingChannels).toHaveBeenCalledWith({}, ["discord"], "alpha", {
      selectionCompleted: true,
    });
  });

  it("does not reconcile when the checkpointed channel selection matches the durable plan (#7022)", async () => {
    const persistedPlan = telegramPlan(hashCredential("123456:previous-token") ?? "");
    const deps = reconcileDeps([null]);
    deps.providerMatchesGatewayCredential.mockReturnValueOnce(true);
    const session = withMessagingCheckpoint(
      completedCheckpointSession(persistedPlan, ["alpha-telegram-bridge"]),
      ["telegram"],
    );

    const result = await reconcileSandboxMessaging({
      resume: true,
      session,
      sandboxName: "alpha",
      agent: { name: "openclaw" },
      deps,
    });

    expect(deps.setupMessagingChannels).not.toHaveBeenCalled();
    expect(deps.note).not.toHaveBeenCalledWith(
      expect.stringContaining("Reconciling messaging selection"),
    );
    expect(result).toEqual({ plan: persistedPlan, selectedChannels: ["telegram"] });
  });

  it("reconciles the messaging selection with the checkpoint when the durable plan disagrees (#7022)", async () => {
    const persistedPlan = telegramPlan(hashCredential("123456:previous-token") ?? "");
    const deps = reconcileDeps([null]);
    deps.setupMessagingChannels.mockImplementationOnce(
      async (_agent: unknown, existing: string[] | null) => existing ?? [],
    );
    const session = withMessagingCheckpoint(completedCheckpointSession(persistedPlan), ["discord"]);

    const result = await reconcileSandboxMessaging({
      resume: true,
      session,
      sandboxName: "alpha",
      agent: { name: "openclaw" },
      deps,
    });

    expect(deps.note).toHaveBeenCalledWith(
      expect.stringContaining("Reconciling messaging selection"),
    );
    expect(deps.setupMessagingChannels).toHaveBeenCalledWith(
      { name: "openclaw" },
      ["discord"],
      "alpha",
      { selectionCompleted: true },
    );
    expect(result.selectedChannels).toEqual(["discord"]);
  });
});
