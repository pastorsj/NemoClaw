// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  type InferenceEndpointSource,
  normalizeInferenceSelection,
} from "../../inference/selection";
import { createSession, type SessionUpdates } from "../../state/onboard-session";
import { classifySandboxInferenceRouteReservation } from "../../state/registry/route-reservation";
import type { InferenceRouteReservationAuthority } from "../types";

describe("core route authority", () => {
  let coreFlow: typeof import("../../../../test/helpers/core-flow");
  let home: string;
  let registry: typeof import("../../state/registry");

  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-onboard-route-authority-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    [registry, coreFlow] = await Promise.all([
      import("../../state/registry"),
      import("../../../../test/helpers/core-flow"),
    ]);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(home, { recursive: true, force: true });
  });

  it("keeps a fresh Bedrock route reservation identical through sandbox admission (#9833)", async () => {
    const { context, createPhases } = coreFlow;
    const { getSandbox, removeSandbox, reserveSandboxInferenceRoute } = registry;
    const durableSession = createSession();
    const sandboxName = `hosted-route-${durableSession.sessionId}`;
    const recordStepComplete = vi.fn(async (_stepName: string, updates: SessionUpdates = {}) => {
      Object.assign(durableSession, updates);
      return durableSession;
    });
    const createSandbox = vi.fn(async (...args: unknown[]) => {
      const authority = args[14] as InferenceRouteReservationAuthority | null;
      const createIntent = args[15] as {
        endpointSource?: InferenceEndpointSource | null;
      };
      const reservation = getSandbox(sandboxName);
      expect(authority).toMatchObject({ sessionId: durableSession.sessionId });
      expect(createIntent.endpointSource).toBe("onboard");
      expect(
        classifySandboxInferenceRouteReservation(
          {
            sandboxName,
            gatewayName: "nemoclaw",
            ...authority!,
          },
          reservation,
        ).kind,
      ).toBe("owned");
      return "created-sandbox";
    });
    const { providerInference: providerPhase, sandbox: sandboxPhase } = createPhases({
      providerDeps: {
        setupNim: vi.fn(async () => ({
          model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
          provider: "compatible-anthropic-endpoint",
          endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
          endpointSource: "onboard" as const,
          credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
          hermesAuthMethod: null,
          hermesToolGateways: [],
          preferredInferenceApi: "openai-completions",
          compatibleEndpointReasoning: null,
          compatibleEndpointReasoningEffort: null,
          nimContainer: null,
        })),
        recordStepComplete,
        promptValidatedSandboxName: vi.fn(async () => sandboxName),
        setupInference: vi.fn(
          async (name, model, provider, endpointUrl, credentialEnv, _auth, _gateways, options) => {
            expect(
              reserveSandboxInferenceRoute(name, {
                provider,
                model,
                endpointUrl,
                endpointSource: options?.endpointSource ?? null,
                credentialEnv,
                preferredInferenceApi: options?.preferredInferenceApi ?? null,
                gatewayName: options?.gatewayName ?? "nemoclaw",
                reservationSessionId: options!.reservationSessionId!,
                ...options!.harnessPackageAuthority!,
              }),
            ).toBe(true);
            return { ok: true as const };
          },
        ),
      },
      sandboxDeps: {
        createSandbox,
        getSandboxRegistryEntry: getSandbox,
        promptValidatedSandboxName: vi.fn(async () => sandboxName),
      },
    });

    try {
      const providerResult = await providerPhase.run(
        context({
          fresh: true,
          session: durableSession,
          sandboxName,
        }),
      );
      expect(providerResult.context.endpointSource).toBe("onboard");
      await sandboxPhase.run(providerResult.context);

      expect(createSandbox).toHaveBeenCalledOnce();
    } finally {
      removeSandbox(sandboxName);
    }
  });

  it("preserves the fresh install-ollama reservation endpoint source for Hermes portable creation (#9203)", async () => {
    const { context, createPhases } = coreFlow;
    const {
      getSandbox,
      isPendingReservationForSession,
      removeSandbox,
      reserveSandboxInferenceRoute,
    } = registry;
    const durableSession = createSession();
    const sandboxName = `hermes-route-${durableSession.sessionId}`;
    const recordStepComplete = vi.fn(async (_stepName: string, updates: SessionUpdates = {}) => {
      Object.assign(durableSession, updates);
      return durableSession;
    });
    const createSandbox = vi.fn(async (...args: unknown[]) => {
      const authority = args[14] as InferenceRouteReservationAuthority | null;
      const createIntent = args[15] as {
        endpointSource?: InferenceEndpointSource | null;
      };
      const reservation = getSandbox(sandboxName);
      expect(authority).toMatchObject({ sessionId: durableSession.sessionId });
      expect(createIntent.endpointSource).toBeNull();
      expect(isPendingReservationForSession(reservation, authority!.sessionId)).toBe(true);
      expect(
        classifySandboxInferenceRouteReservation(
          {
            sandboxName,
            gatewayName: "nemoclaw",
            ...authority!,
            selection: normalizeInferenceSelection({
              ...reservation,
              endpointSource: "onboard",
            }),
          },
          reservation,
        ).kind,
      ).toBe("conflict");
      expect(
        classifySandboxInferenceRouteReservation(
          {
            sandboxName,
            gatewayName: "nemoclaw",
            ...authority!,
          },
          reservation,
        ).kind,
      ).toBe("owned");
      return "created-sandbox";
    });
    const { providerInference: providerPhase, sandbox: sandboxPhase } = createPhases({
      providerDeps: {
        setupNim: vi.fn(async () => ({
          model: "qwen3-vl:4b",
          provider: "ollama-local",
          endpointUrl: "http://inference.local/v1",
          credentialEnv: null,
          hermesAuthMethod: null,
          hermesToolGateways: [],
          preferredInferenceApi: "openai-completions",
          compatibleEndpointReasoning: null,
          compatibleEndpointReasoningEffort: null,
          nimContainer: null,
        })),
        recordStepComplete,
        promptValidatedSandboxName: vi.fn(async () => sandboxName),
        setupInference: vi.fn(
          async (name, model, provider, endpointUrl, credentialEnv, _auth, _gateways, options) => {
            expect(options?.reservationSessionId).toBe(durableSession.sessionId);
            expect(
              reserveSandboxInferenceRoute(name, {
                provider,
                model,
                endpointUrl,
                endpointSource: options?.endpointSource ?? null,
                credentialEnv,
                preferredInferenceApi: options?.preferredInferenceApi ?? null,
                gatewayName: options?.gatewayName ?? "nemoclaw",
                reservationSessionId: options!.reservationSessionId!,
                ...options!.harnessPackageAuthority!,
              }),
            ).toBe(true);
            return { ok: true as const };
          },
        ),
      },
      sandboxDeps: {
        createSandbox,
        getSandboxRegistryEntry: getSandbox,
        promptValidatedSandboxName: vi.fn(async () => sandboxName),
      },
      sandboxOptions: { hermesPortableLifecycle: true },
    });

    try {
      const providerResult = await providerPhase.run(
        context({
          fresh: true,
          session: durableSession,
          agent: { name: "hermes" },
          sandboxName,
        }),
      );
      expect(providerResult.context).toMatchObject({
        provider: "ollama-local",
        model: "qwen3-vl:4b",
        endpointSource: null,
        hostLocalInferenceRouteOnly: false,
      });
      await sandboxPhase.run(providerResult.context);

      expect(createSandbox).toHaveBeenCalledOnce();
    } finally {
      removeSandbox(sandboxName);
    }
  });
});
