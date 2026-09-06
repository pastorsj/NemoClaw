// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Exact-ID custom-image behavior retained only for old rows without receipts. */
export function legacyRebuildRequiresImagePluginProvenance(entry: {
  readonly agent?: string | null;
  readonly fromDockerfile?: string | null;
  readonly harnessPackage?: unknown;
}): boolean {
  return (
    !entry.harnessPackage &&
    Boolean(entry.fromDockerfile) &&
    (!entry.agent || entry.agent === "openclaw")
  );
}

type LegacyToolGatewayState = {
  readonly agent?: string | null;
  readonly hermesToolGateways?: unknown;
};

function legacyStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item: unknown): item is string => typeof item === "string");
}

/** Read the pre-receipt Hermes tool selection without exposing its ID to generic rebuild code. */
export function resolveLegacyRebuildToolGateways(
  entry: LegacyToolGatewayState,
  session: LegacyToolGatewayState | null,
  sessionMatchesSandbox: boolean,
): { gateways: string[]; recorded: boolean } {
  if (entry.agent !== "hermes") return { gateways: [], recorded: false };
  const registryGateways = legacyStringList(entry.hermesToolGateways);
  const sessionGateways = sessionMatchesSandbox
    ? legacyStringList(session?.hermesToolGateways)
    : null;
  return {
    gateways: registryGateways ?? sessionGateways ?? [],
    recorded: registryGateways !== null || sessionGateways !== null,
  };
}

/** Preserve the old Hermes/Tavily tool collision rule for rows without package startup state. */
export function filterLegacyRebuildToolGatewaysForWebSearch(
  entry: LegacyToolGatewayState,
  gateways: readonly string[],
  webSearchProvider: string | null,
): string[] {
  return entry.agent === "hermes" && webSearchProvider === "tavily"
    ? gateways.filter((gateway) => gateway !== "nous-web")
    : [...gateways];
}

/** Preserve the old managed DCode custom-image refusal for rows without receipts. */
export function legacyManagedRebuildRejectsCustomDockerfile(
  entry: { readonly agent?: string | null },
  fromDockerfile: string | null,
): boolean {
  return entry.agent === "langchain-deepagents-code" && fromDockerfile !== null;
}

/** Preserve gateway web-search credential reuse for pre-receipt OpenClaw rows. */
export function legacyRebuildCanReuseGatewayWebSearchCredential(agent: string): boolean {
  return agent === "openclaw";
}

/** Test-only and pre-receipt fallback when no typed state declaration was captured. */
export function legacyRebuildPreservesScheduledWork(agent: string | null): boolean {
  return agent === "hermes";
}

export type LegacyRebuildStateAction =
  | "require-image-plugin-provenance"
  | "preserve-scheduled-work"
  | "reconcile-dashboard-profile"
  | "repair-upgraded-state"
  | "restart-runtime-after-restore"
  | "verify-config-integrity"
  | "restore-device-pairing"
  | "verify-mutable-config"
  | "notify-api-token-change";

/**
 * Interpret the retired action list only for pre-contract state and old test
 * fixtures. Installed package manifests cannot produce this shape because the
 * manifest reader requires the structured rebuild declaration.
 */
export function legacyRebuildRequestsStateAction(
  rebuild: unknown,
  action: LegacyRebuildStateAction,
): boolean {
  return Array.isArray(rebuild) && rebuild.includes(action);
}
