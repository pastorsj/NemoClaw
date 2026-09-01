// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveSandboxAgent } from "../sandbox-agent";
import { createSession, type Session } from "../../state/onboard-session";
import {
  createHarnessPackageFixture,
  type HarnessPackageFixture,
} from "../../../../test/helpers/harness-packages";
import { requireCurrentSessionHarnessPackageAuthority } from "./package-authority";

const PACKAGE_MIGRATION = {
  schemaVersion: 1 as const,
  source: "legacy-current-bundle" as const,
  legacyAgent: null,
  migratedAt: "2026-08-28T04:00:00.000Z",
};

let harnessFixture: HarnessPackageFixture;

beforeEach(() => {
  harnessFixture = createHarnessPackageFixture();
});

afterEach(() => {
  harnessFixture.cleanup();
});

function revalidateSession(expected: Session, current: Session, env: NodeJS.ProcessEnv = {}) {
  return requireCurrentSessionHarnessPackageAuthority(
    expected,
    "mutate the sandbox",
    { env, storeRoot: harnessFixture.storeRoot },
    { loadSession: () => current, resolveSandboxAgent },
  );
}

function runGuardedMutation(
  expected: Session,
  current: Session,
  mutation: (authority: unknown) => void,
  env: NodeJS.ProcessEnv = {},
): void {
  const authority = revalidateSession(expected, current, env);
  mutation(authority);
}

function installedPackageSession() {
  const installed = harnessFixture.install("openclaw");
  return {
    installed,
    session: createSession({
      agent: null,
      sessionId: "package-authority-session",
      harnessPackage: installed.identity,
      harnessPackageMigration: PACKAGE_MIGRATION,
    }),
  };
}

describe("current onboarding session package authority", () => {
  it("resolves the exact package identity and owner migration", () => {
    const { session } = installedPackageSession();

    const current = revalidateSession(session, session);

    expect(current.authority).toEqual({
      harnessPackage: session.harnessPackage,
      harnessPackageMigration: PACKAGE_MIGRATION,
    });
    expect(current.resolvedAgent).toMatchObject({
      recordedAgent: null,
      effectiveAgentId: "openclaw",
      harnessPackage: session.harnessPackage,
      harnessPackageMigration: PACKAGE_MIGRATION,
    });
  });

  it("keeps resolving the pinned object after the active pointer advances", () => {
    const { installed, session } = installedPackageSession();
    const active = harnessFixture.advanceActivePointer("openclaw");

    const current = revalidateSession(session, session);

    expect(current.resolvedAgent.definition.packageRoot).toBe(installed.packageRoot);
    expect(current.resolvedAgent.definition.packageRoot).not.toBe(active.packageRoot);
    expect(current.resolvedAgent.harnessPackage).toEqual(session.harnessPackage);
  });

  it.each([
    ["missing", (packageRoot: string) => fs.rmSync(packageRoot, { recursive: true, force: true })],
    [
      "corrupt",
      (packageRoot: string) =>
        fs.writeFileSync(path.join(packageRoot, "runtime/payload.txt"), "tampered\n"),
    ],
  ] as const)("refuses a %s pinned object before mutation", (_failure, damagePinnedObject) => {
    const { installed, session } = installedPackageSession();
    const active = harnessFixture.advanceActivePointer("openclaw");
    damagePinnedObject(installed.packageRoot);
    const mutation = vi.fn();

    expect(() => runGuardedMutation(session, session, mutation)).toThrow();
    expect(mutation).not.toHaveBeenCalled();
    expect(fs.existsSync(active.packageRoot)).toBe(true);
  });

  it.each([
    ["session ID", (current: Session): void => void (current.sessionId = "another-session")],
    ["agent", (current: Session): void => void (current.agent = "hermes")],
    [
      "identity",
      (current: Session): void =>
        void (current.harnessPackage = harnessFixture.advanceActivePointer("openclaw").identity),
    ],
    [
      "migration",
      (current: Session): void =>
        void (current.harnessPackageMigration = {
          ...PACKAGE_MIGRATION,
          migratedAt: "2026-08-28T04:00:01.000Z",
        }),
    ],
  ] as const)("refuses %s drift before mutation", (_drift, applyDrift) => {
    const { session: expected } = installedPackageSession();
    const current = structuredClone(expected);
    applyDrift(current);
    const mutation = vi.fn();

    expect(() => runGuardedMutation(expected, current, mutation)).toThrow(
      /onboarding session harness package authority changed/u,
    );
    expect(mutation).not.toHaveBeenCalled();
  });

  it.each([
    ["OpenClaw", null],
    ["Hermes", "hermes"],
    ["LangChain Deep Agents Code", "langchain-deepagents-code"],
    ["Pi", "pi"],
  ] as const)("refuses package-free standard agent %s before mutation", (_label, agent) => {
    const session = createSession({
      agent,
      harnessPackage: null,
      harnessPackageMigration: null,
      sessionId: "package-free-standard-session",
    });
    const mutation = vi.fn();

    expect(() => runGuardedMutation(session, session, mutation)).toThrow(
      /requires harness package migration/u,
    );
    expect(mutation).not.toHaveBeenCalled();
  });

  it("accepts explicitly package-free NemoCUA through its feature gate", () => {
    const session = createSession({
      agent: "nemocua",
      harnessPackage: null,
      harnessPackageMigration: null,
      sessionId: "qualified-nemocua-session",
    });

    const current = revalidateSession(session, session, { NEMOCLAW_CUA_ENABLED: "1" });

    expect(current.authority).toEqual({
      harnessPackage: null,
      harnessPackageMigration: null,
    });
    expect(current.resolvedAgent).toMatchObject({
      recordedAgent: "nemocua",
      effectiveAgentId: "nemocua",
      harnessPackage: null,
      harnessPackageMigration: null,
    });
  });
});
