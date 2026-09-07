// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { createSession } from "../state/onboard-session";
import {
  applyOnboardRuntimeControlRequests,
  planSelectedAgentTransition,
  updateSessionAgent,
} from "./runtime-control-flow";

afterEach(() => {
  delete process.env.NEMOCLAW_TOOL_DISCLOSURE;
});

describe("onboard runtime control flow", () => {
  it("normalizes explicit runtime control requests for session bootstrap", () => {
    expect(
      applyOnboardRuntimeControlRequests({
        toolDisclosure: "direct",
        observabilityEnabled: true,
        dcodeAutoApprovalMode: "thread-opt-in",
      }),
    ).toEqual({
      requestedToolDisclosure: "direct",
      requestedObservabilityEnabled: true,
      requestedDcodeAutoApprovalMode: "thread-opt-in",
    });
    delete process.env.NEMOCLAW_TOOL_DISCLOSURE;
    expect(applyOnboardRuntimeControlRequests({})).toEqual({
      requestedToolDisclosure: null,
      requestedObservabilityEnabled: null,
      requestedDcodeAutoApprovalMode: null,
    });
  });

  it("keeps an authoritative inherited observability value out of explicit request handling", () => {
    expect(
      applyOnboardRuntimeControlRequests({
        observabilityEnabled: false,
        observabilityRequestedExplicitly: false,
      }),
    ).toEqual({
      requestedToolDisclosure: null,
      requestedObservabilityEnabled: null,
      requestedDcodeAutoApprovalMode: null,
    });
  });

  it("records the selected DCode agent when observability is enabled", () => {
    const session = createSession({ observabilityEnabled: true });

    expect(updateSessionAgent(session, "langchain-deepagents-code")).toBe(session);
    expect(session.agent).toBe("langchain-deepagents-code");
  });

  it("preserves observability for an unknown receipt-backed package that declares it", () => {
    const session = createSession({
      agent: "future-harness",
      harnessPackage: {
        kind: "agent-runtime",
        id: "future-harness",
        packageVersion: "1.0.0-test",
        contentDigest: "f".repeat(64),
      },
      observabilityEnabled: true,
    });

    expect(
      updateSessionAgent(session, "future-harness", {
        error: vi.fn(),
        exitProcess: vi.fn(() => {
          throw new Error("exit 1");
        }),
        getRegisteredAgent: () =>
          ({
            name: "future-harness",
            sandbox_create: { startup_controls: ["observability"] },
          }) as never,
      }),
    ).toBe(session);
    expect(session.agent).toBe("future-harness");
  });

  it("rejects receipt-backed observability when the package omits the control", () => {
    const session = createSession({
      agent: "future-harness",
      harnessPackage: {
        kind: "agent-runtime",
        id: "future-harness",
        packageVersion: "1.0.0-test",
        contentDigest: "f".repeat(64),
      },
      observabilityEnabled: true,
    });
    const error = vi.fn();
    const exitProcess = vi.fn(() => {
      throw new Error("exit 1");
    });

    expect(() =>
      updateSessionAgent(session, "future-harness", {
        error,
        exitProcess,
        getRegisteredAgent: () => ({ name: "future-harness" }) as never,
      }),
    ).toThrow("exit 1");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("declares the observability"));
  });

  it("rejects enabled observability for a non-DCode agent", () => {
    const session = createSession({
      agent: "langchain-deepagents-code",
      observabilityEnabled: true,
      provider: "nvidia",
      routerPid: 1234,
    });
    const before = structuredClone(session);
    const error = vi.fn();
    const exitProcess = vi.fn(() => {
      throw new Error("exit 1");
    });

    expect(() => updateSessionAgent(session, "openclaw", { error, exitProcess })).toThrow("exit 1");
    expect(error).toHaveBeenCalledWith(
      "  Recorded observability belongs to Deep Agents Code. Pass --no-observability explicitly when switching agents.",
    );
    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(session).toEqual(before);
  });

  it("rejects an invalid resumed agent transition before router or session mutation", () => {
    const session = createSession({
      agent: "langchain-deepagents-code",
      observabilityEnabled: true,
      provider: "nvidia",
      routerPid: 1234,
    });
    const before = structuredClone(session);
    const stopTrackedModelRouterForAgentChange = vi.fn(async () => undefined);
    const clearAgentScopedResumeState = vi.fn((current) => current);
    const updateSession = vi.fn((mutator) => mutator(session) ?? session);
    const note = vi.fn();
    const error = vi.fn();
    const exitProcess = vi.fn(() => {
      throw new Error("exit 1");
    });

    expect(() =>
      planSelectedAgentTransition(
        {
          resume: true,
          session,
          selectedAgentName: "openclaw",
          routerPort: 4000,
          note,
        },
        {
          stopTrackedModelRouterForAgentChange,
          clearAgentScopedResumeState,
          updateSession,
          error,
          exitProcess,
        },
      ),
    ).toThrow("exit 1");

    expect(stopTrackedModelRouterForAgentChange).not.toHaveBeenCalled();
    expect(clearAgentScopedResumeState).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
    expect(session).toEqual(before);
  });

  it("plans without effects and commits router cleanup before durable session clearing (#7411)", async () => {
    const session = createSession({
      agent: "langchain-deepagents-code",
      provider: "nvidia",
      routerPid: 1234,
    });
    const before = structuredClone(session);
    const effects: string[] = [];
    const updateSession = vi.fn((mutator) => {
      effects.push("update-session");
      return mutator(session) ?? session;
    });

    const plan = planSelectedAgentTransition(
      {
        resume: true,
        session,
        selectedAgentName: "openclaw",
        routerPort: 4000,
        note: () => undefined,
      },
      {
        stopTrackedModelRouterForAgentChange: async () => {
          effects.push("stop-router");
        },
        updateSession,
      },
    );

    expect(plan.resumeAgentChanged).toBe(true);
    expect(plan.session.routerPid).toBeNull();
    expect(effects).toEqual([]);
    expect(updateSession).not.toHaveBeenCalled();
    expect(session).toEqual(before);

    await plan.commit();

    expect(effects).toEqual(["stop-router", "update-session"]);
    expect(session.routerPid).toBeNull();
  });

  it("preserves durable session state when the Model Router stop fails", async () => {
    const session = createSession({
      agent: "langchain-deepagents-code",
      provider: "nvidia",
      routerPid: 1234,
    });
    const before = structuredClone(session);
    const updateSession = vi.fn((mutator) => mutator(session) ?? session);
    const plan = planSelectedAgentTransition(
      {
        resume: true,
        session,
        selectedAgentName: "openclaw",
        routerPort: 4000,
        note: () => undefined,
      },
      {
        stopTrackedModelRouterForAgentChange: async () => {
          throw new Error("Model Router stop failed");
        },
        updateSession,
      },
    );

    await expect(plan.commit()).rejects.toThrow("Model Router stop failed");

    expect(updateSession).not.toHaveBeenCalled();
    expect(session).toEqual(before);
  });
});
