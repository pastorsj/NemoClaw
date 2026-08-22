// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { decisionSelected } from "../state/onboard-checkpoint-decision";
import { deriveCheckpointFromSession } from "../state/onboard-checkpoint-migrate";
import { createSession } from "../state/onboard-session";
import {
  clearAgentScopedResumeState,
  normalizeAgentNameForResumeState,
} from "./agent-resume-state";
import { checkpointSandboxIdentityMatches } from "./checkpoint-replay";

describe("clearAgentScopedResumeState", () => {
  it.each([
    ["an absent legacy identity", undefined, "openclaw"],
    ["a null legacy identity", null, "openclaw"],
    ["explicit OpenClaw", "openclaw", "openclaw"],
    ["explicit Hermes", "hermes", "hermes"],
    [
      "explicit LangChain Deep Agents Code",
      "langchain-deepagents-code",
      "langchain-deepagents-code",
    ],
    ["a whitespace-padded identity", "  hermes  ", "hermes"],
  ] as const)("normalizes %s before a resume-state write", (_label, identity, expected) => {
    expect(normalizeAgentNameForResumeState(identity)).toBe(expected);
  });

  it.each([
    ["OpenClaw", "openclaw", null],
    ["Hermes", "hermes", "hermes"],
    ["LangChain Deep Agents Code", "langchain-deepagents-code", "langchain-deepagents-code"],
  ] as const)("writes the current %s durable identity", (_label, selected, expected) => {
    const session = createSession({ agent: selected === "hermes" ? null : "hermes" });

    clearAgentScopedResumeState(session, selected);

    expect(session.agent).toBe(expected);
  });

  it("resets completed and interrupted agent steps but keeps the completed gateway", () => {
    const completedAt = "2026-08-21T12:00:00.000Z";
    const startedAt = "2026-08-21T12:01:00.000Z";
    const session = createSession({
      agent: "hermes",
      lastCompletedStep: "policies",
      lastStepStarted: "agent_setup",
    });
    session.steps.gateway = {
      status: "complete",
      startedAt: completedAt,
      completedAt,
      error: null,
    };
    session.steps.policies = {
      status: "complete",
      startedAt: completedAt,
      completedAt,
      error: null,
    };
    session.steps.agent_setup = {
      status: "in_progress",
      startedAt,
      completedAt: null,
      error: "interrupted",
    };

    clearAgentScopedResumeState(session, "langchain-deepagents-code");

    expect(session.steps.gateway).toEqual({
      status: "complete",
      startedAt: completedAt,
      completedAt,
      error: null,
    });
    expect(session.steps.policies).toEqual({
      status: "pending",
      startedAt: null,
      completedAt: null,
      error: null,
    });
    expect(session.steps.agent_setup).toEqual({
      status: "pending",
      startedAt: null,
      completedAt: null,
      error: null,
    });
    expect(session.lastCompletedStep).toBe("gateway");
    expect(session.lastStepStarted).toBeNull();
  });

  it("invalidates agent-scoped checkpoint decisions and effect receipts", () => {
    const session = createSession({
      agent: null,
      sandboxName: "my-sandbox",
      sandboxPromptProgress: {
        sandboxName: true,
        webSearch: true,
        messaging: true,
        resourceProfile: true,
      },
    });
    session.checkpoint = {
      ...deriveCheckpointFromSession(session),
      sandboxIdentity: decisionSelected({ name: "my-sandbox", agent: "openclaw" }),
      resourceProfile: decisionSelected({ cpu: "4", memory: "8Gi" }),
      effectGroups: {
        sandbox_create: { completedAt: session.updatedAt, fingerprint: "create" },
        sandbox_register: { completedAt: session.updatedAt, fingerprint: "register" },
      },
      bindings: {
        credentialEnvs: ["SLACK_TOKEN"],
        registeredProviders: [
          { name: "my-sandbox-slack", type: "generic", credentialEnv: "SLACK_TOKEN" },
        ],
      },
    };

    clearAgentScopedResumeState(session, "hermes");

    expect(session.checkpoint).toMatchObject({
      sandboxIdentity: { kind: "unset" },
      webSearch: { kind: "unset" },
      messaging: { kind: "unset" },
      effectGroups: {},
      bindings: { credentialEnvs: [], registeredProviders: [] },
    });
    expect(session.checkpoint?.resourceProfile.kind).not.toBe("unset");
  });

  it("invalidates a legacy sandbox identity when the selected agent changes", () => {
    const session = createSession({
      sandboxName: "my-sandbox",
      sandboxPromptProgress: {
        sandboxName: true,
        webSearch: true,
        messaging: true,
        resourceProfile: true,
      },
    });

    clearAgentScopedResumeState(session, "hermes");

    expect(session.checkpoint).toBeNull();
    expect(session.sandboxPromptProgress.sandboxName).toBe(false);
    expect(checkpointSandboxIdentityMatches(session, "my-sandbox")).toBe(false);
  });
});
