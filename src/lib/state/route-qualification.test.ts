// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SandboxInferenceRouteReservationDisposition } from "./registry/route-reservation";
import type { PendingSandboxPolicyVerification } from "./registry/types";

const HARNESS_PACKAGE = {
  kind: "agent-runtime" as const,
  id: "hermes",
  packageVersion: "1.2.3",
  contractVersion: 1 as const,
  contentDigest: "c".repeat(64),
};
const HARNESS_PACKAGE_MIGRATION = {
  schemaVersion: 1 as const,
  source: "legacy-current-bundle" as const,
  legacyAgent: "hermes",
  migratedAt: "2026-08-28T04:00:00.000Z",
};
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

function ownedReservation(disposition: SandboxInferenceRouteReservationDisposition) {
  expect(disposition.kind).toBe("owned");
  return (disposition as Extract<typeof disposition, { kind: "owned" }>).reservation;
}

function managedCheckpoint(): PendingSandboxPolicyVerification {
  const boundary = {
    gatewayPort: 8080,
    lifecycleGeneration: "123e4567-e89b-42d3-a456-426614174983",
    sandboxIdentityFingerprint: "a".repeat(64),
    route: "none" as const,
    policyHash: "sha256:policy-1",
    policyVersion: 1,
    harnessPackage: HARNESS_PACKAGE,
  };
  return {
    schemaVersion: 1,
    state: "verified-create",
    policyAuthority: "nemoclaw-managed",
    observedPolicyAuthority: "owner-unknown",
    gatewayName: EXACT_ROUTE_AUTHORITY.gatewayName,
    sandboxName: EXACT_ROUTE_AUTHORITY.sandboxName,
    ...boundary,
    policyCreationReceipt: {
      schemaVersion: 1,
      origin: "sandbox-create",
      gatewayName: EXACT_ROUTE_AUTHORITY.gatewayName,
      gatewayPort: boundary.gatewayPort,
      sandboxName: EXACT_ROUTE_AUTHORITY.sandboxName,
      lifecycleGeneration: boundary.lifecycleGeneration,
      sandboxIdentityFingerprint: boundary.sandboxIdentityFingerprint,
      policyHash: boundary.policyHash,
      policyVersion: boundary.policyVersion,
    },
  };
}

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
      policies: ["github"],
      policyPresetsFinalized: true,
      policyTier: "personal",
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
      pendingPolicyVerification: checkpoint,
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
    ["duplicate policies", { policies: ["github", "github"] }],
    ["control character in a policy", { policies: ["github\u0000"] }],
    ["control character in the policy tier", { policyTier: "personal\u0000" }],
    ["non-boolean policy finalization", { policyPresetsFinalized: "yes" }],
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
    ["agent", { agent: "hermes" }],
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
        policies: ["github"],
        ...updates,
      } as Parameters<typeof classifySandboxInferenceRouteReservation>[1];

      expect(classifySandboxInferenceRouteReservation(EXACT_ROUTE_AUTHORITY, entry)).toMatchObject({
        kind: "conflict",
        detail: "the inference route reservation has sandbox authority",
      });
    },
  );
});
