// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SandboxInferenceRouteReservationDisposition } from "./registry/route-reservation";
import type { PendingSandboxCreateIdentity, SandboxEntry } from "./registry/types";

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
const ROUTE_SELECTION = {
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
const ROUTE_AUTHORITY = {
  sandboxName: "alpha",
  gatewayName: "nemoclaw",
  sessionId: "session-owner",
  selection: ROUTE_SELECTION,
  harnessPackage: HARNESS_PACKAGE,
  harnessPackageMigration: HARNESS_PACKAGE_MIGRATION,
} as const;

function ownedReservation(disposition: SandboxInferenceRouteReservationDisposition) {
  expect(disposition.kind).toBe("owned");
  return (disposition as Extract<typeof disposition, { kind: "owned" }>).reservation;
}

function createIdentityCheckpoint(): PendingSandboxCreateIdentity {
  return {
    schemaVersion: 1,
    state: "verified-create",
    gatewayName: ROUTE_AUTHORITY.gatewayName,
    gatewayPort: 8080,
    sandboxName: ROUTE_AUTHORITY.sandboxName,
    lifecycleGeneration: "123e4567-e89b-42d3-a456-426614174983",
    sandboxIdentityFingerprint: "a".repeat(64),
    route: "none",
    harnessPackage: HARNESS_PACKAGE,
  };
}

function completedEntry(checkpoint: PendingSandboxCreateIdentity): SandboxEntry {
  return {
    name: ROUTE_AUTHORITY.sandboxName,
    ...ROUTE_SELECTION,
    agent: "hermes",
    openshellDriver: "docker",
    gatewayName: ROUTE_AUTHORITY.gatewayName,
    gatewayPort: checkpoint.gatewayPort,
    lifecycleGeneration: checkpoint.lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: checkpoint.sandboxIdentityFingerprint,
    harnessPackage: HARNESS_PACKAGE,
    harnessPackageMigration: HARNESS_PACKAGE_MIGRATION,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("registry route package authority", () => {
  it("preserves exact package authority through route and create identity checkpoints", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-package-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.restoreSandboxEntry({
        name: ROUTE_AUTHORITY.sandboxName,
        harnessPackage: HARNESS_PACKAGE,
        harnessPackageMigration: HARNESS_PACKAGE_MIGRATION,
      });
      registry.reserveSandboxInferenceRoute(ROUTE_AUTHORITY.sandboxName, {
        ...ROUTE_SELECTION,
        gatewayName: ROUTE_AUTHORITY.gatewayName,
        reservationSessionId: ROUTE_AUTHORITY.sessionId,
        harnessPackage: HARNESS_PACKAGE,
        harnessPackageMigration: HARNESS_PACKAGE_MIGRATION,
      });
      const route = ownedReservation(
        registry.classifySandboxInferenceRouteReservation(
          ROUTE_AUTHORITY,
          registry.getSandbox(ROUTE_AUTHORITY.sandboxName),
        ),
      );
      const create = registry.qualifyPendingSandboxCreateReservation(
        ROUTE_AUTHORITY,
        registry.getSandbox(ROUTE_AUTHORITY.sandboxName),
      );
      expect(route.entry).toMatchObject({
        harnessPackage: HARNESS_PACKAGE,
        harnessPackageMigration: HARNESS_PACKAGE_MIGRATION,
      });

      const checkpoint = createIdentityCheckpoint();
      const pending = registry.recordPendingSandboxCreateIdentity(create, checkpoint);
      expect(pending).toMatchObject({
        harnessPackage: HARNESS_PACKAGE,
        harnessPackageMigration: HARNESS_PACKAGE_MIGRATION,
        pendingCreateIdentity: { harnessPackage: HARNESS_PACKAGE },
      });
      expect(pending.pendingCreateIdentity).not.toHaveProperty("harnessPackageMigration");
      expect(registry.isCurrentSandboxInferenceRouteReservation(route, pending)).toBe(true);

      const completed = completedEntry(checkpoint);
      expect(registry.sandboxRegistrationMatchesInferenceRouteReservation(completed, route)).toBe(
        true,
      );
      expect(
        registry.sandboxRegistrationMatchesInferenceRouteReservation(
          {
            ...completed,
            harnessPackage: { ...HARNESS_PACKAGE, contentDigest: "d".repeat(64) },
          },
          route,
        ),
      ).toBe(false);
      expect(
        registry.sandboxRegistrationMatchesInferenceRouteReservation(
          {
            ...completed,
            harnessPackageMigration: {
              ...HARNESS_PACKAGE_MIGRATION,
              migratedAt: "2026-08-28T04:00:01.000Z",
            },
          },
          route,
        ),
      ).toBe(false);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
