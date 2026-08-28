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
  it("distinguishes absent, valid, and malformed present Session state", () => {
    expect(session.readOnboardSessionState()).toEqual({ status: "absent" });

    const saved = session.saveSession(session.createSession({ agent: null }));
    expect(session.readOnboardSessionState()).toEqual({ status: "valid", session: saved });

    fs.writeFileSync(session.SESSION_FILE, "{not-json\n", { mode: 0o600 });
    expect(session.readOnboardSessionState()).toEqual({ status: "invalid" });
  });

  it.each([
    ["agent", (value: Record<string, unknown>) => Object.assign(value, { agent: 42 })],
    [
      "sandbox name",
      (value: Record<string, unknown>) => Object.assign(value, { sandboxName: ["sandbox"] }),
    ],
    [
      "machine snapshot",
      (value: Record<string, unknown>) =>
        Object.assign(value, {
          machine: { version: 1, state: "preflight", stateEnteredAt: null },
        }),
    ],
  ])("rejects a malformed present %s instead of inferring legacy state", (_field, mutate) => {
    session.saveSession(session.createSession({ agent: null, sandboxName: "strict-owner" }));
    const persisted = JSON.parse(fs.readFileSync(session.SESSION_FILE, "utf8")) as Record<
      string,
      unknown
    >;
    mutate(persisted);
    fs.writeFileSync(session.SESSION_FILE, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });

    expect(session.readOnboardSessionState()).toEqual({ status: "invalid" });
  });

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

  it.each([
    [
      "cancellation",
      (fingerprint: string) => session.markCancellationRecovery("retained-sb", fingerprint),
    ],
    [
      "post-create failure",
      (fingerprint: string) =>
        session.markRetainedSandboxRecovery(
          "retained-sb",
          "Sandbox creation failed after identity verification.",
          fingerprint,
        ),
    ],
  ])("copies exact package authority into independent %s recovery", (_case, markRecovery) => {
    const harnessPackage = {
      kind: "agent-runtime",
      id: "openclaw",
      packageVersion: "1.2.3",
      contractVersion: 1,
      contentDigest: "c".repeat(64),
    } as const;
    const harnessPackageMigration = {
      schemaVersion: 1,
      source: "legacy-current-bundle",
      legacyAgent: "openclaw",
      migratedAt: "2026-08-27T00:00:00.000Z",
    } as const;
    session.saveSession(
      session.createSession({
        sandboxName: "retained-sb",
        harnessPackage,
        harnessPackageMigration,
      }),
    );

    const saved = markRecovery("8".repeat(64));
    const [record] = session.listRetainedSandboxRecoveryRecords();

    expect(saved).toMatchObject({
      status: "recovery_required",
      resumable: false,
      harnessPackage,
      harnessPackageMigration,
    });
    expect(record).toMatchObject({ schemaVersion: 2, harnessPackage });
    expect(record).not.toHaveProperty("harnessPackageMigration");
  });

  it.each([
    ["missing", null],
    [
      "mismatched",
      {
        kind: "agent-runtime" as const,
        id: "openclaw",
        packageVersion: "1.2.3",
        contractVersion: 1 as const,
        contentDigest: "d".repeat(64),
      },
    ],
  ])("refuses %s standard package authority in a current recovery record", (_case, authority) => {
    session.saveSession(
      session.createSession({
        agent: "hermes",
        sandboxName: "retained-sb",
        harnessPackage: authority,
      }),
    );

    expect(() => session.markCancellationRecovery("retained-sb", "7".repeat(64))).toThrow(
      /without exact harness package authority/u,
    );
    expect(session.listRetainedSandboxRecoveryRecords()).toEqual([]);
  });

  it("records explicit null only for a qualified candidate recovery", () => {
    session.saveSession(
      session.createSession({
        agent: "pi",
        sandboxName: "retained-sb",
        harnessPackage: null,
        harnessPackageMigration: null,
      }),
    );

    session.markCancellationRecovery("retained-sb", "6".repeat(64));

    expect(session.listRetainedSandboxRecoveryRecords()).toMatchObject([
      { schemaVersion: 2, harnessPackage: null },
    ]);
  });
});
