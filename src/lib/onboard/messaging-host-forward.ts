// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createBuiltInChannelManifestRegistry,
  getActiveMessagingHostForward,
  MessagingHostStateApplier,
  type ChannelManifest,
  type SandboxMessagingPlan,
} from "../messaging";
import { hydrateDerivedSandboxMessagingPlanFields } from "../messaging/hydration";
import type { SandboxMessagingHostForwardPlan } from "../messaging/manifest";
import { parseSandboxMessagingPlan } from "../messaging/plan-validation";
import { listMessagingChannelsForSandboxAuthority } from "../messaging/profile-authority";
import * as registry from "../state/registry";
import { retireProductionLegacySandboxForwards } from "./forward-service-migration";

type GatewayBinding =
  | {
      gatewayName?: string | null;
      gatewayPort?: number | null;
    }
  | null
  | undefined;

export function resolveProductionForwardServiceGatewayName(sandbox: GatewayBinding): string {
  if (sandbox?.gatewayPort !== undefined && sandbox.gatewayPort !== null) {
    const port = sandbox.gatewayPort;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return "invalid";
    return port === 8_080 ? "nemoclaw" : `nemoclaw-${String(port)}`;
  }
  if (sandbox?.gatewayName !== undefined && sandbox.gatewayName !== null) {
    return typeof sandbox.gatewayName === "string" ? sandbox.gatewayName : "invalid";
  }
  return "nemoclaw";
}

/** Bind production dashboard forwarding without widening the onboarding entry point. */
export function productionForwardServiceRegistryContext() {
  return {
    getSandbox: registry.getSandbox,
    listSandboxes: registry.listSandboxes,
    resolveGatewayName: resolveProductionForwardServiceGatewayName,
    retireLegacy: retireProductionLegacySandboxForwards,
  };
}

export interface MessagingHostForwardRollbackOptions {
  readonly buildRollbackMessage: (sandboxName: string, err: unknown) => readonly string[];
  readonly cliName: () => string;
  readonly error?: (message?: string) => void;
  readonly exit?: (code: number) => never;
}

export function resolveMessagingHostForward(
  plan: SandboxMessagingPlan | null | undefined,
  manifests?: readonly ChannelManifest[],
): SandboxMessagingHostForwardPlan | null {
  const hydrationOptions = manifests === undefined ? {} : { manifests };
  const normalizedPlan = plan ? parseSandboxMessagingPlan(plan, hydrationOptions) : null;
  if (!normalizedPlan) return null;
  const hydratedPlan = hydrateDerivedSandboxMessagingPlanFields(normalizedPlan, hydrationOptions);
  return getActiveMessagingHostForward(hydratedPlan);
}

function resolveMessagingPlanForSandbox(sandboxName: string): {
  readonly plan: SandboxMessagingPlan | null;
  readonly manifests?: readonly ChannelManifest[];
} {
  const entry = registry.getSandbox(sandboxName);
  const receiptBacked = entry?.harnessPackage != null || entry?.harnessPackageMigration != null;
  const manifests =
    entry && receiptBacked
      ? listMessagingChannelsForSandboxAuthority(entry, createBuiltInChannelManifestRegistry())
      : undefined;
  const envState = MessagingHostStateApplier.readPlanStateFromEnv();
  const plan =
    envState?.plan.sandboxName === sandboxName ? envState.plan : (entry?.messaging?.plan ?? null);
  return manifests === undefined ? { plan } : { plan, manifests };
}

export function resolveMessagingHostForwardForSandbox(
  sandboxName: string,
): SandboxMessagingHostForwardPlan | null {
  const context = resolveMessagingPlanForSandbox(sandboxName);
  return resolveMessagingHostForward(context.plan, context.manifests);
}

export function ensureMessagingHostForwardIfConfigured({
  sandboxName,
  plan,
  ensureForward,
  note,
  rollbackOnFailure,
  manifests,
}: {
  readonly sandboxName: string;
  readonly plan: SandboxMessagingPlan | null | undefined;
  readonly ensureForward: (sandboxName: string, port: number, label: string) => boolean;
  readonly note: (message: string) => void;
  readonly rollbackOnFailure?: MessagingHostForwardRollbackOptions;
  /** Exact composed manifests required for a receipt-backed plan. */
  readonly manifests?: readonly ChannelManifest[];
}): boolean {
  const forward = resolveMessagingHostForward(plan, manifests);
  if (!forward) return true;

  const ok = ensureForward(sandboxName, forward.port, forward.label);
  if (ok) {
    note(`  ✓ ${forward.label} forwarded at http://127.0.0.1:${forward.port}/`);
  } else if (rollbackOnFailure) {
    abortMessagingHostForwardFailure({ sandboxName, forward, rollback: rollbackOnFailure });
  }
  return ok;
}

export function ensureMessagingHostForwardForSandbox({
  sandboxName,
  ensureForward,
  note,
  rollbackOnFailure,
}: {
  readonly sandboxName: string;
  readonly ensureForward: (sandboxName: string, port: number, label: string) => boolean;
  readonly note: (message: string) => void;
  readonly rollbackOnFailure?: MessagingHostForwardRollbackOptions;
}): boolean {
  const context = resolveMessagingPlanForSandbox(sandboxName);
  return ensureMessagingHostForwardIfConfigured({
    sandboxName,
    plan: context.plan,
    ...(context.manifests === undefined ? {} : { manifests: context.manifests }),
    ensureForward,
    note,
    rollbackOnFailure,
  });
}

function abortMessagingHostForwardFailure({
  sandboxName,
  forward,
  rollback,
}: {
  readonly sandboxName: string;
  readonly forward: SandboxMessagingHostForwardPlan;
  readonly rollback: MessagingHostForwardRollbackOptions;
}): never {
  const error = new Error(
    `Failed to start ${forward.label} forward on port ${forward.port}. Free the port and ` +
      `re-run \`${rollback.cliName()} onboard\`, or choose a different messaging channel port.`,
  );
  const writeError = rollback.error ?? console.error;
  for (const line of rollback.buildRollbackMessage(sandboxName, error)) {
    writeError(line);
  }
  const exit = rollback.exit ?? process.exit;
  return exit(1);
}
