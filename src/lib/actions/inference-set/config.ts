// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessInferenceApi,
  HarnessInferenceConfigPostCommit,
  HarnessInferenceConfigUpdatePlan,
  HarnessInferenceConfigUpdateRequest,
} from "../../agent-runtime/config-module";
import type { HarnessPackageIdentity } from "../../agent-runtime/package/types";
import { applyHermesManagedRoute } from "../../hermes-managed-route";
import {
  getProviderSelectionConfig,
  getSandboxInferenceConfig,
  resolveAgentInferenceApi,
  type SandboxInferenceConfig,
} from "../../inference/config";
import type { ReasoningEffortRequest } from "../../inference/selection";
import type { AgentConfigTarget } from "../../sandbox/config";
import { toHarnessConfigTarget } from "../../sandbox/package-config";
import type { ConfigObject, ConfigValue } from "../../security/credential-filter";
import { isConfigObject, isConfigValue } from "../../security/credential-filter";
import { InferenceSetError } from "../inference-set-error";
import {
  applyOpenClawAnthropicReplyBudget,
  readOpenClawPrimaryReplyBudget,
} from "../inference-set-reply-budget";

export type { SandboxInferenceConfig } from "../../inference/config";

export function getInferenceSelectionConfig(provider: string, model?: string) {
  return getProviderSelectionConfig(provider, model);
}

export function resolveManagedInferenceRoute(
  model: string,
  provider: string,
  preferredInferenceApi: string | null,
): SandboxInferenceConfig {
  return getSandboxInferenceConfig(model, provider, preferredInferenceApi);
}

export function resolveLegacyAgentInferenceApi(
  agentName: string,
  provider: string,
  preferredInferenceApi: string | null,
): string | null {
  return resolveAgentInferenceApi(agentName, provider, preferredInferenceApi);
}

function ensureObject(record: ConfigObject, key: string): ConfigObject {
  const existing = record[key];
  if (isConfigObject(existing)) return existing;
  const created: ConfigObject = {};
  record[key] = created;
  return created;
}

function cloneConfigObject(value: ConfigValue | undefined): ConfigObject {
  if (!isConfigObject(value)) return {};
  return { ...value };
}

const OPENCLAW_UPSTREAM_PROVIDER_HEADER = "X-NemoClaw-Upstream-Provider";

function withOpenClawUpstreamProviderHeader(
  existing: ConfigObject,
  upstreamProvider: string,
): ConfigObject {
  const headers = cloneConfigObject(existing.headers);
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === OPENCLAW_UPSTREAM_PROVIDER_HEADER.toLowerCase()) {
      delete headers[key];
    }
  }
  headers[OPENCLAW_UPSTREAM_PROVIDER_HEADER] = upstreamProvider;
  return { ...existing, headers };
}

function asConfigObject(value: Record<string, unknown>): ConfigObject {
  const result: ConfigObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isConfigValue(entry as ConfigValue)) result[key] = entry as ConfigValue;
  }
  return result;
}

function updateAgentPrimary(config: ConfigObject, primaryModelRef: string): void {
  const agents = ensureObject(config, "agents");
  const defaults = ensureObject(agents, "defaults");
  const model = ensureObject(defaults, "model");
  model.primary = primaryModelRef;
  updatePrimaryAgentListModel(agents, primaryModelRef);
}

function updatePrimaryAgentListModel(agents: ConfigObject, primaryModelRef: string): void {
  const list = agents.list;
  if (!Array.isArray(list)) return;
  let defaultAgent: ConfigObject | undefined;
  for (const entry of list) {
    if (!isConfigObject(entry)) continue;
    if (entry.id === "main") {
      if (typeof entry.model === "string") entry.model = primaryModelRef;
      return;
    }
    if (!defaultAgent && entry.default === true) defaultAgent = entry;
  }
  if (defaultAgent && typeof defaultAgent.model === "string") {
    defaultAgent.model = primaryModelRef;
  }
}

function applyReasoningEffortParams(
  modelEntry: ConfigObject,
  provider: string,
  route: SandboxInferenceConfig,
  request: ReasoningEffortRequest,
): void {
  const canCarryReasoningEffort =
    provider === "compatible-endpoint" && route.inferenceApi === "openai-completions";
  if (!request.explicit && canCarryReasoningEffort) return;
  const params = isConfigObject(modelEntry.params) ? { ...modelEntry.params } : {};
  const extraBody = isConfigObject(params.extra_body) ? { ...params.extra_body } : {};
  if (request.effort && canCarryReasoningEffort) {
    extraBody.reasoning_effort = request.effort;
  } else {
    delete extraBody.reasoning_effort;
  }
  if (Object.keys(extraBody).length > 0) {
    params.extra_body = extraBody;
  } else {
    delete params.extra_body;
  }
  if (Object.keys(params).length > 0) {
    modelEntry.params = params;
  } else {
    delete modelEntry.params;
  }
}

function buildProviderConfig(
  existing: ConfigObject,
  model: string,
  provider: string,
  route: SandboxInferenceConfig,
  contextWindow?: number,
  inheritedMaxTokens?: number,
  upstreamProviderMarker?: string,
  reasoningEffort: ReasoningEffortRequest = { effort: null, explicit: false },
): ConfigObject {
  const firstExistingModel = Array.isArray(existing.models)
    ? cloneConfigObject(existing.models[0])
    : {};
  delete firstExistingModel.compat;
  firstExistingModel.id = model;
  firstExistingModel.name = route.primaryModelRef;
  if (typeof contextWindow === "number") firstExistingModel.contextWindow = contextWindow;
  if (route.inferenceApi === "anthropic-messages") {
    applyOpenClawAnthropicReplyBudget(firstExistingModel, inheritedMaxTokens);
  }
  if (route.inferenceCompat) firstExistingModel.compat = asConfigObject(route.inferenceCompat);
  applyReasoningEffortParams(firstExistingModel, provider, route, reasoningEffort);

  const providerConfig: ConfigObject = {
    ...existing,
    baseUrl: route.inferenceBaseUrl,
    apiKey: typeof existing.apiKey === "string" && existing.apiKey ? existing.apiKey : "unused",
    api: route.inferenceApi,
    models: [firstExistingModel],
  };
  return upstreamProviderMarker
    ? withOpenClawUpstreamProviderHeader(providerConfig, upstreamProviderMarker)
    : providerConfig;
}

/** Compatibility helper for no-receipt OpenClaw sandboxes. */
export function patchOpenClawInferenceConfig(
  config: ConfigObject,
  provider: string,
  model: string,
  preferredInferenceApi: string | null = null,
  contextWindow?: number,
  upstreamProviderMarker?: string,
  reasoningEffort: ReasoningEffortRequest = { effort: null, explicit: false },
): { changed: boolean; route: SandboxInferenceConfig } {
  const before = JSON.stringify(config);
  const route = getSandboxInferenceConfig(model, provider, preferredInferenceApi);
  const inheritedMaxTokens = readOpenClawPrimaryReplyBudget(config);

  updateAgentPrimary(config, route.primaryModelRef);
  const models = ensureObject(config, "models");
  models.mode = "merge";
  const providers = ensureObject(models, "providers");
  const existingProvider = cloneConfigObject(providers[route.providerKey]);
  providers[route.providerKey] = buildProviderConfig(
    existingProvider,
    model,
    provider,
    route,
    contextWindow,
    inheritedMaxTokens,
    upstreamProviderMarker,
    reasoningEffort,
  );

  return { changed: before !== JSON.stringify(config), route };
}

/** Compatibility helper for no-receipt Hermes sandboxes. */
export function patchHermesInferenceConfig(
  config: ConfigObject,
  provider: string,
  model: string,
  preferredInferenceApi: string | null = null,
  contextWindow?: number,
): { changed: boolean; route: SandboxInferenceConfig } {
  const before = JSON.stringify(config);
  const route = getSandboxInferenceConfig(model, provider, preferredInferenceApi);
  applyHermesManagedRoute(config, {
    model,
    baseUrl: route.inferenceBaseUrl,
    upstreamProvider: provider,
    inferenceApi: route.inferenceApi,
    contextWindow,
  });
  return { changed: before !== JSON.stringify(config), route };
}

export interface PreparedInferenceConfig {
  readonly config: ConfigObject;
  readonly changed: boolean;
  readonly route: SandboxInferenceConfig;
  readonly postCommit: HarnessInferenceConfigPostCommit;
}

export interface PackageInferenceConfigDeps {
  readonly preparePackageInferenceConfig: (
    identity: HarnessPackageIdentity,
    request: HarnessInferenceConfigUpdateRequest,
  ) => HarnessInferenceConfigUpdatePlan;
  readonly preserveConfigReadAuthority: (
    previous: ConfigObject,
    next: ConfigObject,
  ) => ConfigObject;
}

function requireHarnessInferenceApi(value: string): HarnessInferenceApi {
  if (
    value === "openai-completions" ||
    value === "anthropic-messages" ||
    value === "openai-responses"
  ) {
    return value;
  }
  throw new InferenceSetError("The resolved inference route uses an unsupported API family.", 2);
}

export function preparePackageInferenceConfig(options: {
  readonly identity: HarnessPackageIdentity;
  readonly target: AgentConfigTarget;
  readonly config: ConfigObject;
  readonly route: SandboxInferenceConfig;
  readonly provider: string;
  readonly model: string;
  readonly contextWindow: number | null;
  readonly reasoning: ReasoningEffortRequest;
  readonly deps: PackageInferenceConfigDeps;
}): PreparedInferenceConfig {
  const plan = options.deps.preparePackageInferenceConfig(options.identity, {
    target: toHarnessConfigTarget(options.target),
    config: options.config,
    route: {
      upstreamProvider: options.provider,
      model: options.model,
      providerKey: options.route.providerKey,
      primaryModelRef: options.route.primaryModelRef,
      baseUrl: options.route.inferenceBaseUrl,
      api: requireHarnessInferenceApi(options.route.inferenceApi),
      compatibility: options.route.inferenceCompat,
    },
    contextWindow: options.contextWindow,
    reasoning: options.reasoning,
  });
  if (plan.kind === "unsupported") {
    throw new InferenceSetError(
      `Inference configuration is not mutable for '${options.identity.id}': ${plan.reason}`,
      2,
    );
  }
  const actualChanged = JSON.stringify(options.config) !== JSON.stringify(plan.config);
  if (actualChanged !== plan.changed || !isConfigObject(plan.config)) {
    throw new InferenceSetError(
      `Installed inference configuration adapter for '${options.identity.id}' returned an inconsistent mutation.`,
      2,
    );
  }
  return {
    config: options.deps.preserveConfigReadAuthority(options.config, plan.config as ConfigObject),
    changed: plan.changed,
    route: options.route,
    postCommit: plan.postCommit,
  };
}
