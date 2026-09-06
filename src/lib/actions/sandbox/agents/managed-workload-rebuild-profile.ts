// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { rebindLoopbackDashboardUrlPort } from "../../../dashboard/url";
import { resolveContextWindowForModel } from "../../../inference/context-window";
import type { SandboxMessagingPlan } from "../../../messaging";
import { shouldManageDashboardForAgent } from "../../../onboard/dashboard-runtime";
import {
  resolveManagedStartupInferenceRoute,
  resolveManagedStartupSandboxInferenceConfig,
} from "../../../onboard/inference-route";
import { buildManagedStartupInferenceCandidates } from "../../../onboard/managed-startup/package-input";
import {
  type ManagedWorkloadRebuildCatalogHandoff,
  type ManagedWorkloadRebuildHandoff,
  stagePreparedManagedPackageWorkloadRebuildProfile,
} from "../../../onboard/workload/rebuild";
import { managedPackageRebuildProfileEnvironment } from "../../../onboard/workload/rebuild-compat";
import type { RebuildRecreateOnboardOpts } from "../rebuild-gpu-opt-out";
import type { RebuildTargetConfig } from "../rebuild-target-preflight";
import { prepareLegacyManagedRebuildProfileHandoff } from "./legacy-rebuild";

export {
  resolveManagedRebuildOpenClawReasoning,
  resolveManagedRebuildOpenClawReasoningEffort,
} from "./legacy-rebuild";

export const managedRebuildProfileDependencies = {
  getSandboxInferenceConfig: resolveManagedStartupSandboxInferenceConfig,
  resolveContextWindowForModel,
  resolveManagedStartupInferenceRoute,
};

/** Render the exact replacement profile while the old managed workload remains authoritative. */
export function prepareManagedRebuildProfileHandoff(input: {
  readonly catalogHandoff: ManagedWorkloadRebuildCatalogHandoff;
  readonly targetConfig: RebuildTargetConfig;
  readonly recreateOptions: RebuildRecreateOnboardOpts;
  readonly messagingPlan: SandboxMessagingPlan | null;
  readonly toolDisclosureRequestedExplicitly?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
}): ManagedWorkloadRebuildHandoff {
  const { catalogHandoff, targetConfig, recreateOptions, messagingPlan } = input;
  const { resumeConfig, durableConfig } = targetConfig;
  const manageDashboard = shouldManageDashboardForAgent(targetConfig.agentDefinition);
  const effectiveDashboardPort = manageDashboard ? (recreateOptions.controlUiPort ?? 0) : 0;
  if (catalogHandoff.harnessPackage) {
    const previousDesiredState = catalogHandoff.previousProfile.desiredState;
    const previousDashboard = previousDesiredState.dashboard;
    const candidates = buildManagedStartupInferenceCandidates(
      resumeConfig.model,
      resumeConfig.provider,
      resumeConfig.preferredInferenceApi,
      managedRebuildProfileDependencies.getSandboxInferenceConfig,
    );
    const forwardingEnabled = previousDashboard.mode === "loopback-forwarded";
    const previousBrowserUrl = previousDashboard.browserUrl;
    const dashboardUrl = manageDashboard
      ? rebindLoopbackDashboardUrlPort(
          previousBrowserUrl ?? `http://127.0.0.1:${String(effectiveDashboardPort)}`,
          effectiveDashboardPort,
        )
      : "";
    return stagePreparedManagedPackageWorkloadRebuildProfile(catalogHandoff, {
      inference: {
        selectedProvider: resumeConfig.provider,
        model: resumeConfig.model,
        endpointUrl: resumeConfig.endpointUrl,
        resolvedContextWindow: managedRebuildProfileDependencies.resolveContextWindowForModel(
          resumeConfig.provider,
          resumeConfig.model,
        ),
        reasoningEnabled:
          resumeConfig.compatibleEndpointReasoning === null
            ? null
            : resumeConfig.compatibleEndpointReasoning === "true",
        reasoningEffort: resumeConfig.compatibleEndpointReasoningEffort,
        candidates,
      },
      dashboard: {
        managed: manageDashboard,
        url: dashboardUrl,
        port: effectiveDashboardPort,
        bindAddress: previousDashboard.bindAddress === "0.0.0.0" ? "0.0.0.0" : undefined,
        wslExposure: previousDashboard.wslExposure ?? false,
        forwarding: {
          enabled: forwardingEnabled,
          publicPort: forwardingEnabled ? effectiveDashboardPort : null,
          internalPort: forwardingEnabled ? (previousDashboard.internalPort ?? null) : null,
          tuiEnabled: forwardingEnabled && (previousDashboard.tuiEnabled ?? false),
        },
      },
      webSearch: durableConfig.webSearchConfig,
      toolDisclosure: recreateOptions.toolDisclosure,
      enabledToolGateways: targetConfig.hermesToolGateways,
      messagingPlan,
      approvalMode: recreateOptions.dcodeAutoApprovalMode,
      observabilityEnabled: recreateOptions.observabilityEnabled,
      environment: managedPackageRebuildProfileEnvironment(
        catalogHandoff.previousProfile.desiredState,
        catalogHandoff.previousReceipt.credentialProxyReplayRequired,
        input.environment ?? process.env,
      ),
      corporateCa: catalogHandoff.corporateCa,
    });
  }
  return prepareLegacyManagedRebuildProfileHandoff(
    {
      catalogHandoff,
      targetConfig,
      recreateOptions,
      messagingPlan,
      ...(input.environment === undefined ? {} : { environment: input.environment }),
    },
    managedRebuildProfileDependencies,
  );
}
