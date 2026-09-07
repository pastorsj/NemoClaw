// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { detectMessagingChannelsFromEnv } from "../../messaging-channel-setup";
import { handleSandboxState } from "./sandbox";
import { baseOptions, createDeps, makeMinimalPlan } from "./sandbox-test-fixtures";

vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
  detectUnconfiguredMessagingChannels: vi.fn(() => []),
}));
vi.mock("../../../messaging", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../messaging")>();
  return {
    ...actual,
    resolveSandboxMessagingProfileAuthority: vi.fn((entry: { agent?: string }) => ({
      agent: { name: entry.agent },
    })),
    listMessagingChannelsForProfile: vi.fn(() => []),
  };
});

const detectMessagingChannelsFromEnvMock = vi.mocked(detectMessagingChannelsFromEnv);

beforeEach(() => {
  detectMessagingChannelsFromEnvMock.mockReturnValue([]);
});

describe("handleSandboxState messaging plan authority", () => {
  it("clears env-staged messaging plans when the current agent has no channel manifest support", async () => {
    const stalePlan = makeMinimalPlan("my-assistant", "openclaw", ["telegram"]);
    const session = createSession({ sandboxName: "my-assistant", messagingPlan: stalePlan });
    const writePlanToEnv = vi.fn();
    const { deps, calls, getSession } = createDeps({
      getRecordedMessagingChannelsForResume: vi.fn(() => ["telegram"]),
      writePlanToEnv,
      readMessagingPlanFromEnv: () => stalePlan,
    });

    const result = await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
      agent: { name: "langchain-deepagents-code" },
    });

    expect(calls.clearPlanEnv).toHaveBeenCalledTimes(1);
    expect(writePlanToEnv).not.toHaveBeenCalled();
    expect(result.selectedMessagingChannels).toEqual([]);
    expect((calls.createSandbox.mock.calls[0] as unknown[])[6]).toEqual([]);
    expect(getSession().messagingPlan).toBeNull();
  });

  it("clears registry messaging plans when the current agent is unknown", async () => {
    const registryPlan = makeMinimalPlan("my-assistant", "openclaw", ["discord"]);
    const session = createSession({ sandboxName: "my-assistant", messagingPlan: registryPlan });
    const writePlanToEnv = vi.fn();
    const { deps, calls, getSession } = createDeps({
      getRecordedMessagingChannelsForResume: vi.fn(() => ["discord"]),
      writePlanToEnv,
      readMessagingPlanFromEnv: () => null,
      getRegistrySandboxMessagingAuthority: () => ({ authoritative: true, plan: registryPlan }),
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
      agent: { name: "custom-agent" },
    });

    expect(calls.clearPlanEnv).toHaveBeenCalledTimes(1);
    expect(writePlanToEnv).not.toHaveBeenCalled();
    expect((calls.createSandbox.mock.calls[0] as unknown[])[6]).toEqual([]);
    expect(getSession().messagingPlan).toBeNull();
  });

  it("refreshes a reused empty registry messaging plan when env supplies new channel inputs", async () => {
    detectMessagingChannelsFromEnvMock.mockReturnValue(["telegram"]);
    const registryPlan = makeMinimalPlan("my-assistant", "openclaw", ["whatsapp"], ["whatsapp"]);
    const refreshedPlan = makeMinimalPlan("my-assistant", "openclaw", ["telegram"], ["telegram"]);
    const session = createSession({
      sandboxName: "my-assistant",
      messagingPlan: makeMinimalPlan("my-assistant", "openclaw", ["slack"]),
    });
    const writePlanToEnv = vi.fn();
    const readMessagingPlanFromEnv = vi.fn(() => refreshedPlan);
    const { deps, calls, getSession } = createDeps({
      getRecordedMessagingChannelsForResume: vi.fn(() => null),
      writePlanToEnv,
      readMessagingPlanFromEnv,
      getRegistrySandboxMessagingAuthority: () => ({ authoritative: true, plan: registryPlan }),
    });
    calls.setupMessaging.mockResolvedValue([]);

    const result = await handleSandboxState({
      ...baseOptions(deps, session),
      sandboxName: "my-assistant",
    });

    expect(calls.setupMessaging).toHaveBeenCalledWith(null, ["whatsapp"], "my-assistant");
    expect(readMessagingPlanFromEnv).toHaveBeenCalledOnce();
    expect(writePlanToEnv).not.toHaveBeenCalled();
    expect(calls.note).toHaveBeenCalledWith(
      "  [non-interactive] Detected messaging channel inputs for telegram; refreshing reused sandbox messaging plan.",
    );
    expect(result.selectedMessagingChannels).toEqual([]);
    expect(getSession().messagingPlan).toEqual(refreshedPlan);
  });

  it("preserves an active registry channel without refresh when env adds a different channel", async () => {
    detectMessagingChannelsFromEnvMock.mockReturnValue(["telegram"]);
    const registryPlan = makeMinimalPlan("my-assistant", "openclaw", ["slack"]);
    const session = createSession({ sandboxName: "my-assistant", messagingPlan: registryPlan });
    const writePlanToEnv = vi.fn();
    const { deps, calls } = createDeps({
      getRecordedMessagingChannelsForResume: vi.fn(() => null),
      writePlanToEnv,
      readMessagingPlanFromEnv: () => null,
      getRegistrySandboxMessagingAuthority: () => ({ authoritative: true, plan: registryPlan }),
    });

    const result = await handleSandboxState({
      ...baseOptions(deps, session),
      sandboxName: "my-assistant",
    });

    expect(calls.setupMessaging).not.toHaveBeenCalled();
    expect(writePlanToEnv).toHaveBeenCalledWith(registryPlan);
    expect(result.selectedMessagingChannels).toEqual(["slack"]);
  });

  it("does not restore plan to env when registry has no entry", async () => {
    const session = createSession({
      sandboxName: "my-assistant",
      messagingPlan: makeMinimalPlan("my-assistant"),
    });
    const writePlanToEnv = vi.fn();
    const { deps } = createDeps({
      getRecordedMessagingChannelsForResume: vi.fn(() => ["telegram"]),
      writePlanToEnv,
      readMessagingPlanFromEnv: () => null,
      getRegistrySandboxMessagingAuthority: () => ({ authoritative: false, plan: null }),
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(writePlanToEnv).not.toHaveBeenCalled();
  });
});
