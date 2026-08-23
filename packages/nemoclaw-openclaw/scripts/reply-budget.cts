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

function readOpenClawPrimaryReplyBudget(config) {
  const agents = config.agents;
  if (!isConfigObject(agents)) return undefined;
  const defaults = agents.defaults;
  if (!isConfigObject(defaults)) return undefined;
  const selectedModel = defaults.model;
  if (!isConfigObject(selectedModel) || typeof selectedModel.primary !== "string") {
    return undefined;
  }

  const primary = selectedModel.primary;
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

module.exports = {
  DEFAULT_OPENCLAW_MAX_TOKENS,
  applyOpenClawAnthropicReplyBudget,
  readOpenClawPrimaryReplyBudget,
};
