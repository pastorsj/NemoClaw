// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessStartupInferenceCandidate,
  HarnessStartupEnvironmentInputDeclaration,
  HarnessStartupJsonObject,
  HarnessStartupProfileInput,
} from "@nvidia/nemoclaw-harness-contract";

import { hasCredentialBearingHostProxyEnvironment } from "../host-proxy-env";
import type { ResolvedCorporateCa } from "../corporate-ca-types";
import {
  resolveManagedStartupCorporateCaMaterial,
  resolveManagedStartupProxy,
} from "./profile-builder";

export interface ManagedStartupPackagePreparationSource {
  readonly inference: {
    readonly selectedProvider: string | null;
    readonly model: string;
    readonly endpointUrl: string | null;
    readonly resolvedContextWindow: number | null;
    readonly reasoningEnabled: boolean | null;
    readonly reasoningEffort: "low" | "medium" | "high" | null;
    readonly candidates: readonly HarnessStartupInferenceCandidate[];
  };
  readonly dashboard: {
    readonly managed: boolean;
    readonly url: string;
    readonly port: number;
    readonly bindAddress: string | undefined;
    readonly wslExposure: boolean;
    readonly forwarding: {
      readonly enabled: boolean;
      readonly publicPort: number | null;
      readonly internalPort: number | null;
      readonly tuiEnabled: boolean;
    };
  };
  readonly webSearch: {
    readonly fetchEnabled: boolean;
    readonly provider?: "brave" | "tavily";
  } | null;
  readonly toolDisclosure: "progressive" | "direct";
  readonly enabledToolGateways: readonly string[];
  readonly messagingPlan: unknown | null;
  readonly approvalMode: "disabled" | "thread-opt-in";
  readonly observabilityEnabled: boolean;
  readonly environment: NodeJS.ProcessEnv;
  readonly corporateCa: ResolvedCorporateCa | null;
}

export interface BuiltManagedStartupPackagePreparationInput {
  readonly input: HarnessStartupProfileInput;
  readonly corporateCaB64?: string;
}

type StartupInferenceApi = HarnessStartupInferenceCandidate["requestedApi"];
type SandboxInferenceCandidate = {
  readonly providerKey: string;
  readonly primaryModelRef: string;
  readonly inferenceBaseUrl: string;
  readonly inferenceApi: string;
  readonly inferenceCompat: Record<string, unknown> | null;
};

function requireStartupInferenceApi(value: string): Exclude<StartupInferenceApi, null> {
  if (
    value === "openai-completions" ||
    value === "openai-responses" ||
    value === "anthropic-messages"
  ) {
    return value;
  }
  throw new Error(`Unsupported managed startup inference API '${value}'.`);
}

/** Resolve every finite API candidate once; the package chooses without reconstructing routes. */
export function buildManagedStartupInferenceCandidates(
  model: string,
  provider: string | null,
  preferredApi: string | null,
  resolve: (
    model: string,
    provider: string | null,
    preferredApi: string | null,
  ) => SandboxInferenceCandidate,
): readonly HarnessStartupInferenceCandidate[] {
  const preferred = preferredApi === null ? null : requireStartupInferenceApi(preferredApi.trim());
  const requests = [
    preferred,
    null,
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
  ] as const;
  const unique = requests.filter(
    (value, index): value is StartupInferenceApi => requests.indexOf(value) === index,
  );
  return unique.map((requestedApi) => {
    const candidate = resolve(model, provider, requestedApi);
    return {
      requestedApi,
      routeProvider: candidate.providerKey,
      routedBaseUrl: candidate.inferenceBaseUrl,
      api: requireStartupInferenceApi(candidate.inferenceApi),
      primaryModelRef: candidate.primaryModelRef,
      compatibility: candidate.inferenceCompat as HarnessStartupJsonObject | null,
    };
  });
}

function normalizedMessagingPlan(value: unknown | null): HarnessStartupJsonObject | null {
  if (value === null) return null;
  const clone = JSON.parse(JSON.stringify(value)) as HarnessStartupJsonObject;
  const buildSteps = clone.buildSteps;
  if (Array.isArray(buildSteps)) {
    for (const step of buildSteps) {
      if (step === null || Array.isArray(step) || typeof step !== "object") continue;
      const record = step as Record<string, unknown>;
      const nested = record.value;
      if (
        record.kind === "package-install" &&
        nested !== null &&
        !Array.isArray(nested) &&
        typeof nested === "object"
      ) {
        delete (nested as Record<string, unknown>).pin;
      }
    }
  }
  return clone;
}

/** Build the finite, credential-free request shared by every package startup adapter. */
export function buildManagedStartupPackagePreparationInput(
  source: ManagedStartupPackagePreparationSource,
  startupProfileEnvironment: readonly HarnessStartupEnvironmentInputDeclaration[],
): BuiltManagedStartupPackagePreparationInput {
  const credentialProxyPresent = hasCredentialBearingHostProxyEnvironment(source.environment);
  const environment: Record<string, string> = {};
  for (const declaration of startupProfileEnvironment) {
    const value = source.environment[declaration.name];
    if (typeof value !== "string") continue;
    if (Buffer.byteLength(value, "utf8") > declaration.max_bytes) {
      throw new Error(
        `Managed startup environment input '${declaration.name}' exceeds its package-declared byte boundary.`,
      );
    }
    if (
      declaration.value_type === "positive-integer" &&
      (!/^[1-9][0-9]*$/u.test(value) ||
        !Number.isSafeInteger(Number(value)) ||
        Number(value) > 1_000_000_000)
    ) {
      throw new Error(
        `Managed startup environment input '${declaration.name}' must be a canonical positive integer no greater than 1000000000.`,
      );
    }
    environment[declaration.name] = value;
  }
  const corporateCa = resolveManagedStartupCorporateCaMaterial(source.corporateCa);
  const proxy = resolveManagedStartupProxy(source.environment);
  const input: HarnessStartupProfileInput = {
    inference: source.inference,
    dashboard: {
      ...source.dashboard,
      bindAddress: source.dashboard.bindAddress ?? null,
    },
    webSearch:
      source.webSearch === null
        ? null
        : {
            enabled: source.webSearch.fetchEnabled,
            provider: source.webSearch.provider ?? null,
          },
    tools: {
      disclosure: source.toolDisclosure,
      enabledGateways: [...source.enabledToolGateways],
    },
    messagingPlan: normalizedMessagingPlan(source.messagingPlan),
    approvalMode: source.approvalMode,
    observabilityEnabled: source.observabilityEnabled,
    proxy,
    environment,
    corporateCa: { bundleSha256: corporateCa.bundleSha256 },
    credentialProxyPresent,
  };
  return corporateCa.corporateCaB64 === undefined
    ? { input }
    : { input, corporateCaB64: corporateCa.corporateCaB64 };
}
