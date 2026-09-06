// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type DcodeAutoApprovalMode,
  normalizeDcodeAutoApprovalMode,
} from "../../onboard/dcode-auto-approval";
import type * as registry from "../../state/registry";

/**
 * Preserve the DCode-only status field for registry rows created before
 * package receipts became authoritative. Receipt-backed packages must expose
 * future status capabilities through typed package metadata instead of making
 * core recognize their package identifier.
 */
export function resolveLegacyDcodeAutoApprovalMode(
  sandbox: registry.SandboxEntry | null,
): DcodeAutoApprovalMode | null {
  if (
    sandbox?.harnessPackage != null ||
    sandbox?.harnessPackageMigration != null ||
    sandbox?.agent !== "langchain-deepagents-code"
  ) {
    return null;
  }
  return normalizeDcodeAutoApprovalMode(sandbox.dcodeAutoApprovalMode);
}

/** Keep the pre-receipt DCode invocation probe selection out of generic status. */
export function resolveLegacyInferenceProbeAgentName(
  sandbox: registry.SandboxEntry | null,
): string | null {
  if (sandbox?.harnessPackage != null || sandbox?.harnessPackageMigration != null) return null;
  return sandbox?.agent === "langchain-deepagents-code" ? sandbox.agent : null;
}

/** Preserve the pre-receipt OpenClaw markerless delivery check. */
export function needsLegacyManagedGatewayDeliveryProof(sandbox: registry.SandboxEntry): boolean {
  if (sandbox.harnessPackage != null || sandbox.harnessPackageMigration != null) return false;
  return (sandbox.agent ?? "openclaw") === "openclaw";
}
