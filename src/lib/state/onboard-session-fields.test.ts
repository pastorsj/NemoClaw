// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeMessagingPlan } from "../../../test/helpers/messaging-plan-fixtures";

const originalHome = process.env.HOME;
type OnboardSessionModule = typeof import("./onboard-session");
type LoadedSession = NonNullable<ReturnType<OnboardSessionModule["loadSession"]>>;
type DebugSummary = NonNullable<ReturnType<OnboardSessionModule["summarizeForDebug"]>>;
let session: OnboardSessionModule;
let temporaryHome: string;

function requireLoadedSession(
  loaded: ReturnType<OnboardSessionModule["loadSession"]>,
): LoadedSession {
  expect(loaded).not.toBeNull();
  return loaded!;
}

function requireDebugSummary(
  summary: ReturnType<OnboardSessionModule["summarizeForDebug"]>,
): DebugSummary {
  expect(summary).not.toBeNull();
  return summary!;
}

beforeEach(async () => {
  temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-session-fields-"));
  process.env.HOME = temporaryHome;
  vi.resetModules();
  session = await import("./onboard-session");
  session.clearSession();
  session.releaseOnboardLock();
});

afterEach(() => {
  vi.resetModules();
  fs.rmSync(temporaryHome, { recursive: true, force: true });
  originalHome === undefined
    ? Reflect.deleteProperty(process.env, "HOME")
    : Object.assign(process.env, { HOME: originalHome });
});

describe("onboard session persisted fields", () => {
  it("round-trips null messagingPlan through normalizeSession", () => {
    const created = session.createSession();
    expect(created.messagingPlan).toBeNull();
    const saved = session.saveSession(created);
    const loaded = requireLoadedSession(session.loadSession());
    expect(saved.messagingPlan).toBeNull();
    expect(loaded.messagingPlan).toBeNull();
  });

  it("round-trips messagingPlan through normalizeSession", () => {
    const plan = makeMessagingPlan({ channels: ["telegram"] });
    const created = session.createSession({ messagingPlan: plan });
    expect(created.messagingPlan).toEqual(plan);
    const saved = session.saveSession(created);
    const loaded = requireLoadedSession(session.loadSession());
    expect(saved.messagingPlan).toEqual(plan);
    expect(loaded.messagingPlan).toMatchObject({
      sandboxName: "my-assistant",
      channels: [expect.objectContaining({ channelId: "telegram", configured: true })],
    });
  });

  it("filterSafeUpdates preserves messagingPlan field", () => {
    session.saveSession(session.createSession());
    const plan = makeMessagingPlan({ channels: ["slack", "discord"] });
    session.markStepComplete("provider_selection", {
      messagingPlan: plan,
    });

    const loaded = requireLoadedSession(session.loadSession());
    expect(loaded.messagingPlan).toMatchObject({
      sandboxName: "my-assistant",
      channels: [
        expect.objectContaining({ channelId: "slack", configured: true }),
        expect.objectContaining({ channelId: "discord", configured: true }),
      ],
    });
  });

  it("filterSafeUpdates ignores malformed messagingPlan values", () => {
    session.saveSession(session.createSession());
    session.markStepComplete("provider_selection", {
      messagingPlan: { sandboxName: "my-assistant" },
    } as unknown as Parameters<OnboardSessionModule["markStepComplete"]>[1]);

    const loaded = requireLoadedSession(session.loadSession());
    expect(loaded.messagingPlan).toBeNull();
  });

  it("routes telegramConfig through markStepComplete in filterSafeUpdates (#1737)", () => {
    session.saveSession(session.createSession());
    session.markStepComplete("provider_selection", {
      telegramConfig: { requireMention: true },
    });

    const loaded = session.loadSession()!;
    expect(loaded.telegramConfig).toEqual({ requireMention: true });

    // Explicit null (clearing the field) should also round-trip.
    session.markStepComplete("provider_selection", { telegramConfig: null });
    const cleared = session.loadSession()!;
    expect(cleared.telegramConfig).toBeNull();
  });

  it("drops malformed telegramConfig values in filterSafeUpdates (#1737)", () => {
    session.saveSession(session.createSession());
    // Non-boolean requireMention — must not leak through.
    session.markStepComplete("provider_selection", {
      telegramConfig: { requireMention: "yes" } as unknown as { requireMention: boolean },
    });

    const loaded = session.loadSession()!;
    expect(loaded.telegramConfig).toBeNull();
  });

  it("filterSafeUpdates routes wechatConfig through markStepComplete", () => {
    session.saveSession(session.createSession());
    session.markStepComplete("provider_selection", {
      wechatConfig: { accountId: "primary", baseUrl: "https://x", userId: "u" },
    });

    const loaded = session.loadSession()!;
    expect(loaded.wechatConfig).toEqual({
      accountId: "primary",
      baseUrl: "https://x",
      userId: "u",
    });

    // Explicit null clears the field (used when WeChat is removed from the
    // enabled channels on a subsequent onboard).
    session.markStepComplete("provider_selection", { wechatConfig: null });
    const cleared = session.loadSession()!;
    expect(cleared.wechatConfig).toBeNull();
  });

  it("filterSafeUpdates drops malformed wechatConfig values", () => {
    session.saveSession(session.createSession());
    session.markStepComplete("provider_selection", {
      wechatConfig: { accountId: 9000 } as unknown as { accountId: string },
    });

    const loaded = session.loadSession()!;
    expect(loaded.wechatConfig).toBeNull();
  });

  it("creates a session with a messagingPlan override", () => {
    const plan = makeMessagingPlan({ channels: ["telegram", "slack"] });
    const created = session.createSession({ messagingPlan: plan });
    expect(created.messagingPlan).toEqual(plan);
    expect(created.provider).toBeNull();
  });

  it("summarizes the session for debug output", () => {
    session.saveSession(session.createSession({ sandboxName: "my-assistant" }));
    session.markStepStarted("preflight");
    session.markStepComplete("preflight");
    session.completeSession();
    const summary = requireDebugSummary(session.summarizeForDebug());

    expect(summary.sandboxName).toBe("my-assistant");
    expect(summary.steps.preflight.status).toBe("complete");
    expect(summary.steps.preflight.startedAt).toBeTruthy();
    expect(summary.steps.preflight.completedAt).toBeTruthy();
    expect(summary.resumable).toBe(false);
  });

  it("keeps debug summaries redacted when failures were sanitized", () => {
    session.saveSession(
      session.createSession({
        sandboxName: "my-assistant",
        failure: {
          step: "provider_selection",
          message: "Bearer abcdefghijklmnopqrstuvwxyz",
          recordedAt: "2026-04-01T00:00:00.000Z",
        },
      }),
    );
    const summary = requireDebugSummary(session.summarizeForDebug());

    expect(summary.failure).not.toBeNull();
    expect(summary.failure!.message).toContain("Bearer <REDACTED>");
    expect(summary.failure!.message).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("re-sanitizes in-memory failures in debug summaries", () => {
    const rawSession = session.createSession({
      failure: {
        step: "provider_selection",
        message: "Bearer abcdefghijklmnopqrstuvwxyz",
        recordedAt: "2026-04-01T00:00:00.000Z",
      },
    });

    const summary = requireDebugSummary(session.summarizeForDebug(rawSession));
    expect(summary.failure).not.toBeNull();
    expect(summary.failure!.message).toContain("Bearer <REDACTED>");
    expect(summary.failure!.message).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });
});
