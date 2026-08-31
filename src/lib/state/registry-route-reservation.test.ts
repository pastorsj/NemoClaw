// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serializedHostLocalInferenceReceipt } from "../../../test/helpers/host-local-inference-receipt";
import { testTimeoutOptions } from "../../../test/helpers/timeouts";
import type { InferenceSelection } from "../inference/selection";
import type { SandboxInferenceRouteReservationDisposition } from "./registry/route-reservation";
import type { PendingSandboxCreateIdentity, SandboxEntry } from "./registry/types";
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
function externalCheckpoint(
  overrides: Partial<Pick<PendingSandboxCreateIdentity, "route">> = {},
): PendingSandboxCreateIdentity {
  return {
    schemaVersion: 1,
    state: "verified-create",
    gatewayName: EXACT_ROUTE_AUTHORITY.gatewayName,
    gatewayPort: 8080,
    sandboxName: EXACT_ROUTE_AUTHORITY.sandboxName,
    lifecycleGeneration: LIFECYCLE_GENERATION,
    sandboxIdentityFingerprint: LIVE_IDENTITY_FINGERPRINT,
    route: "none",
    harnessPackage: HARNESS_PACKAGE,
    ...overrides,
  };
}
function createdSandboxRegistrationInput(
  sandboxName: string,
  gatewayName: string,
  inferenceSelection: InferenceSelection,
) {
  return {
    sandboxName,
    inferenceSelection,
    runtimeFields: {
      gpuEnabled: false,
      hostGpuDetected: false,
      sandboxGpuEnabled: false,
      sandboxGpuMode: "auto",
      sandboxGpuDevice: null,
      openshellDriver: "docker",
      openshellVersion: "0.1.2",
    },
    agent: null,
    agentVersionKnown: true,
    imageTag: null,
    workload: {
      schemaVersion: 1 as const,
      kind: "legacy-dockerfile" as const,
      reference: null,
      shared: false as const,
    },
    plannedMessagingState: undefined,
    hermesToolGateways: [],
    hermesDashboardState: { enabled: false, config: null },
    dashboardPort: 18789,
    gatewayName,
    gatewayPort: 8080,
  };
}
function reserveQualifiedRoute(registry: typeof import("./registry")) {
  registry.reserveSandboxInferenceRoute(EXACT_ROUTE_AUTHORITY.sandboxName, {
    ...EXACT_ROUTE_SELECTION,
    gatewayName: EXACT_ROUTE_AUTHORITY.gatewayName,
    reservationSessionId: EXACT_ROUTE_AUTHORITY.sessionId,
    harnessPackage: EXACT_ROUTE_AUTHORITY.harnessPackage,
    harnessPackageMigration: EXACT_ROUTE_AUTHORITY.harnessPackageMigration,
  });
  return ownedReservation(
    registry.classifySandboxInferenceRouteReservation(
      EXACT_ROUTE_AUTHORITY,
      registry.getSandbox(EXACT_ROUTE_AUTHORITY.sandboxName),
    ),
  );
}
function reserveQualifiedCreate(registry: typeof import("./registry")) {
  const route = reserveQualifiedRoute(registry);
  const create = registry.qualifyPendingSandboxCreateReservation(
    EXACT_ROUTE_AUTHORITY,
    registry.getSandbox(EXACT_ROUTE_AUTHORITY.sandboxName),
  );
  return { route, create };
}
function completedEntry(checkpoint: PendingSandboxCreateIdentity): SandboxEntry {
  return {
    name: EXACT_ROUTE_AUTHORITY.sandboxName,
    ...EXACT_ROUTE_SELECTION,
    agent: "hermes",
    openshellDriver: "docker",
    gatewayName: EXACT_ROUTE_AUTHORITY.gatewayName,
    gatewayPort: checkpoint.gatewayPort,
    lifecycleGeneration: checkpoint.lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: checkpoint.sandboxIdentityFingerprint,
    harnessPackage: HARNESS_PACKAGE,
    harnessPackageMigration: HARNESS_PACKAGE_MIGRATION,
  };
}
describe("sandbox inference route reservation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });
  it("persists a complete route without claiming the default sandbox", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      expect(
        registry.reserveSandboxInferenceRoute("alpha", {
          provider: "compatible-endpoint",
          model: "model-a",
          endpointUrl: "https://api.example.test/v1",
          credentialEnv: "CUSTOM_API_KEY",
          preferredInferenceApi: "openai-responses",
          gatewayName: "nemoclaw-9090",
        }),
      ).toBe(true);
      expect(registry.listSandboxes()).toMatchObject({
        defaultSandbox: null,
        sandboxes: [
          {
            name: "alpha",
            provider: "compatible-endpoint",
            model: "model-a",
            endpointUrl: "https://api.example.test/v1",
            credentialEnv: "CUSTOM_API_KEY",
            preferredInferenceApi: "openai-responses",
            gatewayName: "nemoclaw-9090",
          },
        ],
      });
      const reservation = registry.getSandbox("alpha");
      expect(reservation).not.toBeNull();
      const reservedEntry = reservation as NonNullable<typeof reservation>;
      expect(reservedEntry.createdAt).toBeUndefined();
      expect(registry.isRouteOnlySandboxReservation(reservedEntry)).toBe(true);
      expect(registry.getDefault()).toBeNull();
      expect(registry.setDefault("alpha")).toBe(false);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
  it.each([
    [
      "fresh Model Router route",
      "model-router",
      "nvidia-router",
      "nvidia-routed",
      "http://host.openshell.internal:4000/v1",
      "NVIDIA_INFERENCE_API_KEY",
      false,
    ],
    [
      "fresh Amazon Bedrock adapter route",
      "bedrock",
      "compatible-anthropic-endpoint",
      "anthropic.claude-3-5-sonnet-20240620-v1:0",
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/test/invoke",
      "COMPATIBLE_API_KEY",
      false,
    ],
    [
      "interrupted custom-endpoint resume",
      "resume",
      "compatible-endpoint",
      "test-model",
      "http://host.openshell.internal:19001/v1",
      "COMPATIBLE_API_KEY",
      true,
    ],
    [
      "missing-sandbox repair",
      "repair",
      "compatible-endpoint",
      "test-model",
      "http://host.openshell.internal:19002/v1",
      "COMPATIBLE_API_KEY",
      true,
    ],
  ] as const)(
    "stages %s from the durable route",
    testTimeoutOptions(10_000),
    async (_label, sandboxName, provider, model, endpointUrl, credentialEnv, existing) => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-registration-"));
      vi.stubEnv("HOME", home);
      vi.resetModules();
      try {
        const registry = await import("./registry");
        const { registerCreatedSandbox } = await import("../onboard/sandbox-registration");
        const gatewayName = "nemoclaw";
        const sessionId = `session-${sandboxName}`;
        const reservedSelection = {
          provider,
          model,
          endpointUrl,
          endpointSource: null,
          credentialEnv,
          preferredInferenceApi: "openai-completions",
          compatibleEndpointReasoning: null,
          compatibleEndpointReasoningEffort: null,
          nimContainer: null,
        } satisfies InferenceSelection;
        existing
          ? registry.registerSandbox({
              name: sandboxName,
              ...reservedSelection,
              agent: "openclaw",
              openshellDriver: "docker",
              gatewayName,
            })
          : undefined;
        registry.reserveSandboxInferenceRoute(sandboxName, {
          ...reservedSelection,
          gatewayName,
          ...reservationOwner(sessionId),
        });
        const reconstructedSelection = {
          ...reservedSelection,
          endpointSource: "onboard" as const,
        };
        const routeKeys = [
          "provider",
          "model",
          "endpointUrl",
          "endpointSource",
          "credentialEnv",
          "preferredInferenceApi",
        ] as const;
        expect(
          routeKeys.filter((key) => reconstructedSelection[key] !== reservedSelection[key]),
        ).toEqual(["endpointSource"]);
        const registered = registerCreatedSandbox({
          ...createdSandboxRegistrationInput(sandboxName, gatewayName, reconstructedSelection),
          reservationSessionId: sessionId,
        });
        expect(registered).toMatchObject({
          ...reservedSelection,
          pendingRouteReservation: true,
          reservationSessionId: sessionId,
        });
        expect(registry.getDefault()).toBeNull();
      } finally {
        await fs.rm(home, { recursive: true, force: true });
      }
    },
  );
  it("rejects creation registration from a foreign reservation session and preserves the pending row (#10214)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      const { registerCreatedSandbox } = await import("../onboard/sandbox-registration");
      registry.reserveSandboxInferenceRoute("alpha", {
        ...EXACT_ROUTE_SELECTION,
        gatewayName: "nemoclaw",
        ...reservationOwner("session-owner"),
      });
      const reserved = registry.getSandbox("alpha");
      expect(reserved).toMatchObject({
        pendingRouteReservation: true,
        reservationSessionId: "session-owner",
      });

      expect(() =>
        registerCreatedSandbox({
          ...createdSandboxRegistrationInput("alpha", "nemoclaw", EXACT_ROUTE_SELECTION),
          reservationSessionId: "session-foreign",
        }),
      ).toThrow("Cannot stage a sandbox after its inference route reservation changed");
      expect(registry.getSandbox("alpha")).toEqual(reserved);
      expect(registry.getDefault()).toBeNull();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("retargets an existing row to the gateway protected by the reservation", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.registerSandbox({
        name: "alpha",
        provider: "nvidia-prod",
        model: "model-a",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
      });

      registry.reserveSandboxInferenceRoute("alpha", {
        provider: "anthropic-prod",
        model: "model-b",
        endpointUrl: null,
        credentialEnv: "ANTHROPIC_API_KEY",
        preferredInferenceApi: "anthropic-messages",
        gatewayName: "nemoclaw-9090",
      });

      const retargeted = registry.getSandbox("alpha");
      expect(retargeted).not.toBeNull();
      const retargetedEntry = retargeted as NonNullable<typeof retargeted>;
      expect(retargetedEntry).toMatchObject({
        gatewayName: "nemoclaw-9090",
        provider: "anthropic-prod",
        model: "model-b",
        pendingRouteReservation: true,
      });
      expect(retargetedEntry.createdAt).toEqual(expect.any(String));
      expect(retargetedEntry.gatewayPort).toBeUndefined();
      expect(registry.isRouteOnlySandboxReservation(retargetedEntry)).toBe(false);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("preserves the existing port when reserving a route on the same gateway", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.registerSandbox({
        name: "alpha",
        provider: "nvidia-prod",
        model: "model-a",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
      });

      registry.reserveSandboxInferenceRoute("alpha", {
        provider: "compatible-endpoint",
        model: "model-b",
        endpointUrl: "https://api.example.test/v1",
        credentialEnv: "CUSTOM_API_KEY",
        preferredInferenceApi: "openai-responses",
        gatewayName: "nemoclaw",
        ...reservationOwner("session-owner"),
      });

      expect(registry.getSandbox("alpha")).toMatchObject({
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        pendingRouteReservation: true,
        reservationSessionId: "session-owner",
      });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("preserves an omitted host-local receipt through creation registration", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      const { registerCreatedSandbox } = await import("../onboard/sandbox-registration");
      const receipt = serializedHostLocalInferenceReceipt("docker");
      const route = {
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: "https://api.example.test/v1",
        credentialEnv: "CUSTOM_API_KEY",
        preferredInferenceApi: "openai-responses",
        gatewayName: "nemoclaw-9090",
        ...reservationOwner("session-owner"),
      } as const;

      registry.reserveSandboxInferenceRoute("alpha", {
        ...route,
        hostLocalInferenceReceipt: receipt,
      });
      registry.reserveSandboxInferenceRoute("alpha", route);

      expect(registry.getSandbox("alpha")?.hostLocalInferenceReceipt).toBe(receipt);
      expect(
        registry.finalizeSandboxRouteReservation(
          "alpha",
          "session-owner",
          CANDIDATE_PACKAGE_AUTHORITY,
        ),
      ).toBe(true);
      const entry = registerCreatedSandbox({
        sandboxName: "alpha",
        inferenceSelection: {
          provider: route.provider,
          model: route.model,
          endpointUrl: route.endpointUrl,
          endpointSource: null,
          credentialEnv: route.credentialEnv,
          preferredInferenceApi: route.preferredInferenceApi,
          compatibleEndpointReasoning: null,
          compatibleEndpointReasoningEffort: null,
          nimContainer: null,
        },
        runtimeFields: {
          gpuEnabled: false,
          hostGpuDetected: false,
          sandboxGpuEnabled: false,
          sandboxGpuMode: "auto",
          sandboxGpuDevice: null,
          openshellDriver: "docker",
          openshellVersion: "0.1.2",
        },
        agent: null,
        agentVersionKnown: true,
        imageTag: null,
        workload: {
          schemaVersion: 1,
          kind: "legacy-dockerfile",
          reference: null,
          shared: false,
        },
        plannedMessagingState: undefined,
        hermesToolGateways: [],
        hermesDashboardState: { enabled: false, config: null },
        dashboardPort: 18789,
        gatewayName: route.gatewayName,
        gatewayPort: 9090,
      });

      expect(entry.hostLocalInferenceReceipt).toBe(receipt);
      expect(registry.getSandbox("alpha")?.hostLocalInferenceReceipt).toBe(receipt);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("removes a persisted host-local receipt when reserving a remote route", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      const receipt = serializedHostLocalInferenceReceipt("docker");
      registry.registerSandbox({
        name: "alpha",
        provider: "ollama-local",
        model: "local-model",
        hostLocalInferenceReceipt: receipt,
      });

      registry.reserveSandboxInferenceRoute("alpha", {
        provider: "compatible-endpoint",
        model: "remote-model",
        endpointUrl: "https://api.example.test/v1",
        credentialEnv: "REMOTE_API_KEY",
        preferredInferenceApi: "openai-responses",
        gatewayName: "nemoclaw",
        hostLocalInferenceReceipt: null,
      });

      expect(registry.getSandbox("alpha")).toMatchObject({
        provider: "compatible-endpoint",
        model: "remote-model",
        hostLocalInferenceReceipt: null,
      });
      vi.resetModules();
      const reloadedRegistry = await import("./registry");
      expect(reloadedRegistry.getSandbox("alpha")?.hostLocalInferenceReceipt).toBeNull();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("stamps the owning onboard session on the reservation (#6562)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
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

      expect(registry.getSandbox("alpha")).toMatchObject({
        pendingRouteReservation: true,
        reservationSessionId: "session-owner",
      });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("publishes a reused registered sandbox only for the owning onboarding session", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.registerSandbox({
        name: "alpha",
        provider: "compatible-endpoint",
        model: "model-a",
        openshellDriver: "docker",
        gatewayName: "nemoclaw",
      });
      registry.reserveSandboxInferenceRoute("alpha", {
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: "https://api.example.test/v1",
        credentialEnv: "CUSTOM_API_KEY",
        preferredInferenceApi: "openai-responses",
        gatewayName: "nemoclaw",
        ...reservationOwner("session-owner"),
      });

      expect(
        registry.finalizeSandboxRouteReservation(
          "alpha",
          "session-other",
          CANDIDATE_PACKAGE_AUTHORITY,
        ),
      ).toBe(false);
      expect(registry.getSandbox("alpha")).toMatchObject({
        pendingRouteReservation: true,
        reservationSessionId: "session-owner",
      });
      expect(registry.getDefault()).toBeNull();

      expect(
        registry.finalizeSandboxRouteReservation(
          "alpha",
          "session-owner",
          CANDIDATE_PACKAGE_AUTHORITY,
        ),
      ).toBe(true);
      expect(registry.getSandbox("alpha")).toEqual(
        expect.not.objectContaining({
          pendingRouteReservation: expect.anything(),
        }),
      );
      expect(registry.getSandbox("alpha")?.reservationSessionId).toBe("session-owner");
      expect(registry.getDefault()).toBe("alpha");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("keeps a created registration hidden until its owning sandbox step commits", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
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
        gatewayName: "nemoclaw",
        ...reservationOwner("session-owner"),
      });
      registry.registerSandbox(
        {
          name: "alpha",
          provider: "compatible-endpoint",
          model: "model-a",
          endpointUrl: "https://api.example.test/v1",
          credentialEnv: "CUSTOM_API_KEY",
          preferredInferenceApi: "openai-responses",
          compatibleEndpointReasoning: "true",
          compatibleEndpointReasoningEffort: "high",
          nimContainer: "managed-image",
          openshellDriver: "docker",
          gatewayName: "nemoclaw",
        },
        undefined,
        { pending: true, reservationSessionId: "session-owner" },
      );

      expect(registry.getSandbox("alpha")).toMatchObject({
        pendingRouteReservation: true,
        reservationSessionId: "session-owner",
      });
      expect(registry.getDefault()).toBeNull();

      expect(
        registry.finalizeSandboxRouteReservation(
          "alpha",
          "session-owner",
          CANDIDATE_PACKAGE_AUTHORITY,
        ),
      ).toBe(true);
      expect(registry.isPublishedSandboxRegistration(registry.getSandbox("alpha")!)).toBe(true);
      expect(registry.getDefault()).toBe("alpha");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("restores the recreated default when its owner publishes the registration", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.registerSandbox({
        name: "alpha",
        provider: "compatible-endpoint",
        model: "model-a",
        openshellDriver: "docker",
        gatewayName: "nemoclaw",
      });
      registry.registerSandbox({
        name: "beta",
        provider: "compatible-endpoint",
        model: "model-b",
        openshellDriver: "docker",
        gatewayName: "nemoclaw",
      });
      expect(registry.getDefault()).toBe("alpha");

      registry.reserveSandboxInferenceRoute("alpha", {
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: null,
        credentialEnv: null,
        preferredInferenceApi: null,
        gatewayName: "nemoclaw",
        ...reservationOwner("session-owner"),
      });
      registry.registerSandbox(
        {
          name: "alpha",
          provider: "compatible-endpoint",
          model: "model-a",
          endpointUrl: null,
          credentialEnv: null,
          preferredInferenceApi: null,
          openshellDriver: "docker",
          gatewayName: "nemoclaw",
        },
        undefined,
        { pending: true, reservationSessionId: "session-owner" },
      );

      expect(registry.setDefault("alpha")).toBe(false);
      expect(registry.getDefault()).toBe("beta");
      expect(
        registry.finalizeSandboxRouteReservation(
          "alpha",
          "session-owner",
          CANDIDATE_PACKAGE_AUTHORITY,
        ),
      ).toBe(true);
      expect(registry.getDefault()).toBe("alpha");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it.each([
    ["omits reservation authority", undefined],
    ["supplies an empty reservation owner", { pending: true as const, reservationSessionId: "" }],
    [
      "tries to publish through registration",
      { pending: false as const, reservationSessionId: "session-owner" },
    ],
  ])("rejects registration that %s for a session-owned row (#10214)", async (_case, options) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
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
        gatewayName: "nemoclaw",
        ...reservationOwner("session-owner"),
      });
      const entry = {
        name: "alpha",
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: "https://api.example.test/v1",
        credentialEnv: "CUSTOM_API_KEY",
        preferredInferenceApi: "openai-responses",
        openshellDriver: "docker",
        gatewayName: "nemoclaw",
      } as const;

      expect(() => registry.registerSandbox(entry, undefined, options)).toThrow(
        "Cannot stage a sandbox after its inference route reservation changed",
      );
      expect(registry.getSandbox("alpha")).toMatchObject({
        pendingRouteReservation: true,
        reservationSessionId: "session-owner",
      });
      expect(registry.getDefault()).toBeNull();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("refuses generic pending-registration publication for a session-owned row", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.reserveSandboxInferenceRoute("alpha", {
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: null,
        credentialEnv: null,
        preferredInferenceApi: null,
        gatewayName: "nemoclaw",
        ...reservationOwner("session-owner"),
      });
      registry.registerSandbox(
        {
          name: "alpha",
          provider: "compatible-endpoint",
          model: "model-a",
          endpointUrl: null,
          credentialEnv: null,
          preferredInferenceApi: null,
          openshellDriver: "docker",
          gatewayName: "nemoclaw",
        },
        undefined,
        { pending: true, reservationSessionId: "session-owner" },
      );

      expect(registry.finalizePendingSandboxRegistration("alpha")).toBe(false);
      expect(registry.getSandbox("alpha")).toMatchObject({
        pendingRouteReservation: true,
        reservationSessionId: "session-owner",
      });
      expect(registry.getDefault()).toBeNull();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("rejects an already-published sandbox without the same transaction receipt", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.registerSandbox({
        name: "alpha",
        provider: "compatible-endpoint",
        model: "model-a",
        openshellDriver: "docker",
        gatewayName: "nemoclaw",
      });

      expect(
        registry.finalizeSandboxRouteReservation(
          "alpha",
          "session-owner",
          CANDIDATE_PACKAGE_AUTHORITY,
        ),
      ).toBe(false);
      expect(registry.isPublishedSandboxRegistration(registry.getSandbox("alpha")!)).toBe(true);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("rejects a stale session after another session publishes the same sandbox", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.registerSandbox({
        name: "alpha",
        provider: "compatible-endpoint",
        model: "model-a",
        openshellDriver: "docker",
        gatewayName: "nemoclaw",
      });
      registry.reserveSandboxInferenceRoute("alpha", {
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: "https://api.example.test/v1",
        credentialEnv: "CUSTOM_API_KEY",
        preferredInferenceApi: "openai-responses",
        gatewayName: "nemoclaw",
        ...reservationOwner("session-old"),
      });
      expect(
        registry.finalizeSandboxRouteReservation(
          "alpha",
          "session-old",
          CANDIDATE_PACKAGE_AUTHORITY,
        ),
      ).toBe(true);
      registry.reserveSandboxInferenceRoute("alpha", {
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: "https://api.example.test/v1",
        credentialEnv: "CUSTOM_API_KEY",
        preferredInferenceApi: "openai-responses",
        gatewayName: "nemoclaw",
        ...reservationOwner("session-new"),
      });

      expect(
        registry.finalizeSandboxRouteReservation(
          "alpha",
          "session-new",
          CANDIDATE_PACKAGE_AUTHORITY,
        ),
      ).toBe(true);
      expect(
        registry.finalizeSandboxRouteReservation(
          "alpha",
          "session-new",
          CANDIDATE_PACKAGE_AUTHORITY,
        ),
      ).toBe(true);
      expect(
        registry.finalizeSandboxRouteReservation(
          "alpha",
          "session-old",
          CANDIDATE_PACKAGE_AUTHORITY,
        ),
      ).toBe(false);
      expect(registry.getSandbox("alpha")).toMatchObject({
        reservationSessionId: "session-new",
      });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("does not transfer a published transaction receipt to an ownerless reservation", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.registerSandbox({
        name: "alpha",
        provider: "compatible-endpoint",
        model: "model-a",
        openshellDriver: "docker",
        gatewayName: "nemoclaw",
      });
      registry.reserveSandboxInferenceRoute("alpha", {
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: null,
        credentialEnv: null,
        preferredInferenceApi: null,
        gatewayName: "nemoclaw",
        ...reservationOwner("session-owner"),
      });
      expect(
        registry.finalizeSandboxRouteReservation(
          "alpha",
          "session-owner",
          CANDIDATE_PACKAGE_AUTHORITY,
        ),
      ).toBe(true);

      registry.reserveSandboxInferenceRoute("alpha", {
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: null,
        credentialEnv: null,
        preferredInferenceApi: null,
        gatewayName: "nemoclaw",
      });

      expect(registry.getSandbox("alpha")).toMatchObject({
        pendingRouteReservation: true,
      });
      expect(registry.getSandbox("alpha")?.reservationSessionId).toBeUndefined();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("atomically consumes only the exact qualified route reservation (#9203)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      const { route, create } = reserveQualifiedCreate(registry);
      const checkpoint = managedCheckpoint();
      registry.recordPendingSandboxCreateIdentity(create, checkpoint);
      const registered = registry.registerSandbox(completedEntry(checkpoint), route, {
        verifiedCreate: { reservation: create, checkpoint },
        finalPackageAuthority: create.authority,
      });

      expect(registered).toMatchObject({
        name: "alpha",
        provider: "ollama-local",
        model: "qwen3-vl:4b",
        agent: "hermes",
      });
      expect(registered.pendingRouteReservation).toBeUndefined();
      expect(registered.pendingCreateIdentity).toBeUndefined();
      expect(registry.getSandbox("alpha")).toEqual(registered);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("keeps a verified create checkpoint non-authorizing and hidden until final publication (#9833)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-policy-checkpoint-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      const { create } = reserveQualifiedCreate(registry);
      const checkpoint = managedCheckpoint();

      const pending = registry.recordPendingSandboxCreateIdentity(create, checkpoint);

      expect(pending).toMatchObject({
        pendingRouteReservation: true,
        reservationSessionId: "session-owner",
        pendingCreateIdentity: checkpoint,
        lifecycleGeneration: LIFECYCLE_GENERATION,
        lifecycleLiveIdentityFingerprint: LIVE_IDENTITY_FINGERPRINT,
      });
      expect(pending).not.toHaveProperty("policyAuthority");
      expect(pending).not.toHaveProperty("policyCreationReceipt");
      expect(registry.getDefault()).toBeNull();
      expect(() => registry.updateSandbox("alpha", { agent: "hermes" })).toThrow(
        /verified create checkpoint is incomplete/u,
      );
      expect(
        registry.finalizeSandboxRouteReservation("alpha", "session-owner", EXACT_ROUTE_AUTHORITY),
      ).toBe(false);
      expect(registry.finalizePendingSandboxRegistration("alpha")).toBe(false);
      expect(registry.recordPendingSandboxCreateIdentity(create, checkpoint)).toEqual(pending);
      expect(
        registry.reserveSandboxInferenceRoute("alpha", {
          ...EXACT_ROUTE_SELECTION,
          gatewayName: "nemoclaw",
          reservationSessionId: "session-owner",
          harnessPackage: HARNESS_PACKAGE,
          harnessPackageMigration: HARNESS_PACKAGE_MIGRATION,
        }),
      ).toBe(true);
      expect(() =>
        registry.reserveSandboxInferenceRoute("alpha", {
          ...EXACT_ROUTE_SELECTION,
          gatewayName: "nemoclaw",
          openshellDriver: "kubernetes",
          reservationSessionId: "session-owner",
          harnessPackage: HARNESS_PACKAGE,
          harnessPackageMigration: HARNESS_PACKAGE_MIGRATION,
        }),
      ).toThrow(/verified create checkpoint is incomplete/u);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("rotates a checkpoint only from the exact old evidence and supports an exact retry (#9833)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-policy-checkpoint-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      const { route, create } = reserveQualifiedCreate(registry);
      const initial = managedCheckpoint({ route: "native" });
      const replacement = managedCheckpoint({
        route: "compatibility",
        sandboxIdentityFingerprint: "b".repeat(64),
      });
      const initialEntry = registry.recordPendingSandboxCreateIdentity(create, initial);
      const admittedCheckpoint = ownedReservation(
        registry.classifySandboxInferenceRouteReservation(EXACT_ROUTE_AUTHORITY, initialEntry),
      );

      const rotated = registry.recordPendingSandboxCreateIdentity(create, replacement, {
        expected: initial,
      });
      expect(rotated.pendingCreateIdentity).toEqual(replacement);
      expect(registry.isCurrentSandboxInferenceRouteReservation(route, rotated)).toBe(true);
      expect(registry.isCurrentSandboxInferenceRouteReservation(admittedCheckpoint, rotated)).toBe(
        false,
      );
      expect(() => registry.requireCurrentPendingSandboxCreateIdentity(create, initial)).toThrow(
        /verified checkpoint changed/u,
      );
      expect(
        registry.recordPendingSandboxCreateIdentity(create, replacement, {
          expected: initial,
        }),
      ).toEqual(rotated);
      expect(() =>
        registry.recordPendingSandboxCreateIdentity(create, initial, {
          expected: initial,
        }),
      ).toThrow(/without exact authority/u);
      expect(() =>
        registry.recordPendingSandboxCreateIdentity(
          {
            ...create,
            authority: { ...create.authority, sessionId: "another-session" },
          },
          replacement,
        ),
      ).toThrow(/incomplete verified sandbox create checkpoint/u);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("requires the exact durable checkpoint at final registration (#9833)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-policy-checkpoint-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      const { route, create } = reserveQualifiedCreate(registry);
      const checkpoint = managedCheckpoint();

      expect(() => registry.registerSandbox(completedEntry(checkpoint), route)).toThrow(
        /pending create identity/u,
      );
      registry.recordPendingSandboxCreateIdentity(create, checkpoint);
      registry.removeSandbox("alpha");
      expect(() =>
        registry.registerSandbox(completedEntry(checkpoint), route, {
          verifiedCreate: { reservation: create, checkpoint },
          finalPackageAuthority: create.authority,
        }),
      ).toThrow(/verified create checkpoint changed|final harness package authority changed/u);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("rejects a second route reservation authority at final registration (#9833)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-policy-checkpoint-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      const { route, create } = reserveQualifiedCreate(registry);
      const checkpoint = managedCheckpoint();
      registry.recordPendingSandboxCreateIdentity(create, checkpoint);

      expect(() =>
        registry.registerSandbox(
          completedEntry(checkpoint),
          {
            ...route,
            authority: { ...route.authority, sessionId: "different-session" },
          },
          { verifiedCreate: { reservation: create, checkpoint } },
        ),
      ).toThrow(/different route reservation authority/u);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("rejects stale external identity and partial lifecycle evidence at final registration (#9833)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-policy-checkpoint-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      const { route, create } = reserveQualifiedCreate(registry);
      const checkpoint = externalCheckpoint();
      const finalPackageAuthority = create.authority;
      registry.recordPendingSandboxCreateIdentity(create, checkpoint);
      expect(() =>
        registry.registerSandbox(completedEntry(checkpoint), route, {
          verifiedCreate: {
            reservation: create,
            checkpoint: externalCheckpoint({ route: "native" }),
          },
          finalPackageAuthority,
        }),
      ).toThrow(/verified create checkpoint changed/u);
      expect(() =>
        registry.registerSandbox(
          {
            ...completedEntry(checkpoint),
            lifecycleGeneration: "223e4567-e89b-42d3-a456-426614174983",
          },
          route,
          { verifiedCreate: { reservation: create, checkpoint }, finalPackageAuthority },
        ),
      ).toThrow(/requested lifecycle generation/u);
      expect(() =>
        registry.registerSandbox(
          {
            ...completedEntry(checkpoint),
            lifecycleLiveIdentityFingerprint: "c".repeat(64),
          },
          route,
          { verifiedCreate: { reservation: create, checkpoint }, finalPackageAuthority },
        ),
      ).toThrow(/requested lifecycle identity/u);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("keeps an incomplete registration hidden until its caller commits it (#9733)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-pending-registration-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");

      const pending = registry.registerSandbox(
        {
          name: "clone",
          provider: "openai",
          model: "test-model",
          openshellDriver: "docker",
          gatewayName: "nemoclaw",
        },
        undefined,
        { pending: true },
      );

      expect(pending.pendingRouteReservation).toBe(true);
      expect(registry.isPublishedSandboxRegistration(pending)).toBe(false);
      expect(registry.getDefault()).toBeNull();
      const persistedPending = registry.getSandbox("clone")!;

      expect(
        registry.finalizePendingSandboxRegistrationIfCurrent({
          ...persistedPending,
          model: "changed-model",
        }),
      ).toBe(false);
      expect(registry.finalizePendingSandboxRegistrationIfCurrent(persistedPending)).toBe(true);
      expect(registry.isPublishedSandboxRegistration(registry.getSandbox("clone")!)).toBe(true);
      expect(registry.getDefault()).toBe("clone");

      registry.registerSandbox({
        name: "later",
        provider: "openai",
        model: "test-model",
        openshellDriver: "docker",
        gatewayName: "nemoclaw",
      });
      expect(registry.getDefault()).toBe("clone");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("publishes a pending clone only over its exact captured registry row", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-pending-clone-cas-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      const packageIdentity = {
        ...HARNESS_PACKAGE,
        id: "openclaw",
      };
      const foreignSamePackage = registry.registerSandbox({
        name: "clone",
        agent: "openclaw",
        harnessPackage: packageIdentity,
        provider: "openai",
        model: "foreign-model",
        openshellDriver: "docker",
        gatewayName: "nemoclaw",
        lifecycleGeneration: "foreign-generation",
        lifecycleLiveIdentityFingerprint: "f".repeat(64),
      });

      expect(() =>
        registry.registerSandbox(
          {
            ...foreignSamePackage,
            model: "clone-model",
            lifecycleGeneration: "clone-generation",
            lifecycleLiveIdentityFingerprint: "a".repeat(64),
          },
          undefined,
          { pending: true, expectedCurrent: null },
        ),
      ).toThrow(/expected registry row changed/u);
      expect(registry.getSandbox("clone")).toEqual(foreignSamePackage);

      expect(registry.removeSandboxIfCurrent(foreignSamePackage)).toBe(true);
      registry.reserveSandboxInferenceRoute("clone", {
        provider: "openai",
        model: "clone-model",
        endpointUrl: null,
        endpointSource: null,
        credentialEnv: null,
        preferredInferenceApi: null,
        gatewayName: "nemoclaw",
      });
      const capturedRoute = registry.getSandbox("clone")!;
      expect(capturedRoute.pendingRouteReservation).toBe(true);

      const published = registry.registerSandbox(
        {
          name: "clone",
          agent: "openclaw",
          provider: "openai",
          model: "clone-model",
          openshellDriver: "docker",
          gatewayName: "nemoclaw",
          lifecycleGeneration: "clone-generation",
          lifecycleLiveIdentityFingerprint: "a".repeat(64),
        },
        undefined,
        { pending: true, expectedCurrent: capturedRoute },
      );
      expect(registry.getSandbox("clone")).toEqual(published);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("rejects route reservation replacement inside the registry lock (#9203)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      const { create } = reserveQualifiedCreate(registry);
      expect(() =>
        registry.reserveSandboxInferenceRoute("alpha", {
          ...EXACT_ROUTE_SELECTION,
          model: "another-model",
          gatewayName: "nemoclaw",
          reservationSessionId: "another-session",
          harnessPackage: HARNESS_PACKAGE,
          harnessPackageMigration: HARNESS_PACKAGE_MIGRATION,
        }),
      ).toThrow(/belongs to another onboarding session/u);
      registry.recordPendingSandboxCreateIdentity(create, managedCheckpoint());
      expect(registry.getSandbox("alpha")).toMatchObject({
        pendingRouteReservation: true,
        reservationSessionId: EXACT_ROUTE_AUTHORITY.sessionId,
        model: EXACT_ROUTE_SELECTION.model,
        pendingCreateIdentity: managedCheckpoint(),
      });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
