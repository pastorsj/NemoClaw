// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxInferenceRouteReservationDisposition } from "./registry/route-reservation";
import type { PendingSandboxCreateIdentity } from "./registry/types";

function ownedReservation(disposition: SandboxInferenceRouteReservationDisposition) {
  expect(disposition.kind).toBe("owned");
  return (disposition as Extract<typeof disposition, { kind: "owned" }>).reservation;
}

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
  id: "hermes",
  packageVersion: "1.2.3",
  contentDigest: "c".repeat(64),
};
const HARNESS_PACKAGE_MIGRATION = {
  schemaVersion: 1 as const,
  source: "legacy-current-bundle" as const,
  legacyAgent: "hermes",
  migratedAt: "2026-08-28T04:00:00.000Z",
};
const CANDIDATE_PACKAGE_AUTHORITY = {
  harnessPackage: null,
  harnessPackageMigration: null,
} as const;
function reservationOwner(sessionId: string) {
  return { reservationSessionId: sessionId, ...CANDIDATE_PACKAGE_AUTHORITY } as const;
}
const EXACT_ROUTE_AUTHORITY = {
  sandboxName: "alpha",
  gatewayName: "nemoclaw",
  sessionId: "session-owner",
  selection: EXACT_ROUTE_SELECTION,
  harnessPackage: HARNESS_PACKAGE,
  harnessPackageMigration: HARNESS_PACKAGE_MIGRATION,
} as const;
const EXACT_ROUTE_RESERVATION = {
  name: EXACT_ROUTE_AUTHORITY.sandboxName,
  gatewayName: EXACT_ROUTE_AUTHORITY.gatewayName,
  reservationSessionId: EXACT_ROUTE_AUTHORITY.sessionId,
  pendingRouteReservation: true as const,
  ...EXACT_ROUTE_SELECTION,
  harnessPackage: HARNESS_PACKAGE,
  harnessPackageMigration: HARNESS_PACKAGE_MIGRATION,
};
const LIFECYCLE_GENERATION = "123e4567-e89b-42d3-a456-426614174983";
const LIVE_IDENTITY_FINGERPRINT = "a".repeat(64);
function managedCheckpoint(
  overrides: Partial<
    Pick<
      PendingSandboxCreateIdentity,
      | "gatewayPort"
      | "harnessPackage"
      | "lifecycleGeneration"
      | "sandboxIdentityFingerprint"
      | "route"
    >
  > = {},
): PendingSandboxCreateIdentity {
  const boundary = {
    gatewayPort: 8080,
    lifecycleGeneration: LIFECYCLE_GENERATION,
    sandboxIdentityFingerprint: LIVE_IDENTITY_FINGERPRINT,
    route: "none" as const,
    harnessPackage: HARNESS_PACKAGE,
    ...overrides,
  };
  return {
    schemaVersion: 1,
    state: "verified-create",
    gatewayName: EXACT_ROUTE_AUTHORITY.gatewayName,
    sandboxName: EXACT_ROUTE_AUTHORITY.sandboxName,
    ...boundary,
  };
}
const EXACT_QUALIFIED_ROUTE_RESERVATION = {
  name: EXACT_ROUTE_AUTHORITY.sandboxName,
  gatewayName: EXACT_ROUTE_AUTHORITY.gatewayName,
  reservationSessionId: EXACT_ROUTE_AUTHORITY.sessionId,
  pendingRouteReservation: true as const,
  provider: EXACT_ROUTE_SELECTION.provider,
  model: EXACT_ROUTE_SELECTION.model,
  endpointUrl: EXACT_ROUTE_SELECTION.endpointUrl,
  endpointSource: EXACT_ROUTE_SELECTION.endpointSource,
  credentialEnv: EXACT_ROUTE_SELECTION.credentialEnv,
  preferredInferenceApi: EXACT_ROUTE_SELECTION.preferredInferenceApi,
  harnessPackage: HARNESS_PACKAGE,
  harnessPackageMigration: HARNESS_PACKAGE_MIGRATION,
};

describe("sandbox inference route reservation qualification (#9203)", () => {
  it.each([
    ["owned", EXACT_QUALIFIED_ROUTE_RESERVATION, "owned"],
    ["missing", null, "missing"],
    ["ownerless", { ...EXACT_ROUTE_RESERVATION, reservationSessionId: undefined }, "conflict"],
    [
      "foreign-session",
      { ...EXACT_ROUTE_RESERVATION, reservationSessionId: "another-session" },
      "conflict",
    ],
    ["mismatched-sandbox", { ...EXACT_ROUTE_RESERVATION, name: "beta" }, "conflict"],
    [
      "mismatched-gateway",
      { ...EXACT_ROUTE_RESERVATION, gatewayName: "other-gateway" },
      "conflict",
    ],
    ["mismatched-route", { ...EXACT_ROUTE_RESERVATION, model: "another-model" }, "conflict"],
    ["malformed", { ...EXACT_ROUTE_RESERVATION, gatewayPort: 0 }, "conflict"],
    [
      "completed",
      { ...EXACT_ROUTE_RESERVATION, createdAt: "2026-08-18T00:00:00.000Z" },
      "conflict",
    ],
    ["sandbox-authority", { ...EXACT_ROUTE_RESERVATION, agent: "hermes" }, "conflict"],
  ])("classifies %s reservation authority", async (_case, entry, expectedKind) => {
    const { classifySandboxInferenceRouteReservation } =
      await import("./registry/route-reservation");
    expect(classifySandboxInferenceRouteReservation(EXACT_ROUTE_AUTHORITY, entry).kind).toBe(
      expectedKind,
    );
  });

  it("admits bounded portable recreate carry metadata without sandbox authority (#10056)", async () => {
    const { classifySandboxInferenceRouteReservation } =
      await import("./registry/route-reservation");
    const disposition = classifySandboxInferenceRouteReservation(EXACT_ROUTE_AUTHORITY, {
      ...EXACT_QUALIFIED_ROUTE_RESERVATION,
      dashboardPort: 8080,
      webSearchEnabled: false,
      webSearchProvider: null,
    });

    expect(disposition.kind).toBe("owned");
  });

  it("recognizes only an exact verified-create checkpoint overlay as pending authority (#10423)", async () => {
    const { classifySandboxInferenceRouteReservation, isCurrentSandboxInferenceRouteReservation } =
      await import("./registry/route-reservation");
    const admitted = ownedReservation(
      classifySandboxInferenceRouteReservation(
        EXACT_ROUTE_AUTHORITY,
        EXACT_QUALIFIED_ROUTE_RESERVATION,
      ),
    );
    const checkpoint = managedCheckpoint();
    const pending = {
      ...EXACT_QUALIFIED_ROUTE_RESERVATION,
      gatewayPort: checkpoint.gatewayPort,
      lifecycleGeneration: checkpoint.lifecycleGeneration,
      lifecycleLiveIdentityFingerprint: checkpoint.sandboxIdentityFingerprint,
      pendingCreateIdentity: checkpoint,
    };

    expect(classifySandboxInferenceRouteReservation(EXACT_ROUTE_AUTHORITY, pending).kind).toBe(
      "owned",
    );
    expect(isCurrentSandboxInferenceRouteReservation(admitted, pending)).toBe(true);
    expect(
      classifySandboxInferenceRouteReservation(EXACT_ROUTE_AUTHORITY, {
        ...pending,
        gatewayPort: 8081,
      }),
    ).toMatchObject({
      kind: "conflict",
      detail: "the inference route reservation verified create checkpoint is malformed",
    });
  });

  it.each([
    ["invalid dashboard port", { dashboardPort: 0 }],
    ["non-boolean web search state", { webSearchEnabled: "yes" }],
    ["unknown web search provider", { webSearchProvider: "unknown" }],
  ])("rejects %s in carried route metadata (#10056)", async (_case, updates) => {
    const { classifySandboxInferenceRouteReservation } =
      await import("./registry/route-reservation");
    const entry = {
      ...EXACT_QUALIFIED_ROUTE_RESERVATION,
      ...updates,
    } as Parameters<typeof classifySandboxInferenceRouteReservation>[1];

    expect(classifySandboxInferenceRouteReservation(EXACT_ROUTE_AUTHORITY, entry)).toMatchObject({
      kind: "conflict",
      detail: "the inference route reservation carry metadata is malformed",
    });
  });

  it.each([
    ["mismatched agent", { agent: "openclaw" }],
    [
      "workload",
      { workload: { schemaVersion: 1, kind: "legacy-dockerfile", reference: null, shared: false } },
    ],
    ["lifecycle", { lifecycleGeneration: "11111111-1111-4111-8111-111111111111" }],
  ])(
    "still rejects %s sandbox authority on a carried reservation (#10056)",
    async (_case, updates) => {
      const { classifySandboxInferenceRouteReservation } =
        await import("./registry/route-reservation");
      const entry = {
        ...EXACT_QUALIFIED_ROUTE_RESERVATION,
        ...updates,
      } as Parameters<typeof classifySandboxInferenceRouteReservation>[1];

      expect(classifySandboxInferenceRouteReservation(EXACT_ROUTE_AUTHORITY, entry)).toMatchObject({
        kind: "conflict",
        detail: "the inference route reservation has sandbox authority",
      });
    },
  );
});

describe("pending reservation ownership (#6562)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("keeps the reserving session's row but treats another session's as abandoned", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-ownership-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.reserveSandboxInferenceRoute("alpha", {
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: "https://api.example.test/v1",
        credentialEnv: "CUSTOM_API_KEY",
        preferredInferenceApi: "openai-responses",
        gatewayName: "nemoclaw-9090",
        ...reservationOwner("session-owner"),
      });
      const reserved = registry.getSandbox("alpha");

      expect(registry.isPendingReservationForSession(reserved, "session-owner")).toBe(true);
      expect(registry.isPendingReservationForSession(reserved, "session-other")).toBe(false);
      expect(registry.isPendingReservationForSession(reserved, null)).toBe(false);
      expect(registry.isPendingReservationForSession(reserved, undefined)).toBe(false);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("never preserves a fully registered sandbox or a missing row (#6562)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-ownership-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.registerSandbox({
        name: "beta",
        provider: "nvidia-prod",
        model: "model-a",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
      });

      expect(
        registry.isPendingReservationForSession(registry.getSandbox("beta"), "session-owner"),
      ).toBe(false);
      expect(registry.isPendingReservationForSession(null, "session-owner")).toBe(false);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
