// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HarnessWebSearchCapability } from "@nvidia/nemoclaw-harness-contract";

import { supportsSandboxStartupControl } from "../../../agent-runtime/sandbox-create";
import { packageWebSearchProviderBinding as resolvePackageWebSearchProviderBinding } from "../../../agent-runtime/web-search";
export { normalizeHarnessToolGatewaySelections } from "../../../agent-runtime/tool-gateway";
import { isDcodeAgent } from "../../observability-policy-presets";

export {
  DEFAULT_SANDBOX_APPROVAL_MODE,
  hasSandboxApprovalModeDrift,
  hasSandboxObservabilityDrift,
  resolveSandboxApprovalMode,
  sandboxObservabilityFeature,
  type SandboxApprovalMode,
} from "../../managed-startup/startup-controls";

export function packageWebSearchProviderBinding(
  agent: { readonly web_search?: HarnessWebSearchCapability } | null,
  provider: "brave" | "tavily",
) {
  return resolvePackageWebSearchProviderBinding(agent, provider);
}

/** Resolve package-declared controls, retaining DCode only in the no-receipt lane. */
export function selectedAgentSupportsStartupControl<Agent>(
  agent: Agent,
  receiptBackedPackage: boolean,
  fromDockerfile: string | null,
  control: "approval-mode" | "observability",
): boolean {
  if (receiptBackedPackage) {
    return supportsSandboxStartupControl(
      agent as {
        sandbox_create?: import("@nvidia/nemoclaw-harness-contract").HarnessSandboxCreateDeclaration;
      } | null,
      control,
    );
  }
  return !fromDockerfile && isDcodeAgent((agent as { name?: string } | null)?.name);
}
