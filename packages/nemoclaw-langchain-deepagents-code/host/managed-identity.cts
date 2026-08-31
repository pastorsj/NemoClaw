// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const OPENROUTER_ENDPOINT_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_PROVIDER_NAME = "openrouter-api";

function normalizeManagedDcodeEndpointUrl(value, name) {
  if (value === undefined || value === null || value.trim() === "") return null;
  if (/[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new Error(`${name} must not contain control characters.`);
  }
  const text = value.trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use HTTP or HTTPS.`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} must not include credentials.`);
  }
  if (url.search || url.hash) {
    throw new Error(`${name} must not include query strings or fragments.`);
  }
  return url.href;
}

function normalizeManagedDcodeModelName(model) {
  const trimmed = model.trim();
  for (const prefix of ["openai:", "openrouter:"]) {
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
  }
  return trimmed;
}

function isOpenRouterEndpointUrl(value) {
  try {
    const normalized = normalizeManagedDcodeEndpointUrl(value, "endpoint URL");
    if (!normalized) return false;
    const url = new URL(normalized);
    const openRouterUrl = new URL(OPENROUTER_ENDPOINT_URL);
    return (
      url.origin === openRouterUrl.origin &&
      url.pathname.replace(/\/+$/, "") === openRouterUrl.pathname.replace(/\/+$/, "")
    );
  } catch {
    return false;
  }
}

function resolveManagedDcodeIdentity(upstreamProvider, model, upstreamEndpointUrl) {
  const providerName = upstreamProvider?.trim();
  const provider =
    providerName === "openrouter" ||
    providerName === OPENROUTER_PROVIDER_NAME ||
    (providerName === "compatible-endpoint" && isOpenRouterEndpointUrl(upstreamEndpointUrl))
      ? "openrouter"
      : "openai";
  const normalizedModel = normalizeManagedDcodeModelName(model);
  return {
    provider,
    model: normalizedModel,
    defaultModel: `${provider}:${normalizedModel}`,
  };
}

module.exports = {
  normalizeManagedDcodeEndpointUrl,
  normalizeManagedDcodeModelName,
  resolveManagedDcodeIdentity,
};
