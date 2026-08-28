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
const CANDIDATE_PACKAGE_AUTHORITY = {
  harnessPackage: null,
  harnessPackageMigration: null,
} as const;

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
    ["id", { harnessPackage: { ...HARNESS_PACKAGE, id: "hermes" } }],
    ["package version", { harnessPackage: { ...HARNESS_PACKAGE, packageVersion: "1.2.4" } }],
    ["contract version", { harnessPackage: { ...HARNESS_PACKAGE, contractVersion: 2 } }],
    ["content digest", { harnessPackage: { ...HARNESS_PACKAGE, contentDigest: "f".repeat(64) } }],
    ["migration", { harnessPackageMigration: HARNESS_PACKAGE_MIGRATION }],
  ])("rejects %s drift on an exact route retry without changing the row", async (_field, drift) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-package-drift-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      const route = {
        ...EXACT_ROUTE_SELECTION,
        gatewayName: "nemoclaw",
        reservationSessionId: "session-owner",
        harnessPackage: HARNESS_PACKAGE,
        harnessPackageMigration: null,
      } as const;
      expect(registry.reserveSandboxInferenceRoute("alpha", route)).toBe(true);
      expect(registry.reserveSandboxInferenceRoute("alpha", route)).toBe(true);
      const before = registry.getSandbox("alpha");

      expect(() =>
        registry.reserveSandboxInferenceRoute("alpha", { ...route, ...drift } as never),
      ).toThrow(/(?:harness package authority|package authority is malformed)/u);
      expect(registry.getSandbox("alpha")).toEqual(before);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("requires an explicit complete package pair for a session-owned route", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-package-pair-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      expect(() =>
        registry.reserveSandboxInferenceRoute("alpha", {
          ...EXACT_ROUTE_SELECTION,
          gatewayName: "nemoclaw",
          reservationSessionId: "session-owner",
          harnessPackage: HARNESS_PACKAGE,
        } as never),
      ).toThrow(/must contain one exact pair/u);
      expect(registry.getSandbox("alpha")).toBeNull();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("persists explicit candidate absence without nullable durable fields", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-candidate-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.reserveSandboxInferenceRoute("alpha", {
        ...EXACT_ROUTE_SELECTION,
        gatewayName: "nemoclaw",
        reservationSessionId: "session-owner",
        ...CANDIDATE_PACKAGE_AUTHORITY,
      });
      const entry = registry.getSandbox("alpha");
      expect(entry).not.toHaveProperty("harnessPackage");
      expect(entry).not.toHaveProperty("harnessPackageMigration");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("requires exact package authority before publishing a route reservation", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-package-publish-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      const authority = {
        harnessPackage: HARNESS_PACKAGE,
        harnessPackageMigration: HARNESS_PACKAGE_MIGRATION,
      } as const;
      registry.reserveSandboxInferenceRoute("alpha", {
        ...EXACT_ROUTE_SELECTION,
        gatewayName: "nemoclaw",
        reservationSessionId: "session-owner",
        ...authority,
      });
      const before = registry.getSandbox("alpha");

      expect(
        registry.finalizeSandboxRouteReservation("alpha", "session-owner", {
          ...authority,
          harnessPackage: { ...HARNESS_PACKAGE, contentDigest: "f".repeat(64) },
        }),
      ).toBe(false);
      expect(registry.getSandbox("alpha")).toEqual(before);
      expect(registry.finalizeSandboxRouteReservation("alpha", "session-owner", authority)).toBe(
        true,
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("rejects an ownerless update of a package-managed route", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-ownerless-package-route-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.reserveSandboxInferenceRoute("alpha", {
        ...EXACT_ROUTE_SELECTION,
        gatewayName: "nemoclaw",
        reservationSessionId: "session-owner",
        harnessPackage: HARNESS_PACKAGE,
        harnessPackageMigration: null,
      });
      const before = registry.getSandbox("alpha");

      expect(() =>
        registry.reserveSandboxInferenceRoute("alpha", {
          ...EXACT_ROUTE_SELECTION,
          gatewayName: "nemoclaw",
        }),
      ).toThrow(/package-managed sandbox .* ownerless route/u);
      expect(registry.getSandbox("alpha")).toEqual(before);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("cleans up only the exact package-managed reservation snapshot", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-package-route-cleanup-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.reserveSandboxInferenceRoute("alpha", {
        ...EXACT_ROUTE_SELECTION,
        gatewayName: "nemoclaw",
        reservationSessionId: "session-owner",
        harnessPackage: HARNESS_PACKAGE,
        harnessPackageMigration: HARNESS_PACKAGE_MIGRATION,
      });
      const reserved = registry.getSandbox("alpha")!;

      expect(
        registry.removeSandboxRouteReservationIfCurrent({
          ...reserved,
          harnessPackage: { ...HARNESS_PACKAGE, contentDigest: "f".repeat(64) },
        }),
      ).toBe(false);
      expect(registry.getSandbox("alpha")).toEqual(reserved);
      expect(registry.removeSandboxRouteReservationIfCurrent(reserved)).toBe(true);
      expect(registry.getSandbox("alpha")).toBeNull();
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
        harnessPackage: HARNESS_PACKAGE,
        harnessPackageMigration: null,
      });
      const reservation = registry.qualifyPendingSandboxCreateReservation(
        {
          sandboxName: "alpha",
          gatewayName: "nemoclaw",
          sessionId: "session-owner",
          selection: EXACT_ROUTE_SELECTION,
          harnessPackage: HARNESS_PACKAGE,
          harnessPackageMigration: null,
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
        ...CANDIDATE_PACKAGE_AUTHORITY,
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
        ...CANDIDATE_PACKAGE_AUTHORITY,
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
        ...CANDIDATE_PACKAGE_AUTHORITY,
      });
      const stale = registry.getSandbox("alpha")!;
      expect(
        registry.finalizeSandboxRouteReservation(
          "alpha",
          "session-old",
          CANDIDATE_PACKAGE_AUTHORITY,
        ),
      ).toBe(true);
      registry.reserveSandboxInferenceRoute("alpha", {
        ...EXACT_ROUTE_SELECTION,
        gatewayName: "nemoclaw",
        reservationSessionId: "session-new",
        ...CANDIDATE_PACKAGE_AUTHORITY,
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
