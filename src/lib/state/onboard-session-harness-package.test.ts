// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type OnboardSessionModule = typeof import("./onboard-session");
let session: OnboardSessionModule;
let temporaryHome: string;

beforeEach(async () => {
  temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-harness-session-"));
  vi.stubEnv("HOME", temporaryHome);
  vi.resetModules();
  session = await import("./onboard-session");
  session.clearSession();
});

afterEach(() => {
  session.clearSession();
  vi.resetModules();
  fs.rmSync(temporaryHome, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("onboard session harness package authority", () => {
  it("persists selected authority while accepting legacy sessions", () => {
    const harnessPackage = {
      source: "installed" as const,
      contentDigest: "a".repeat(64),
    };
    session.saveSession(session.createSession({ harnessPackage }));

    expect(session.loadSession()?.harnessPackage).toEqual(harnessPackage);

    const legacy = session.createSession() as unknown as Record<string, unknown>;
    delete legacy.harnessPackage;
    expect(session.normalizeSession(legacy as never)?.harnessPackage).toBeNull();
  });

  it("rejects malformed persisted authority", () => {
    const malformed = session.createSession() as unknown as Record<string, unknown>;
    malformed.harnessPackage = {
      source: "installed",
      contentDigest: "not-a-digest",
    };

    expect(session.normalizeSession(malformed as never)).toBeNull();
  });
});
