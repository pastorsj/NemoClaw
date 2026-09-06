// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { rebindLoopbackDashboardUrlPort } from "../../../dashboard/url";
import type { SandboxMessagingPlan } from "../../../messaging";
import { shouldManageDashboardForAgent } from "../../../onboard/dashboard-runtime";
import { resolveHermesDashboardOnboardState } from "../../../onboard/hermes-dashboard";
import { managedStartupSettingsFromProfile } from "../../../onboard/managed-startup/package-profile";
import type {
  LegacyManagedWorkloadRebuildCatalogHandoff,
  LegacyManagedWorkloadRebuildHandoff,
} from "../../../onboard/workload/rebuild";
import { stageManagedWorkloadRebuildProfile } from "../../../onboard/workload/rebuild";
import type { RebuildRecreateOnboardOpts } from "../rebuild-gpu-opt-out";
import type { RebuildTargetConfig } from "../rebuild-target-preflight";

type ManagedStartupInferenceApi = "openai-completions" | "openai-responses" | "anthropic-messages";

function requireManagedStartupInferenceApi(api: string): ManagedStartupInferenceApi {
  switch (api) {
    case "openai-completions":
    case "openai-responses":
    case "anthropic-messages":
      return api;
    default:
      throw new Error(`Unsupported managed startup inference API '${api}'.`);
  }
}

export function resolveManagedRebuildOpenClawReasoning(
  provider: string,
  compatibleEndpointReasoning: "true" | "false" | null,
): boolean {
  return provider === "compatible-endpoint" && compatibleEndpointReasoning === "true";
}

export function resolveManagedRebuildOpenClawReasoningEffort(
  provider: string,
  inferenceApi: string,
  compatibleEndpointReasoningEffort: "low" | "medium" | "high" | null,
): "default" | "low" | "medium" | "high" {
  return provider === "compatible-endpoint" && inferenceApi === "openai-completions"
    ? (compatibleEndpointReasoningEffort ?? "default")
    : "default";
}

export interface LegacyManagedRebuildProfileDependencies {
  readonly resolveContextWindowForModel: typeof import("../../../inference/context-window").resolveContextWindowForModel;
  readonly resolveManagedStartupInferenceRoute: typeof import("../../../onboard/inference-route").resolveManagedStartupInferenceRoute;
}

/** Reconstruct startup intent only for pre-package, no-receipt managed workloads. */
export function prepareLegacyManagedRebuildProfileHandoff(
  input: {
    readonly catalogHandoff: LegacyManagedWorkloadRebuildCatalogHandoff;
    readonly targetConfig: RebuildTargetConfig;
    readonly recreateOptions: RebuildRecreateOnboardOpts;
    readonly messagingPlan: SandboxMessagingPlan | null;
    readonly environment?: NodeJS.ProcessEnv;
  },
  dependencies: LegacyManagedRebuildProfileDependencies,
): LegacyManagedWorkloadRebuildHandoff {
  const { catalogHandoff, targetConfig, recreateOptions, messagingPlan } = input;
  const agent = catalogHandoff.agent;
  const { resumeConfig, durableConfig } = targetConfig;
  const previousDesiredState = managedStartupSettingsFromProfile(catalogHandoff.previousProfile);
  const manageDashboard = shouldManageDashboardForAgent(targetConfig.agentDefinition);
  const effectiveDashboardPort = manageDashboard ? (recreateOptions.controlUiPort ?? 0) : 0;
  const previousDashboard = previousDesiredState.dashboard;
  const previousHermesBrowserUrl =
    agent === "hermes" && previousDashboard.agent === "hermes"
      ? previousDashboard.browserUrl
      : undefined;
  const hermesDashboardState = resolveHermesDashboardOnboardState({
    agentName: agent,
    effectivePort: effectiveDashboardPort,
    env: input.environment ?? process.env,
  });
  if (
    agent === "hermes" &&
    manageDashboard &&
    hermesDashboardState.enabled &&
    previousHermesBrowserUrl === undefined
  ) {
    throw new Error(
      "Cannot rebuild the Hermes dashboard because its managed startup profile has no recorded browser URL. Rerun onboarding, then rebuild the sandbox.",
    );
  }
  const chatUiUrl = manageDashboard
    ? previousHermesBrowserUrl === undefined
      ? `http://127.0.0.1:${String(effectiveDashboardPort)}`
      : rebindLoopbackDashboardUrlPort(previousHermesBrowserUrl, effectiveDashboardPort)
    : "";
  const inference = dependencies.resolveManagedStartupInferenceRoute(
    agent,
    resumeConfig.provider,
    resumeConfig.model,
    resumeConfig.preferredInferenceApi,
  );
  const upstreamProvider =
    agent === "hermes" && resumeConfig.provider === "hermes-provider"
      ? previousDesiredState.inference.upstreamProvider
      : resumeConfig.provider;
  const currentOpenClawContextWindow =
    agent === "openclaw"
      ? dependencies.resolveContextWindowForModel(resumeConfig.provider, resumeConfig.model)
      : null;
  if (
    agent === "openclaw" &&
    currentOpenClawContextWindow === null &&
    (previousDesiredState.inference.model !== resumeConfig.model ||
      previousDesiredState.inference.upstreamProvider !== resumeConfig.provider)
  ) {
    throw new Error(
      `Cannot determine a context window for the current OpenClaw target '${resumeConfig.provider}/${resumeConfig.model}'.`,
    );
  }

  const staged = stageManagedWorkloadRebuildProfile(
    catalogHandoff,
    {
      inference: {
        routeProvider: inference.providerKey,
        upstreamProvider,
        model: resumeConfig.model,
        routedBaseUrl: inference.inferenceBaseUrl,
        upstreamEndpointUrl:
          agent === "langchain-deepagents-code" ? resumeConfig.endpointUrl : null,
        api: requireManagedStartupInferenceApi(inference.inferenceApi),
        primaryModelRef: agent === "openclaw" ? inference.primaryModelRef : null,
        compatibility: agent === "openclaw" ? (inference.inferenceCompat ?? {}) : null,
      },
      chatUiUrl,
      effectiveDashboardPort,
      manageDashboard,
      dashboardBindAddress:
        previousDashboard.agent === "openclaw" && previousDashboard.bindAddress === "0.0.0.0"
          ? "0.0.0.0"
          : undefined,
      wslExposure:
        previousDashboard.agent === "openclaw" && (previousDashboard.wslExposure ?? false),
      hermesDashboardState,
      webSearch: durableConfig.webSearchConfig,
      toolDisclosure: recreateOptions.toolDisclosure,
      hermesToolGateways: targetConfig.hermesToolGateways,
      messagingPlan,
      dcodeAutoApprovalMode: recreateOptions.dcodeAutoApprovalMode,
      observabilityEnabled: recreateOptions.observabilityEnabled,
    },
    input.environment,
    agent === "openclaw"
      ? {
          ...(currentOpenClawContextWindow === null
            ? {}
            : { openClawContextWindow: currentOpenClawContextWindow }),
          openClawReasoning: resolveManagedRebuildOpenClawReasoning(
            resumeConfig.provider,
            resumeConfig.compatibleEndpointReasoning,
          ),
          openClawReasoningEffort: resolveManagedRebuildOpenClawReasoningEffort(
            resumeConfig.provider,
            inference.inferenceApi,
            resumeConfig.compatibleEndpointReasoningEffort,
          ),
        }
      : {},
  );
  if (staged.harnessPackage) {
    throw new Error("Legacy rebuild profile reconstruction returned package authority.");
  }
  return staged;
}
