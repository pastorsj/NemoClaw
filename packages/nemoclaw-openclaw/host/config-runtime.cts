// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// SOURCE_OF_TRUTH_REVIEW (Anthropic reply budget; gateway regression #4504,
// OpenClaw 2026.6.10 adopted in #5595): OpenClaw rejects an Anthropic Messages
// model without a positive maxTokens value. Both image-time configuration and
// live inference changes use this package-owned fallback. Remove the fallback
// when the minimum supported OpenClaw supplies a positive budget for new
// anthropic-messages models.
const DEFAULT_OPENCLAW_MAX_TOKENS = 4096;

function isConfigObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveReplyBudget(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function readOpenClawPrimaryModelRef(config) {
  const agents = config.agents;
  if (!isConfigObject(agents)) return null;
  const defaults = agents.defaults;
  if (!isConfigObject(defaults)) return null;
  const selectedModel = defaults.model;
  return isConfigObject(selectedModel) && typeof selectedModel.primary === "string"
    ? selectedModel.primary
    : null;
}

function readOpenClawPrimaryProviderKey(config) {
  const primary = readOpenClawPrimaryModelRef(config);
  if (primary === null) return null;
  const separator = primary.indexOf("/");
  return separator > 0 ? primary.slice(0, separator) : null;
}

function readOpenClawProviderApi(config, providerKey) {
  const models = config.models;
  if (!isConfigObject(models)) return null;
  const providers = models.providers;
  if (!isConfigObject(providers) || !Object.hasOwn(providers, providerKey)) return null;
  const provider = providers[providerKey];
  return isConfigObject(provider) && typeof provider.api === "string" ? provider.api : null;
}

function readOpenClawPrimaryReplyBudget(config) {
  const primary = readOpenClawPrimaryModelRef(config);
  if (primary === null) return undefined;
  const separator = primary.indexOf("/");
  if (separator <= 0 || separator === primary.length - 1) return undefined;
  const providerKey = primary.slice(0, separator);
  const modelId = primary.slice(separator + 1);
  const models = config.models;
  if (!isConfigObject(models)) return undefined;
  const providers = models.providers;
  if (!isConfigObject(providers) || !Object.hasOwn(providers, providerKey)) return undefined;
  const provider = providers[providerKey];
  if (!isConfigObject(provider) || !Array.isArray(provider.models)) return undefined;

  for (const entry of provider.models) {
    if (!isConfigObject(entry)) continue;
    if (entry.name === primary || entry.id === modelId) {
      return positiveReplyBudget(entry.maxTokens);
    }
  }
  return undefined;
}

function applyOpenClawAnthropicReplyBudget(modelConfig, inheritedReplyBudget) {
  modelConfig.maxTokens =
    positiveReplyBudget(modelConfig.maxTokens) ??
    positiveReplyBudget(inheritedReplyBudget) ??
    DEFAULT_OPENCLAW_MAX_TOKENS;
}

function ensureObject(record, key) {
  const existing = record[key];
  if (isConfigObject(existing)) return existing;
  const created = {};
  record[key] = created;
  return created;
}

function cloneConfigObject(value) {
  return isConfigObject(value) ? { ...value } : {};
}

function isConfigValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return true;
  }
  if (Array.isArray(value)) return value.every(isConfigValue);
  if (!isConfigObject(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every(isConfigValue);
}

const OPENCLAW_UPSTREAM_PROVIDER_HEADER = "X-NemoClaw-Upstream-Provider";

function withOpenClawUpstreamProviderHeader(existing, upstreamProvider) {
  const headers = cloneConfigObject(existing.headers);
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === OPENCLAW_UPSTREAM_PROVIDER_HEADER.toLowerCase()) {
      delete headers[key];
    }
  }
  headers[OPENCLAW_UPSTREAM_PROVIDER_HEADER] = upstreamProvider;
  return { ...existing, headers };
}

function asConfigObject(value) {
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isConfigValue(entry)) result[key] = entry;
  }
  return result;
}

function updatePrimaryAgentListModel(agents, primaryModelRef) {
  const list = agents.list;
  if (!Array.isArray(list)) return;
  let defaultAgent;
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

function updateAgentPrimary(config, primaryModelRef) {
  const agents = ensureObject(config, "agents");
  const defaults = ensureObject(agents, "defaults");
  const model = ensureObject(defaults, "model");
  model.primary = primaryModelRef;
  updatePrimaryAgentListModel(agents, primaryModelRef);
}

function applyReasoningEffortParams(modelEntry, provider, route, request) {
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
  if (Object.keys(extraBody).length > 0) params.extra_body = extraBody;
  else delete params.extra_body;
  if (Object.keys(params).length > 0) modelEntry.params = params;
  else delete modelEntry.params;
}

function buildProviderConfig(
  existing,
  model,
  provider,
  route,
  contextWindow,
  inheritedMaxTokens,
  upstreamProviderMarker,
  reasoningEffort,
) {
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

  const providerConfig = {
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

function patchOpenClawInferenceConfig(
  config,
  provider,
  model,
  route,
  contextWindow,
  upstreamProviderMarker,
  reasoningEffort = { effort: null, explicit: false },
) {
  const before = JSON.stringify(config);
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

  return before !== JSON.stringify(config);
}

module.exports = {
  DEFAULT_OPENCLAW_MAX_TOKENS,
  applyOpenClawAnthropicReplyBudget,
  patchOpenClawInferenceConfig,
  readOpenClawPrimaryModelRef,
  readOpenClawPrimaryProviderKey,
  readOpenClawPrimaryReplyBudget,
  readOpenClawProviderApi,
};
