// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CONTROL_CHARACTER_PATTERN,
  DISPLAY_CONTROL_PATTERN,
  fail,
  type ManifestRecord,
  requireCanonicalId,
  requireExactFields,
  requireRecord,
  requireString,
  utf8ByteLength,
} from "./shared.js";

const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{0,127}$/u;

function boundedLabel(value: unknown, field: string): string {
  const label = requireString(value, field);
  if (
    label.trim() !== label ||
    label.length === 0 ||
    DISPLAY_CONTROL_PATTERN.test(label) ||
    utf8ByteLength(label) > 512
  ) {
    fail(field, "must be trimmed single-line text of at most 512 bytes");
  }
  return label;
}

function environmentName(value: unknown, field: string): string {
  const name = requireString(value, field);
  if (!ENVIRONMENT_NAME.test(name)) fail(field, "must be a canonical environment variable name");
  return name;
}

function publicHttpsUrl(value: unknown, field: string): string {
  const url = requireString(value, field);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail(field, "must be a valid public HTTPS URL");
  }
  if (
    utf8ByteLength(url) > 2048 ||
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.port !== "" ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(parsed.hostname)
  ) {
    fail(field, "must be a bounded public HTTPS URL without credentials, port, query, or fragment");
  }
  return url;
}

function validateSelection(value: unknown): void {
  const selection = requireRecord(value, "provider_auth.selection");
  requireExactFields(
    selection,
    new Set([
      "aliases",
      "default_model",
      "endpoint_url",
      "help_url",
      "key",
      "label",
      "models",
      "preferred_inference_api",
      "provider_name",
      "provider_type",
    ]),
    "provider_auth.selection",
  );
  const selectionKey = requireString(selection.key, "provider_auth.selection.key");
  if (!/^[a-z][A-Za-z0-9-]{0,63}$/u.test(selectionKey)) {
    fail("provider_auth.selection.key", "must be a bounded provider selection key");
  }
  requireCanonicalId(selection.provider_name, "provider_auth.selection.provider_name");
  boundedLabel(selection.label, "provider_auth.selection.label");
  if (selection.provider_type !== "openai") {
    fail("provider_auth.selection.provider_type", "must be openai");
  }
  if (selection.preferred_inference_api !== "openai-completions") {
    fail("provider_auth.selection.preferred_inference_api", "must be openai-completions");
  }
  publicHttpsUrl(selection.endpoint_url, "provider_auth.selection.endpoint_url");
  publicHttpsUrl(selection.help_url, "provider_auth.selection.help_url");
  const aliases = selection.aliases;
  if (
    !Array.isArray(aliases) ||
    aliases.length > 16 ||
    new Set(aliases).size !== aliases.length ||
    aliases.some((alias) => typeof alias !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(alias))
  ) {
    fail("provider_auth.selection.aliases", "must contain unique canonical provider aliases");
  }
  const models = selection.models;
  if (
    !Array.isArray(models) ||
    models.length === 0 ||
    models.length > 128 ||
    new Set(models).size !== models.length ||
    models.some(
      (model) =>
        typeof model !== "string" ||
        model.length === 0 ||
        model.length > 512 ||
        CONTROL_CHARACTER_PATTERN.test(model) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/u.test(model),
    )
  ) {
    fail("provider_auth.selection.models", "must contain 1 through 128 unique safe model ids");
  }
  const defaultModel = requireString(
    selection.default_model,
    "provider_auth.selection.default_model",
  );
  if (!models.includes(defaultModel)) {
    fail("provider_auth.selection.default_model", "must appear in provider_auth.selection.models");
  }
}

function validateMethods(providerAuth: ManifestRecord): void {
  if (
    !Array.isArray(providerAuth.methods) ||
    providerAuth.methods.length === 0 ||
    providerAuth.methods.length > 8
  ) {
    fail("provider_auth.methods", "must contain 1 through 8 authentication methods");
  }
  const methodIds = new Set<string>();
  providerAuth.methods.forEach((value, index) => {
    const field = `provider_auth.methods[${String(index)}]`;
    const method = requireRecord(value, field);
    const id = requireCanonicalId(method.id, `${field}.id`);
    if (methodIds.has(id)) fail(`${field}.id`, "must be unique");
    methodIds.add(id);
    boundedLabel(method.label, `${field}.label`);
    environmentName(method.credential_env, `${field}.credential_env`);
    if (method.kind === "api-key") {
      requireExactFields(
        method,
        new Set(["credential_env", "id", "kind", "label", "prompt_label", "source_env"]),
        field,
      );
      environmentName(method.source_env, `${field}.source_env`);
      boundedLabel(method.prompt_label, `${field}.prompt_label`);
      return;
    }
    if (method.kind !== "oauth-device-code") {
      fail(`${field}.kind`, "must be api-key or oauth-device-code");
    }
    requireExactFields(
      method,
      new Set(["credential_env", "device_code", "id", "kind", "label"]),
      field,
    );
    const deviceCode = requireRecord(method.device_code, `${field}.device_code`);
    requireExactFields(
      deviceCode,
      new Set(["client_id", "minimum_credential_ttl_seconds", "portal_base_url", "scope"]),
      `${field}.device_code`,
    );
    publicHttpsUrl(deviceCode.portal_base_url, `${field}.device_code.portal_base_url`);
    for (const key of ["client_id", "scope"] as const) {
      const text = requireString(deviceCode[key], `${field}.device_code.${key}`);
      if (text.length === 0 || text.length > 256 || CONTROL_CHARACTER_PATTERN.test(text)) {
        fail(`${field}.device_code.${key}`, "must be bounded text without control characters");
      }
    }
    if (
      !Number.isSafeInteger(deviceCode.minimum_credential_ttl_seconds) ||
      Number(deviceCode.minimum_credential_ttl_seconds) < 60 ||
      Number(deviceCode.minimum_credential_ttl_seconds) > 86_400
    ) {
      fail(
        `${field}.device_code.minimum_credential_ttl_seconds`,
        "must be an integer from 60 through 86400",
      );
    }
  });
  const defaultMethod = requireCanonicalId(
    providerAuth.default_method,
    "provider_auth.default_method",
  );
  if (!methodIds.has(defaultMethod)) {
    fail("provider_auth.default_method", "must reference a declared authentication method");
  }
}

/** Validate the finite provider/auth surface accepted from a harness package. */
export function validateProviderAuth(manifest: ManifestRecord): void {
  if (manifest.provider_auth === undefined) return;
  const providerAuth = requireRecord(manifest.provider_auth, "provider_auth");
  if (providerAuth.support === "disabled") {
    requireExactFields(providerAuth, new Set(["reason", "support"]), "provider_auth");
    boundedLabel(providerAuth.reason, "provider_auth.reason");
    return;
  }
  if (providerAuth.support !== "managed")
    fail("provider_auth.support", "must be managed or disabled");
  requireExactFields(
    providerAuth,
    new Set([
      "adapter",
      "default_method",
      "methods",
      "operation",
      "request_environment",
      "selection",
      "support",
    ]),
    "provider_auth",
  );
  if (providerAuth.adapter !== "provider-auth")
    fail("provider_auth.adapter", "must be provider-auth");
  if (providerAuth.operation !== "resolve-auth-method") {
    fail("provider_auth.operation", "must be resolve-auth-method");
  }
  if (
    !Array.isArray(providerAuth.request_environment) ||
    providerAuth.request_environment.length === 0 ||
    providerAuth.request_environment.length > 8 ||
    new Set(providerAuth.request_environment).size !== providerAuth.request_environment.length
  ) {
    fail("provider_auth.request_environment", "must contain 1 through 8 unique environment names");
  }
  providerAuth.request_environment.forEach((value, index) =>
    environmentName(value, `provider_auth.request_environment[${String(index)}]`),
  );
  validateSelection(providerAuth.selection);
  validateMethods(providerAuth);
}
