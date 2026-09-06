// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HarnessStartupSettings } from "@nvidia/nemoclaw-harness-contract";
import type {
  ManagedStartupDurableProfile,
  ManagedStartupReasoningEffort,
} from "../managed-startup/profile";
import { isManagedStartupPackageProfile } from "../managed-startup/profile";

const HOST_PROXY_ENV_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

/** Legacy rebuild overrides retained only for pre-package startup profiles. */
export interface ManagedWorkloadRebuildProfileOverrides {
  readonly openClawContextWindow?: number;
  readonly openClawReasoning?: boolean;
  readonly openClawReasoningEffort?: ManagedStartupReasoningEffort;
}

export interface ManagedPackageRebuildProfileOverrides {
  readonly contextWindow?: number;
  readonly reasoning?: boolean;
  readonly reasoningEffort?: ManagedStartupReasoningEffort;
}

interface LegacyManagedWorkloadProfileSource {
  readonly previousProfile: ManagedStartupDurableProfile;
  readonly previousReceipt: {
    readonly credentialProxyReplayRequired: boolean;
  };
}

/**
 * Reconstruct the legacy environment-owned startup fields for a pre-package
 * workload. Receipt-backed package profiles never cross this compatibility
 * boundary; the generic desired-state projection below leaves their package
 * configuration opaque for adapter-owned reconciliation.
 */
export function managedWorkloadRebuildProfileEnvironment(
  handoff: LegacyManagedWorkloadProfileSource,
  environment: NodeJS.ProcessEnv,
  overrides: ManagedWorkloadRebuildProfileOverrides = {},
): NodeJS.ProcessEnv {
  if (isManagedStartupPackageProfile(handoff.previousProfile)) {
    throw new Error("Receipt-backed package profiles cannot enter legacy rebuild projection.");
  }
  const result: NodeJS.ProcessEnv = {
    NEMOCLAW_PROXY_HOST: handoff.previousProfile.proxy.managedHost,
    NEMOCLAW_PROXY_PORT: String(handoff.previousProfile.proxy.managedPort),
  };
  const previous = handoff.previousProfile;
  if (previous.agent === "openclaw" && previous.agentConfig.agent === "openclaw") {
    const config = previous.agentConfig;
    const contextWindow = overrides.openClawContextWindow ?? previous.tuning.contextWindow;
    if (contextWindow !== null) result.NEMOCLAW_CONTEXT_WINDOW = String(contextWindow);
    if (previous.tuning.maxTokens !== null) {
      result.NEMOCLAW_MAX_TOKENS = String(previous.tuning.maxTokens);
    }
    const reasoning = overrides.openClawReasoning ?? previous.tuning.reasoning;
    if (reasoning !== null) result.NEMOCLAW_REASONING = String(reasoning);
    const reasoningEffort = overrides.openClawReasoningEffort ?? previous.tuning.reasoningEffort;
    if (reasoningEffort !== null) result.NEMOCLAW_REASONING_EFFORT = reasoningEffort;
    if (previous.inference.inputModalities !== null) {
      result.NEMOCLAW_INFERENCE_INPUTS = previous.inference.inputModalities.join(",");
    }
    result.NEMOCLAW_AGENT_TIMEOUT = String(config.agentTimeoutSeconds);
    if (config.heartbeatEvery !== null) {
      result.NEMOCLAW_AGENT_HEARTBEAT_EVERY = config.heartbeatEvery;
    }
    result.NEMOCLAW_EXTRA_AGENTS_JSON_B64 = Buffer.from(
      JSON.stringify(config.extraAgents),
      "utf8",
    ).toString("base64");
    result.NEMOCLAW_MINIMAL_BOOTSTRAP = config.minimalBootstrap ? "1" : "0";
    result.NEMOCLAW_OPENCLAW_OTEL = config.otel.enabled ? "1" : "0";
    result.NEMOCLAW_OPENCLAW_OTEL_ENDPOINT = config.otel.endpointUrl;
    result.NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME = config.otel.serviceName;
    result.NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE = String(config.otel.sampleRate);
  } else if (previous.agent === "hermes" && previous.tuning.contextWindow !== null) {
    result.NEMOCLAW_CONTEXT_WINDOW = String(previous.tuning.contextWindow);
  }

  if (handoff.previousReceipt.credentialProxyReplayRequired) {
    for (const name of HOST_PROXY_ENV_NAMES) {
      const value = environment[name];
      if (value !== undefined) result[name] = value;
    }
    return result;
  }
  const proxy = handoff.previousProfile.proxy;
  if (proxy.hostHttpUrl) result.HTTP_PROXY = proxy.hostHttpUrl;
  if (proxy.hostHttpsUrl) result.HTTPS_PROXY = proxy.hostHttpsUrl;
  if (proxy.hostNoProxy.length > 0) result.NO_PROXY = proxy.hostNoProxy.join(",");
  return result;
}

/**
 * Reconstruct only environment-owned fields from core-validated desired state.
 * Package-owned config remains opaque and never enters this projection.
 */
export function managedPackageRebuildProfileEnvironment(
  desiredState: HarnessStartupSettings,
  credentialProxyReplayRequired: boolean,
  environment: NodeJS.ProcessEnv,
  overrides: ManagedPackageRebuildProfileOverrides = {},
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    NEMOCLAW_PROXY_HOST: desiredState.proxy.managedHost,
    NEMOCLAW_PROXY_PORT: String(desiredState.proxy.managedPort),
  };
  const contextWindow = overrides.contextWindow ?? desiredState.tuning.contextWindow;
  if (contextWindow !== null) result.NEMOCLAW_CONTEXT_WINDOW = String(contextWindow);
  if (desiredState.tuning.maxTokens !== null) {
    result.NEMOCLAW_MAX_TOKENS = String(desiredState.tuning.maxTokens);
  }
  const reasoning = overrides.reasoning ?? desiredState.tuning.reasoning;
  if (reasoning !== null) result.NEMOCLAW_REASONING = String(reasoning);
  const reasoningEffort = overrides.reasoningEffort ?? desiredState.tuning.reasoningEffort;
  if (reasoningEffort !== null) result.NEMOCLAW_REASONING_EFFORT = reasoningEffort;
  if (desiredState.inference.inputModalities !== null) {
    result.NEMOCLAW_INFERENCE_INPUTS = desiredState.inference.inputModalities.join(",");
  }

  const config = desiredState.configuration;
  if (config.agentTimeoutSeconds !== undefined) {
    result.NEMOCLAW_AGENT_TIMEOUT = String(config.agentTimeoutSeconds);
  }
  if (config.heartbeatEvery !== undefined && config.heartbeatEvery !== null) {
    result.NEMOCLAW_AGENT_HEARTBEAT_EVERY = config.heartbeatEvery;
  }
  if (config.extraAgents !== undefined) {
    result.NEMOCLAW_EXTRA_AGENTS_JSON_B64 = Buffer.from(
      JSON.stringify(config.extraAgents),
      "utf8",
    ).toString("base64");
  }
  if (config.minimalBootstrap !== undefined) {
    result.NEMOCLAW_MINIMAL_BOOTSTRAP = config.minimalBootstrap ? "1" : "0";
  }
  if (config.otel !== undefined) {
    result.NEMOCLAW_OPENCLAW_OTEL = config.otel.enabled ? "1" : "0";
    result.NEMOCLAW_OPENCLAW_OTEL_ENDPOINT = config.otel.endpointUrl;
    result.NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME = config.otel.serviceName;
    result.NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE = String(config.otel.sampleRate);
  }

  if (credentialProxyReplayRequired) {
    for (const name of HOST_PROXY_ENV_NAMES) {
      const value = environment[name];
      if (value !== undefined) result[name] = value;
    }
    return result;
  }
  if (desiredState.proxy.hostHttpUrl) result.HTTP_PROXY = desiredState.proxy.hostHttpUrl;
  if (desiredState.proxy.hostHttpsUrl) result.HTTPS_PROXY = desiredState.proxy.hostHttpsUrl;
  if (desiredState.proxy.hostNoProxy.length > 0) {
    result.NO_PROXY = desiredState.proxy.hostNoProxy.join(",");
  }
  return result;
}
