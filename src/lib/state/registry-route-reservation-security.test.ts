// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const EXACT_ROUTE_SELECTION = {
  provider: "ollama-local",
  model: "qwen3-vl:4b",
  endpointUrl: "http://127.0.0.1:11434/v1",
  endpointSource: null,
  credentialEnv: null,
  preferredInferenceApi: "openai-completions",
  compatibleEndpointReasoning: null,
  compatibleEndpointReasoningEffort: null,
  nimContainer: null,
} as const;
const HARNESS_PACKAGE = {
  kind: "agent-runtime" as const,
  id: "openclaw",
  packageVersion: "1.2.3",
  contractVersion: 1 as const,
  contentDigest: "e".repeat(64),
};
const HARNESS_PACKAGE_MIGRATION = {
  schemaVersion: 1 as const,
  source: "legacy-current-bundle" as const,
  legacyAgent: null,
  migratedAt: "2026-08-28T04:00:00.000Z",
};

function managedCheckpoint(packageFields: Record<string, unknown> = {}) {
  const lifecycleGeneration = "123e4567-e89b-42d3-a456-426614174983";
  const sandboxIdentityFingerprint = "a".repeat(64);
  const policyHash = "sha256:policy-1";
  const policyVersion = 1;
  return {
    schemaVersion: 1 as const,
    state: "verified-create" as const,
    policyAuthority: "nemoclaw-managed" as const,
    observedPolicyAuthority: "owner-unknown" as const,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    sandboxName: "alpha",
    lifecycleGeneration,
    sandboxIdentityFingerprint,
    route: "none" as const,
    policyHash,
    policyVersion,
    policyCreationReceipt: {
      schemaVersion: 1 as const,
      origin: "sandbox-create" as const,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      sandboxName: "alpha",
      lifecycleGeneration,
      sandboxIdentityFingerprint,
      policyHash,
      policyVersion,
    },
    ...packageFields,
  };
}

describe("sandbox inference route reservation security", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each([
    ["credential-shaped identity", { harnessPackage: { ...HARNESS_PACKAGE, token: "secret" } }],
    ["partial identity", { harnessPackage: { id: "openclaw" } }],
    ["migration without identity", { harnessPackageMigration: HARNESS_PACKAGE_MIGRATION }],
    [
      "identity and migration disagreement",
      {
        harnessPackage: { ...HARNESS_PACKAGE, id: "hermes" },
        harnessPackageMigration: HARNESS_PACKAGE_MIGRATION,
      },
    ],
  ])("rejects %s before changing a registry row", async (_case, packageFields) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-package-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.registerSandbox({ name: "alpha", model: "safe" });
      const before = registry.getSandbox("alpha");

      expect(() =>
        registry.restoreSandboxEntry({ name: "alpha", ...packageFields } as never),
      ).toThrow(/invalid harness package authority/u);
      expect(registry.getSandbox("alpha")).toEqual(before);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it.each([
    ["partial nested identity", { harnessPackage: { id: "openclaw" } }],
    [
      "credential-shaped nested identity",
      { harnessPackage: { ...HARNESS_PACKAGE, apiKey: "secret" } },
    ],
    [
      "nested migration provenance",
      { harnessPackage: HARNESS_PACKAGE, harnessPackageMigration: HARNESS_PACKAGE_MIGRATION },
    ],
    ["identity drift", { harnessPackage: { ...HARNESS_PACKAGE, contentDigest: "f".repeat(64) } }],
  ])("rejects %s before recording a policy checkpoint", async (_case, packageFields) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-policy-package-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.restoreSandboxEntry({ name: "alpha", harnessPackage: HARNESS_PACKAGE });
      registry.reserveSandboxInferenceRoute("alpha", {
        ...EXACT_ROUTE_SELECTION,
        gatewayName: "nemoclaw",
        reservationSessionId: "session-owner",
      });
      const reservation = registry.qualifyPendingSandboxCreateReservation(
        {
          sandboxName: "alpha",
          gatewayName: "nemoclaw",
          sessionId: "session-owner",
          selection: EXACT_ROUTE_SELECTION,
        },
        registry.getSandbox("alpha"),
      );
      const before = registry.getSandbox("alpha");

      expect(() =>
        registry.recordPendingSandboxPolicyVerification(
          reservation,
          managedCheckpoint(packageFields) as never,
        ),
      ).toThrow(/(?:harness package authority|pending policy verification)/u);
      expect(registry.getSandbox("alpha")).toEqual(before);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("keeps a live reservation immutable until its row is explicitly abandoned (#9833)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      const original = {
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: "https://api.example.test/v1",
        credentialEnv: "CUSTOM_API_KEY",
        preferredInferenceApi: "openai-responses",
        gatewayName: "nemoclaw",
        reservationSessionId: "session-old",
      } as const;
      registry.reserveSandboxInferenceRoute("alpha", original);
      expect(registry.reserveSandboxInferenceRoute("alpha", original)).toBe(true);
      expect(() =>
        registry.reserveSandboxInferenceRoute("alpha", { ...original, model: "model-b" }),
      ).toThrow(/cannot change before the owning create transaction completes/u);

      const replacement = {
        provider: "compatible-endpoint",
        model: "model-b",
        endpointUrl: "https://api.example.test/v1",
        credentialEnv: "CUSTOM_API_KEY",
        preferredInferenceApi: "openai-responses",
        gatewayName: "nemoclaw",
        reservationSessionId: "session-new",
      } as const;

      expect(() => registry.reserveSandboxInferenceRoute("alpha", replacement)).toThrow(
        /belongs to another onboarding session/u,
      );
      expect(registry.getSandbox("alpha")).toMatchObject({
        model: "model-a",
        pendingRouteReservation: true,
        reservationSessionId: "session-old",
      });

      expect(registry.removeSandboxRouteReservationIfCurrent(registry.getSandbox("alpha")!)).toBe(
        true,
      );
      expect(registry.reserveSandboxInferenceRoute("alpha", replacement)).toBe(true);

      const reserved = registry.getSandbox("alpha");
      expect(reserved).toMatchObject({
        model: "model-b",
        pendingRouteReservation: true,
        reservationSessionId: "session-new",
      });
      expect(registry.isPendingReservationForSession(reserved, "session-new")).toBe(true);
      expect(registry.isPendingReservationForSession(reserved, "session-old")).toBe(false);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("does not treat an ownerless repeated reservation as idempotent (#9833)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      const ownerless = {
        ...EXACT_ROUTE_SELECTION,
        gatewayName: "nemoclaw",
      } as const;
      registry.reserveSandboxInferenceRoute("alpha", ownerless);

      expect(() => registry.reserveSandboxInferenceRoute("alpha", ownerless)).toThrow(
        /cannot change before the owning create transaction completes/u,
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("preserves a replacement when cleanup holds an earlier reservation snapshot (#9833)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.reserveSandboxInferenceRoute("alpha", {
        ...EXACT_ROUTE_SELECTION,
        gatewayName: "nemoclaw",
        reservationSessionId: "session-old",
      });
      const stale = registry.getSandbox("alpha")!;
      expect(registry.finalizeSandboxRouteReservation("alpha", "session-old")).toBe(true);
      registry.reserveSandboxInferenceRoute("alpha", {
        ...EXACT_ROUTE_SELECTION,
        gatewayName: "nemoclaw",
        reservationSessionId: "session-new",
      });

      expect(registry.removeSandboxRouteReservationIfCurrent(stale)).toBe(false);
      expect(registry.getSandbox("alpha")).toMatchObject({
        pendingRouteReservation: true,
        reservationSessionId: "session-new",
      });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
