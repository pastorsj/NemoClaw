// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createSession,
  filterSafeUpdates,
  hasInvalidSessionHarnessPackage,
  normalizeSession,
  saveSession,
  summarizeForDebug,
} from "./onboard-session";

type LegacySession = Omit<ReturnType<typeof createSession>, "machine"> & {
  machine?: unknown;
};

const VERIFIED_RECOVERY = {
  reason: "retained_after_sandbox_creation_failure" as const,
  sandboxName: "retained-sb",
  sandboxIdentityFingerprint: "a".repeat(64),
  gatewayName: "nemoclaw",
  gatewayPort: 8080,
  lifecycleGeneration: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  verifiedEffectivePolicyIdentity: {
    hash: "sha256:legacy",
    activeVersion: 4,
  },
  createAttemptNonce: "c".repeat(62),
  policyCreationReceipt: { schemaVersion: 1, policyHash: "sha256:legacy" },
  recordedAt: "2026-08-27T00:00:00.000Z",
};

function requireNormalizedSession(legacy: LegacySession) {
  const normalized = normalizeSession(legacy as Parameters<typeof normalizeSession>[0]);
  expect(normalized).not.toBeNull();
  return normalized!;
}

describe("onboard session normalization", () => {
  const harnessPackage = {
    kind: "agent-runtime" as const,
    id: "hermes",
    packageVersion: "2.0.0",
    contentDigest: "b".repeat(64),
  };
  const harnessPackageMigration = {
    schemaVersion: 1 as const,
    source: "legacy-current-bundle" as const,
    legacyAgent: "hermes",
    migratedAt: "2026-08-28T02:00:00.000Z",
  };

  it.each([null, "openclaw", "dcode", "pi", "nemocua"])(
    "keeps legacy package absence for agent=$agent without inference",
    (agent) => {
      const legacy = createSession({ agent }) as Partial<ReturnType<typeof createSession>>;
      delete legacy.harnessPackage;
      delete legacy.harnessPackageMigration;
      const normalized = requireNormalizedSession(legacy as LegacySession);

      expect(normalized.harnessPackage).toBeNull();
      expect(normalized.harnessPackageMigration).toBeNull();
      expect(hasInvalidSessionHarnessPackage(normalized)).toBe(false);
    },
  );

  it("normalizes valid identity and matching Session-owned migration provenance", () => {
    const normalized = requireNormalizedSession(
      createSession({ harnessPackage, harnessPackageMigration }),
    );

    expect(normalized.harnessPackage).toEqual(harnessPackage);
    expect(normalized.harnessPackageMigration).toEqual(harnessPackageMigration);
    expect(hasInvalidSessionHarnessPackage(normalized)).toBe(false);
  });

  it.each([
    {
      harnessPackage: { id: "hermes" },
      harnessPackageMigration: null,
    },
    {
      harnessPackage: null,
      harnessPackageMigration,
    },
    {
      harnessPackage,
      harnessPackageMigration: { ...harnessPackageMigration, legacyAgent: "openclaw" },
    },
    {
      harnessPackage: { ...harnessPackage, apiKey: "secret" },
      harnessPackageMigration: null,
    },
  ])("preserves an invalid-state signal for malformed present package authority", (fields) => {
    const raw = { ...createSession(), ...fields };
    const normalized = requireNormalizedSession(raw as unknown as LegacySession);

    expect(normalized.harnessPackage).toBeNull();
    expect(normalized.harnessPackageMigration).toBeNull();
    expect(hasInvalidSessionHarnessPackage(normalized)).toBe(true);
    expect(() => saveSession(raw as never)).toThrow(/harness package authority is invalid/u);
    expect(() => saveSession(normalized)).toThrow(/harness package authority is invalid/u);
  });

  it("preserves valid recovery-only cancellation state (#9833)", () => {
    const cancellationRecovery = {
      reason: "cancelled_after_sandbox_creation" as const,
      sandboxName: "retained-sb",
      sandboxIdentityFingerprint: "a".repeat(64),
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      lifecycleGeneration: "generation-1",
      createAttemptNonce: "c".repeat(62),
      recordedAt: "2026-08-27T00:00:00.000Z",
    };
    const normalized = normalizeSession({
      ...createSession({ sandboxName: "retained-sb" }),
      resumable: false,
      status: "recovery_required",
      cancellationRecovery,
    });

    expect(normalized).toMatchObject({
      sandboxName: "retained-sb",
      resumable: false,
      status: "recovery_required",
      cancellationRecovery,
    });
    expect(summarizeForDebug(normalized)?.cancellationRecovery).toEqual(cancellationRecovery);
  });

  it("fails closed when saved recovery authority is incomplete (#9833)", () => {
    const incompleteRecovery = {
      reason: "retained_after_sandbox_creation_failure" as const,
      sandboxName: "retained-sb",
      sandboxIdentityFingerprint: "a".repeat(64),
      recordedAt: "2026-08-27T00:00:00.000Z",
    };

    expect(() =>
      normalizeSession({
        ...createSession({ sandboxName: "retained-sb" }),
        resumable: false,
        status: "recovery_required",
        cancellationRecovery: incompleteRecovery,
      } as unknown as Parameters<typeof normalizeSession>[0]),
    ).toThrow(/saved recovery authority is incomplete/u);
  });

  it("strips every legacy policy field from saved recovery authority (#9833)", () => {
    const recovery = normalizeSession({
      ...createSession({ sandboxName: VERIFIED_RECOVERY.sandboxName }),
      resumable: false,
      status: "recovery_required",
      cancellationRecovery: VERIFIED_RECOVERY,
    })?.cancellationRecovery;
    expect(recovery).not.toHaveProperty("policyCreationReceipt");
    expect(recovery).not.toHaveProperty("verifiedEffectivePolicyIdentity");
    expect(recovery).toMatchObject({ createAttemptNonce: "c".repeat(62) });
  });

  it("keeps APF create intent and defaults legacy sessions to false (#9833)", () => {
    const selected = createSession({ apfInterceptorRequested: true });
    expect(normalizeSession(selected)?.apfInterceptorRequested).toBe(true);

    const legacy = { ...selected } as Partial<typeof selected>;
    delete legacy.apfInterceptorRequested;
    expect(
      normalizeSession(legacy as Parameters<typeof normalizeSession>[0])?.apfInterceptorRequested,
    ).toBe(false);
    expect(
      normalizeSession({ ...selected, apfInterceptorRequested: false })?.apfInterceptorRequested,
    ).toBe(false);
  });

  it("refuses malformed saved APF create intent instead of downgrading it (#9833)", () => {
    const selected = createSession({ apfInterceptorRequested: true });
    const malformed = { ...selected, apfInterceptorRequested: "true" };

    expect(() =>
      normalizeSession(malformed as unknown as Parameters<typeof normalizeSession>[0]),
    ).toThrow(/saved APF selection is invalid/u);
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
