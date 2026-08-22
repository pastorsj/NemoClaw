// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createSession, normalizeSession } from "./onboard-session";

type LegacySession = Omit<ReturnType<typeof createSession>, "agent" | "machine"> & {
  agent?: unknown;
  machine?: unknown;
};

function requireNormalizedSession(legacy: LegacySession) {
  const normalized = normalizeSession(legacy as Parameters<typeof normalizeSession>[0]);
  expect(normalized).not.toBeNull();
  return normalized!;
}

describe("onboard session normalization", () => {
  it("normalizes an absent legacy OpenClaw identity to null", () => {
    const persisted = createSession() as unknown as LegacySession;
    delete persisted.agent;

    expect(requireNormalizedSession(persisted).agent).toBeNull();
  });

  it.each([
    ["a null legacy OpenClaw identity", null, null],
    ["an explicit OpenClaw identity", "openclaw", "openclaw"],
    ["an explicit Hermes identity", "hermes", "hermes"],
    [
      "an explicit LangChain Deep Agents Code identity",
      "langchain-deepagents-code",
      "langchain-deepagents-code",
    ],
    ["an unknown string identity", "unknown-runtime", "unknown-runtime"],
    ["a malformed non-string identity", 42, null],
  ] as const)("normalizes %s to the current durable value", (_label, input, expected) => {
    const persisted = createSession() as unknown as LegacySession;
    persisted.agent = input;

    expect(requireNormalizedSession(persisted).agent).toBe(expected);
  });

  it("preserves completed and interrupted step state", () => {
    const completedAt = "2026-08-21T12:00:00.000Z";
    const interruptedAt = "2026-08-21T12:01:00.000Z";
    const persisted = createSession({
      agent: "hermes",
      status: "failed",
      lastCompletedStep: "inference",
      lastStepStarted: "agent_setup",
      failure: {
        step: "agent_setup",
        message: "operator interrupted onboarding",
        recordedAt: interruptedAt,
        interrupted: true,
      },
    }) as unknown as LegacySession;
    persisted.steps.inference = {
      status: "complete",
      startedAt: completedAt,
      completedAt,
      error: null,
    };
    persisted.steps.agent_setup = {
      status: "in_progress",
      startedAt: interruptedAt,
      completedAt: null,
      error: "operator interrupted onboarding",
    };
    delete persisted.machine;

    const normalized = requireNormalizedSession(persisted);

    expect(normalized.steps.inference).toEqual(persisted.steps.inference);
    expect(normalized.steps.agent_setup).toEqual(persisted.steps.agent_setup);
    expect(normalized.lastCompletedStep).toBe("inference");
    expect(normalized.lastStepStarted).toBe("agent_setup");
    expect(normalized.failure).toEqual(persisted.failure);
  });

  it("normalizes old sessions without machine snapshots", () => {
    const legacy = createSession({
      sessionId: "legacy-session",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:05:00.000Z",
    }) as unknown as LegacySession;
    delete legacy.machine;
    legacy.steps.gateway.status = "in_progress";
    legacy.steps.gateway.startedAt = "2026-01-01T00:02:00.000Z";
    legacy.lastStepStarted = "gateway";

    let normalized = requireNormalizedSession(legacy);
    expect(normalized.machine).toEqual({
      version: 1,
      state: "gateway",
      stateEnteredAt: "2026-01-01T00:02:00.000Z",
      revision: 0,
    });

    legacy.steps.gateway.status = "complete";
    legacy.steps.gateway.completedAt = "2026-01-01T00:03:00.000Z";
    legacy.lastCompletedStep = "gateway";
    normalized = requireNormalizedSession(legacy);
    expect(normalized.machine).toEqual({
      version: 1,
      state: "provider_selection",
      stateEnteredAt: "2026-01-01T00:03:00.000Z",
      revision: 0,
    });

    legacy.status = "failed";
    legacy.failure = {
      step: "gateway",
      message: "boom",
      recordedAt: "2026-01-01T00:04:00.000Z",
    };
    normalized = requireNormalizedSession(legacy);
    expect(normalized.machine).toEqual({
      version: 1,
      state: "failed",
      stateEnteredAt: "2026-01-01T00:04:00.000Z",
      revision: 0,
    });

    legacy.status = "complete";
    normalized = requireNormalizedSession(legacy);
    expect(normalized.machine.state).toBe("complete");
  });

  it("normalizes invalid machine snapshots from old sessions", () => {
    const legacy = createSession({
      lastCompletedStep: "policies",
    }) as unknown as LegacySession;
    legacy.steps.policies.status = "complete";
    legacy.steps.policies.completedAt = "2026-01-01T00:08:00.000Z";
    legacy.machine = {
      version: 1,
      state: "not-a-state",
      stateEnteredAt: "2026-01-01T00:09:00.000Z",
      revision: -1,
    };

    const normalized = requireNormalizedSession(legacy);
    expect(normalized.machine).toEqual({
      version: 1,
      state: "finalizing",
      stateEnteredAt: "2026-01-01T00:08:00.000Z",
      revision: 0,
    });
  });
});
