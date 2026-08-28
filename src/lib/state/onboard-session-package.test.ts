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
  temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-package-session-"));
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

describe("onboard session package persistence", () => {
  it("round-trips exact fresh authority through the real session file", () => {
    const harnessPackage = {
      kind: "agent-runtime" as const,
      id: "openclaw",
      packageVersion: "1.2.3",
      contractVersion: 1 as const,
      contentDigest: "a".repeat(64),
    };
    const saved = session.saveSession(session.createSession({ harnessPackage }));
    const persisted = JSON.parse(fs.readFileSync(session.SESSION_FILE, "utf8"));
    const loaded = session.loadSession();

    expect(saved.harnessPackage).toEqual(harnessPackage);
    expect(saved.harnessPackageMigration).toBeNull();
    expect(persisted.harnessPackage).toEqual(harnessPackage);
    expect(persisted.harnessPackageMigration).toBeNull();
    expect(loaded?.harnessPackage).toEqual(harnessPackage);
    expect(loaded?.harnessPackageMigration).toBeNull();
    expect(session.hasInvalidSessionHarnessPackage(loaded)).toBe(false);
  });
});
