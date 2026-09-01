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
import type { ResolvedSandboxAgent } from "../../onboard/sandbox-agent";
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

const OPENCLAW_AUTHORITY = {
  recordedAgent: null,
  effectiveAgentId: "openclaw",
  definition: pinnedAgent("openclaw"),
  harnessPackage: OPENCLAW_PACKAGE,
  harnessPackageMigration: null,
} satisfies ResolvedSandboxAgent;

describe("stageMessagingManifestPlanForRebuild non-messaging agent guard", () => {
  afterEach(() => {
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
