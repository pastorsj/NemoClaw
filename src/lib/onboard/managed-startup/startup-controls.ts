// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HarnessStartupApprovalMode } from "@nvidia/nemoclaw-harness-contract";
import { supportsSandboxStartupControl } from "../../agent-runtime/sandbox-create";

import {
  managedSandboxFeatureHasDrift,
  resolveManagedSandboxFeature,
  type ManagedSandboxFeature,
  type ManagedSandboxFeatureResolution,
} from "../managed-sandbox-feature";

export const SANDBOX_APPROVAL_MODES = ["disabled", "thread-opt-in"] as const;
export type SandboxApprovalMode = HarnessStartupApprovalMode;
export const DEFAULT_SANDBOX_APPROVAL_MODE: SandboxApprovalMode = "disabled";

/** Keep package-declared startup-control selection behind the startup-control boundary. */
export const packageSupportsSandboxStartupControl = supportsSandboxStartupControl;

export function isSandboxApprovalMode(value: unknown): value is SandboxApprovalMode {
  return value === "disabled" || value === "thread-opt-in";
}

export function invalidRecordedSandboxApprovalMode(value: unknown): boolean {
  return value !== undefined && value !== null && !isSandboxApprovalMode(value);
}

function selectedFeature<T>(input: {
  readonly id: string;
  readonly supported: boolean;
  readonly defaultValue: T;
  readonly isValue: (value: unknown) => value is T;
  readonly isEnabled: (value: T) => boolean;
}): ManagedSandboxFeature<T> {
  return {
    id: input.id,
    defaultValue: input.defaultValue,
    isValue: input.isValue,
    isEnabled: input.isEnabled,
    supportsAgent: () => input.supported,
  };
}

export function sandboxObservabilityFeature(supported: boolean): ManagedSandboxFeature<boolean> {
  return selectedFeature({
    id: "observability",
    supported,
    defaultValue: false,
    isValue: (value): value is boolean => typeof value === "boolean",
    isEnabled: (value) => value,
  });
}

function sandboxApprovalFeature(supported: boolean): ManagedSandboxFeature<SandboxApprovalMode> {
  return selectedFeature({
    id: "approval-mode",
    supported,
    defaultValue: DEFAULT_SANDBOX_APPROVAL_MODE,
    isValue: isSandboxApprovalMode,
    isEnabled: (value) => value !== DEFAULT_SANDBOX_APPROVAL_MODE,
  });
}

export function resolveSandboxApprovalMode(input: {
  readonly supported: boolean;
  readonly requestedMode: SandboxApprovalMode | null | undefined;
  readonly recordedMode: unknown;
}): ManagedSandboxFeatureResolution<SandboxApprovalMode> {
  if (invalidRecordedSandboxApprovalMode(input.recordedMode)) {
    throw new Error(
      "Recorded sandbox approval mode is invalid; repair it to 'disabled' before retrying.",
    );
  }
  return resolveManagedSandboxFeature(sandboxApprovalFeature(input.supported), {
    agent: null,
    requested: input.requestedMode,
    registryValue: isSandboxApprovalMode(input.recordedMode) ? input.recordedMode : null,
  });
}

export function hasSandboxApprovalModeDrift(input: {
  readonly supported: boolean;
  readonly liveExists: boolean;
  readonly hasRegistryEntry: boolean;
  readonly recordedMode: unknown;
  readonly requestedMode: unknown;
}): boolean {
  if (invalidRecordedSandboxApprovalMode(input.recordedMode)) return true;
  const requestedMode = isSandboxApprovalMode(input.requestedMode)
    ? input.requestedMode
    : DEFAULT_SANDBOX_APPROVAL_MODE;
  return managedSandboxFeatureHasDrift(sandboxApprovalFeature(input.supported), {
    liveExists: input.liveExists,
    hasRegistryEntry: input.hasRegistryEntry,
    agent: null,
    recordedValue: isSandboxApprovalMode(input.recordedMode) ? input.recordedMode : null,
    desiredValue: requestedMode,
  });
}

export function hasSandboxObservabilityDrift(input: {
  readonly supported: boolean;
  readonly liveExists: boolean;
  readonly hasRegistryEntry: boolean;
  readonly recordedEnabled: boolean | null | undefined;
  readonly requestedEnabled: boolean | null | undefined;
}): boolean {
  return managedSandboxFeatureHasDrift(sandboxObservabilityFeature(input.supported), {
    liveExists: input.liveExists,
    hasRegistryEntry: input.hasRegistryEntry,
    agent: null,
    recordedValue: input.recordedEnabled,
    desiredValue: input.requestedEnabled === true,
  });
}

export interface SandboxApprovalCreatePlan {
  readonly mode: SandboxApprovalMode;
  readonly hasDrift: boolean;
  /** Generic receipt-backed control has no package-specific CLI flag in core. */
  readonly rebuildFlag: "";
}

export function prepareSandboxApprovalCreatePlan(
  input: {
    readonly sandboxName: string;
    readonly supported: boolean;
    readonly liveExists: boolean;
    readonly registryEntry: { readonly approvalMode?: unknown } | null;
    readonly requestedMode: SandboxApprovalMode | null | undefined;
  },
  deps: { error(message: string): void; exitProcess(code: number): never },
): SandboxApprovalCreatePlan {
  if (input.liveExists && input.supported && !input.registryEntry) {
    deps.error(
      `  Sandbox '${input.sandboxName}' is live but missing its NemoClaw registry record; refusing unverified approval-mode reuse or recreation.`,
    );
    deps.error(
      "  Choose a different sandbox name, or remove the orphan explicitly with OpenShell.",
    );
    return deps.exitProcess(1);
  }
  let resolution: ManagedSandboxFeatureResolution<SandboxApprovalMode>;
  try {
    resolution = resolveSandboxApprovalMode({
      supported: input.supported,
      requestedMode: input.requestedMode,
      recordedMode: input.registryEntry?.approvalMode,
    });
  } catch (error) {
    deps.error(`  ${error instanceof Error ? error.message : String(error)}`);
    return deps.exitProcess(1);
  }
  if (resolution.issue === "unsupported-request") {
    deps.error(
      "  The selected harness package does not declare the approval-mode startup control.",
    );
    return deps.exitProcess(1);
  }
  if (resolution.issue === "recorded-state-on-unsupported-agent") {
    deps.error(
      "  Recorded approval mode belongs to a different harness. Select disabled explicitly before switching harnesses.",
    );
    return deps.exitProcess(1);
  }
  return {
    mode: resolution.value,
    hasDrift: hasSandboxApprovalModeDrift({
      supported: input.supported,
      liveExists: input.liveExists,
      hasRegistryEntry: input.registryEntry !== null,
      recordedMode: input.registryEntry?.approvalMode,
      requestedMode: resolution.value,
    }),
    // Receipt-backed packages do not own a package-specific rebuild flag in core.
    // The selected startup adapter receives the mode through the typed profile.
    rebuildFlag: "",
  };
}
