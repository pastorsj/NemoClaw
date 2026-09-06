// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxEntry } from "../../state/registry";
import { InferenceSetError } from "../inference-set-error";
import {
  RuntimeProviderSelectionError,
  requireInferenceSetRuntimeAuthority,
  type RuntimeProviderBundleRegistry,
} from "../inference-set-provider";
import type { InferenceSetDeps } from "./types";

const SUPPORTED_PROVIDER_NAMES = [
  "nvidia-prod",
  "nvidia-nim",
  "nvidia-router",
  "openai-api",
  "openrouter-api",
  "anthropic-prod",
  "compatible-anthropic-endpoint",
  "gemini-api",
  "compatible-endpoint",
  "hermes-provider",
  "ollama-local",
  "vllm-local",
] as const;

// #6321: `nemoclaw onboard` accepts installer-style provider keys
// (`anthropicCompatible`, `build`, `openai`, …) while `inference set` only
// accepted the OpenShell provider names (`compatible-anthropic-endpoint`,
// `nvidia-prod`, `openai-api`, …). A user who onboarded with
// `NEMOCLAW_PROVIDER=anthropicCompatible` could not switch the same sandbox
// with `inference set --provider anthropicCompatible` — the two commands used
// different vocabularies for the same provider. Normalize the installer alias
// to its OpenShell provider name before validation so both commands accept the
// same names. Keys are lowercased; values must each be a SUPPORTED_PROVIDER_NAMES
// entry (asserted by the sync test in inference-set-provider-alias.test.ts).
// This mirrors REMOTE_PROVIDER_CONFIG[key].providerName and
// getEffectiveProviderName() in src/lib/onboard/providers.ts; kept as a small
// local map rather than importing that @ts-nocheck onboard module into this
// hot action path.
const INSTALLER_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  anthropiccompatible: "compatible-anthropic-endpoint",
  build: "nvidia-prod",
  cloud: "nvidia-prod",
  openai: "openai-api",
  "open-router": "openrouter-api",
  openrouter: "openrouter-api",
  openrouterai: "openrouter-api",
  anthropic: "anthropic-prod",
  gemini: "gemini-api",
  // Hermes Provider (Nous portal) is reachable under several onboard synonyms;
  // accept the same set here so a sandbox onboarded with any of them can be
  // switched under the same name. (`hermes-provider` is already an OpenShell
  // provider name and passes through without an entry, but is listed for
  // parity clarity.)
  hermesprovider: "hermes-provider",
  hermes: "hermes-provider",
  nous: "hermes-provider",
  "nous-portal": "hermes-provider",
  custom: "compatible-endpoint",
  ollama: "ollama-local",
  vllm: "vllm-local",
  nim: "nvidia-nim",
  "nim-local": "nvidia-nim",
  routed: "nvidia-router",
};

/**
 * Map an installer-style provider key (the vocabulary `nemoclaw onboard`
 * accepts) to its OpenShell provider name (the vocabulary `inference set`
 * validates against). Inputs that are already OpenShell provider names — or
 * any unrecognized value — pass through unchanged so validation still rejects
 * genuinely unsupported providers. See #6321.
 */
export function normalizeInferenceSetProvider(provider: string): string {
  const trimmed = provider.trim();
  return INSTALLER_PROVIDER_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

/** Exposed for the alias-sync regression test. */
export const INFERENCE_SET_SUPPORTED_PROVIDER_NAMES = SUPPORTED_PROVIDER_NAMES;
export const INFERENCE_SET_INSTALLER_PROVIDER_ALIASES = INSTALLER_PROVIDER_ALIASES;

export function trimRequired(value: string | null | undefined, label: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) throw new InferenceSetError(`${label} is required.`);
  return trimmed;
}

export function assertSupportedProvider(provider: string, _model: string): void {
  if (SUPPORTED_PROVIDER_NAMES.includes(provider as (typeof SUPPORTED_PROVIDER_NAMES)[number]))
    return;
  throw new InferenceSetError(
    `Unsupported provider '${provider}'. Supported providers: ${SUPPORTED_PROVIDER_NAMES.join(", ")}.`,
    2,
  );
}

export function assertInferenceSetRuntimeAuthority(
  entry: SandboxEntry,
  providers: RuntimeProviderBundleRegistry | undefined,
): ReturnType<typeof requireInferenceSetRuntimeAuthority> {
  try {
    return requireInferenceSetRuntimeAuthority(entry, providers);
  } catch (error) {
    if (!(error instanceof RuntimeProviderSelectionError)) throw error;
    throw new InferenceSetError(error.message, 2);
  }
}

export function normalizeSandboxAgent(agentName: string | null | undefined): string {
  const trimmed = typeof agentName === "string" ? agentName.trim() : "";
  return (trimmed || "openclaw").toLowerCase();
}

function formatRequestedAgentName(agentName: string): string {
  return agentName
    .split("-")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function assertSandboxRouteReservationComplete(entry: SandboxEntry): void {
  if (entry.pendingRouteReservation === true) {
    throw new InferenceSetError(
      `Sandbox '${entry.name}' is still being created by onboarding. Wait for onboarding to finish or remove the incomplete sandbox before changing inference.`,
      2,
    );
  }
}

export function resolveTargetSandbox(
  sandboxName: string | null | undefined,
  deps: Pick<
    InferenceSetDeps,
    "getDefaultSandbox" | "getSandbox" | "listSandboxes" | "getRequestedAgent"
  >,
): { sandboxName: string; entry: SandboxEntry; agentName: string } {
  const explicitName = sandboxName?.trim();
  if (explicitName) {
    const entry = deps.getSandbox(explicitName);
    if (!entry) {
      throw new InferenceSetError(`Sandbox '${explicitName}' is not registered.`, 2);
    }
    assertSandboxRouteReservationComplete(entry);
    return {
      sandboxName: explicitName,
      entry,
      agentName: normalizeSandboxAgent(entry.agent),
    };
  }

  const requestedAgent = deps.getRequestedAgent()?.trim().toLowerCase();
  if (requestedAgent) {
    const requestedSandboxes = deps
      .listSandboxes()
      .sandboxes.filter(
        (entry) =>
          entry.pendingRouteReservation !== true &&
          normalizeSandboxAgent(entry.agent) === requestedAgent,
      );
    if (requestedSandboxes.length === 1) {
      const entry = requestedSandboxes[0];
      return { sandboxName: entry.name, entry, agentName: requestedAgent };
    }
    const requestedDisplayName = formatRequestedAgentName(requestedAgent);
    if (requestedSandboxes.length === 0) {
      throw new InferenceSetError(
        `No registered ${requestedDisplayName} sandbox found. Pass --sandbox <name> to target a sandbox explicitly.`,
        2,
      );
    }
    throw new InferenceSetError(
      `Multiple ${requestedDisplayName} sandboxes are registered (${requestedSandboxes
        .map((entry) => entry.name)
        .join(", ")}). Pass --sandbox <name> to choose one.`,
      2,
    );
  }

  const targetName = deps.getDefaultSandbox();
  if (!targetName) {
    throw new InferenceSetError(
      "No sandbox selected. Pass --sandbox <name> or create a sandbox with nemoclaw onboard.",
      2,
    );
  }

  const entry = deps.getSandbox(targetName);
  if (!entry) {
    throw new InferenceSetError(`Sandbox '${targetName}' is not registered.`, 2);
  }
  assertSandboxRouteReservationComplete(entry);
  return {
    sandboxName: targetName,
    entry,
    agentName: normalizeSandboxAgent(entry.agent),
  };
}
