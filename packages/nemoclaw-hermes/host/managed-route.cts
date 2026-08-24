// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Hermes requires an sk-prefixed value before it sends a request. OpenShell
// removes this non-secret sentinel and injects the route credential at egress.
const HERMES_PROXY_REWRITE_SENTINEL = "sk-OPENSHELL-PROXY-REWRITE";
const HEADER_VALUE_MAX_LENGTH = 128;

function isObjectRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hermesApiMode(inferenceApi) {
  switch (inferenceApi) {
    case "":
    case "openai-completions":
      return null;
    case "anthropic-messages":
      return "anthropic_messages";
    case "openai-responses":
      return "codex_responses";
    default:
      throw new Error(`Unsupported Hermes inference API: ${inferenceApi}`);
  }
}

function hermesProviderKey(provider) {
  const normalized = provider
    .trim()
    .toLowerCase()
    .replaceAll(" ", "-")
    .replace(/[()]/gu, "")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
  return normalized || "nemoclaw-inference";
}

function sanitizeHeaderValue(value) {
  // Prevent a registry or session value from escaping the YAML comment block.
  const stripped = value.replace(/[\x00-\x1F\x7F-\x9F]/g, "");
  return stripped.length > HEADER_VALUE_MAX_LENGTH
    ? stripped.slice(0, HEADER_VALUE_MAX_LENGTH)
    : stripped;
}

function buildHermesUpstreamHeader(config) {
  const upstream = config._nemoclaw_upstream;
  if (!isObjectRecord(upstream)) return "";
  const provider = sanitizeHeaderValue(
    typeof upstream.provider === "string" ? upstream.provider : "",
  );
  const model = sanitizeHeaderValue(typeof upstream.model === "string" ? upstream.model : "");
  if (!provider && !model) return "";

  const lines = ["# Managed by NemoClaw — Hermes configuration"];
  if (provider) lines.push(`# Upstream provider: ${provider}`);
  if (model) lines.push(`# Upstream model: ${model}`);
  lines.push("# OpenShell rewrites model.base_url to the upstream endpoint at request time.");
  return `${lines.join("\n")}\n`;
}

/** Apply the complete NemoClaw-owned Hermes route to an existing config. */
function applyHermesManagedRoute(config, route) {
  const providerName = route.upstreamProvider || "nemoclaw-inference";
  const providerKey = hermesProviderKey(providerName);
  const apiMode = hermesApiMode(route.inferenceApi);
  const previousUpstream = isObjectRecord(config._nemoclaw_upstream)
    ? config._nemoclaw_upstream
    : {};
  const previousProviderKey =
    typeof previousUpstream.provider_key === "string" ? previousUpstream.provider_key : "";

  const modelConfig = {
    default: route.model,
    provider: "custom",
    base_url: route.baseUrl,
    api_key: HERMES_PROXY_REWRITE_SENTINEL,
  };
  if (apiMode) modelConfig.api_mode = apiMode;
  if (route.contextWindow !== null && route.contextWindow !== undefined) {
    // Hermes reads context_length before endpoint discovery and model metadata.
    modelConfig.context_length = route.contextWindow;
  }

  const providerConfig = {
    name: providerName,
    api: route.baseUrl,
    api_key: HERMES_PROXY_REWRITE_SENTINEL,
    default_model: route.model,
    discover_models: true,
  };
  if (apiMode) providerConfig.transport = apiMode;

  const customProvider = {
    name: providerName,
    base_url: route.baseUrl,
    api_key: HERMES_PROXY_REWRITE_SENTINEL,
    discover_models: true,
  };
  if (apiMode) customProvider.api_mode = apiMode;

  const providers = isObjectRecord(config.providers) ? { ...config.providers } : {};
  if (previousProviderKey && previousProviderKey !== providerKey) {
    delete providers[previousProviderKey];
  }
  providers[providerKey] = providerConfig;

  const customProviders = Array.isArray(config.custom_providers)
    ? config.custom_providers.filter(
        (entry) =>
          !isObjectRecord(entry) ||
          (entry.name !== previousUpstream.provider && entry.name !== providerName),
      )
    : [];
  customProviders.push(customProvider);

  config._nemoclaw_upstream = {
    provider: providerName,
    provider_key: providerKey,
    model: route.model,
  };
  config.model = modelConfig;
  config.providers = providers;
  config.custom_providers = customProviders;
}

module.exports = {
  HERMES_PROXY_REWRITE_SENTINEL,
  applyHermesManagedRoute,
  buildHermesUpstreamHeader,
  hermesApiMode,
  hermesProviderKey,
};
