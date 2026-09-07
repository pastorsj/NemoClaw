// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  fail,
  isCanonicalAbsolutePath,
  isCanonicalRelativeFilePath,
  isCanonicalSandboxPath,
  type ManifestRecord,
  requireExactFields,
  requireKnownFields,
  requireRecord,
  requireString,
} from "./shared.js";

function requireConfigFilePath(value: unknown, field: string): string {
  const file = requireString(value, field);
  if (file.length > 4096 || !isCanonicalRelativeFilePath(file)) {
    fail(field, "must be a canonical relative file path of at most 4096 characters");
  }
  return file;
}

function validateConfigTarget(manifest: ManifestRecord): void {
  const config = requireRecord(manifest.config, "config");
  requireKnownFields(
    config,
    new Set([
      "auth_file",
      "config_file",
      "dir",
      "env_file",
      "format",
      "mutable_access",
      "shields_files",
    ]),
    new Set(["config_file", "dir", "format"]),
    "config",
  );
  const directory = requireString(config.dir, "config.dir");
  if (directory.length > 4096 || !isCanonicalSandboxPath(directory)) {
    fail(
      "config.dir",
      "must be a canonical absolute path below /sandbox of at most 4096 characters",
    );
  }
  requireConfigFilePath(config.config_file, "config.config_file");
  const format = requireString(config.format, "config.format");
  if (format.length === 0 || format.length > 64) {
    fail("config.format", "must contain between 1 and 64 characters");
  }
  for (const key of ["auth_file", "env_file"] as const) {
    if (config[key] !== undefined) requireConfigFilePath(config[key], `config.${key}`);
  }
  if (config.mutable_access !== undefined && config.mutable_access !== "private") {
    fail("config.mutable_access", "must be private");
  }
  if (
    config.shields_files !== undefined &&
    (!Array.isArray(config.shields_files) ||
      config.shields_files.length > 32 ||
      config.shields_files.some(
        (entry) => typeof entry !== "string" || !isCanonicalRelativeFilePath(entry),
      ))
  ) {
    fail("config.shields_files", "must contain at most 32 canonical relative file paths");
  }
}

function validateSandboxReconcile(value: unknown): boolean {
  const field = "inference.config_update.post_commit.sandbox_reconcile";
  const declaration = requireRecord(value, field);
  if (declaration.kind === "not-required") {
    requireExactFields(declaration, new Set(["kind"]), field);
    return false;
  }
  requireExactFields(
    declaration,
    new Set(["kind", "trigger", "command", "timeout_seconds"]),
    field,
  );
  if (declaration.kind !== "command") fail(`${field}.kind`, "must be not-required or command");
  if (
    declaration.trigger !== "after-config-sync" &&
    declaration.trigger !== "when-config-changes"
  ) {
    fail(`${field}.trigger`, "must be after-config-sync or when-config-changes");
  }
  if (
    !Array.isArray(declaration.command) ||
    declaration.command.length < 1 ||
    declaration.command.length > 32 ||
    declaration.command.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.length === 0 ||
        argument.length > 4096 ||
        /[\u0000\r\n]/u.test(argument),
    )
  ) {
    fail(`${field}.command`, "must contain 1 through 32 bounded command arguments");
  }
  if (!isCanonicalAbsolutePath(declaration.command[0] as string)) {
    fail(`${field}.command[0]`, "must be a canonical absolute path");
  }
  if (
    !Number.isInteger(declaration.timeout_seconds) ||
    (declaration.timeout_seconds as number) < 1 ||
    (declaration.timeout_seconds as number) > 120
  ) {
    fail(`${field}.timeout_seconds`, "must be an integer from 1 through 120");
  }
  return true;
}

function validateInferenceUpdate(manifest: ManifestRecord, inference: ManifestRecord): void {
  const declaration = requireRecord(inference.config_update, "inference.config_update");
  if (declaration.support === "unsupported") {
    requireExactFields(declaration, new Set(["support", "reason"]), "inference.config_update");
    const reason = requireString(declaration.reason, "inference.config_update.reason").trim();
    if (reason.length === 0 || reason.length > 8192) {
      fail("inference.config_update.reason", "must be non-empty text of at most 8192 characters");
    }
    return;
  }
  if (declaration.support !== "mutable") {
    fail("inference.config_update.support", "must be mutable or unsupported");
  }
  requireExactFields(
    declaration,
    new Set(["support", "provider_api_overrides", "post_commit"]),
    "inference.config_update",
  );
  if (
    !Array.isArray(declaration.provider_api_overrides) ||
    declaration.provider_api_overrides.length > 32
  ) {
    fail(
      "inference.config_update.provider_api_overrides",
      "must be an array with at most 32 entries",
    );
  }
  const providers = new Set<string>();
  declaration.provider_api_overrides.forEach((entry, index) => {
    const field = `inference.config_update.provider_api_overrides[${String(index)}]`;
    const override = requireRecord(entry, field);
    requireExactFields(override, new Set(["provider", "api"]), field);
    const provider = requireString(override.provider, `${field}.provider`);
    if (provider.length > 256 || !/^[A-Za-z0-9._-]+$/u.test(provider) || providers.has(provider)) {
      fail(`${field}.provider`, "must be a unique canonical provider identifier");
    }
    if (
      override.api !== "openai-completions" &&
      override.api !== "anthropic-messages" &&
      override.api !== "openai-responses"
    ) {
      fail(`${field}.api`, "must be openai-completions, anthropic-messages, or openai-responses");
    }
    providers.add(provider);
  });

  const postCommit = requireRecord(declaration.post_commit, "inference.config_update.post_commit");
  requireExactFields(
    postCommit,
    new Set(["config_sync", "gateway_restart", "sandbox_reconcile"]),
    "inference.config_update.post_commit",
  );
  if (postCommit.config_sync !== "best-effort" && postCommit.config_sync !== "required") {
    fail("inference.config_update.post_commit.config_sync", "must be best-effort or required");
  }
  if (
    postCommit.gateway_restart !== "not-required" &&
    postCommit.gateway_restart !== "when-api-changes"
  ) {
    fail(
      "inference.config_update.post_commit.gateway_restart",
      "must be not-required or when-api-changes",
    );
  }
  if (
    validateSandboxReconcile(postCommit.sandbox_reconcile) &&
    manifest.managed_image === undefined
  ) {
    fail(
      "inference.config_update.post_commit.sandbox_reconcile",
      "requires a managed_image runtime identity",
    );
  }
}

function validateContextWindowRequirements(inference: ManifestRecord): void {
  const requirements = inference.context_window_requirements;
  if (requirements === undefined) return;
  if (!Array.isArray(requirements) || requirements.length < 1 || requirements.length > 8) {
    fail(
      "inference.context_window_requirements",
      "must contain 1 through 8 local inference requirements",
    );
  }
  const providers = new Set<string>();
  requirements.forEach((value, index) => {
    const field = `inference.context_window_requirements[${String(index)}]`;
    const requirement = requireRecord(value, field);
    requireExactFields(requirement, new Set(["minimum_tokens", "provider"]), field);
    if (requirement.provider !== "ollama-local" || providers.has(requirement.provider)) {
      fail(`${field}.provider`, "must be the unique supported provider ollama-local");
    }
    if (
      !Number.isInteger(requirement.minimum_tokens) ||
      (requirement.minimum_tokens as number) < 16_384 ||
      (requirement.minimum_tokens as number) > 4_194_304
    ) {
      fail(`${field}.minimum_tokens`, "must be an integer from 16384 through 4194304");
    }
    providers.add(requirement.provider);
  });
}

/** Validate config ownership and the declared inference update behavior. */
export function validateHarnessConfig(manifest: ManifestRecord): void {
  validateConfigTarget(manifest);
  const inference = requireRecord(manifest.inference, "inference");
  requireKnownFields(
    inference,
    new Set([
      "base_url_config_key",
      "config_update",
      "context_window_requirements",
      "default_model",
      "model_config_key",
      "provider_options",
      "provider_key_credential_alias",
      "provider_type",
      "proxy_support",
      "refresh_route_for_messaging_providers",
      "route_probe",
      "sandbox_smoke",
    ]),
    new Set(["config_update"]),
    "inference",
  );
  validateInferenceUpdate(manifest, inference);
  validateContextWindowRequirements(inference);
  if (inference.provider_type !== undefined && typeof inference.provider_type !== "string") {
    fail("inference.provider_type", "must be a string");
  }
  if (
    inference.provider_options !== undefined &&
    (!Array.isArray(inference.provider_options) ||
      inference.provider_options.some((entry) => typeof entry !== "string"))
  ) {
    fail("inference.provider_options", "must be an array of strings");
  }
  if (inference.default_model !== undefined) {
    const model = requireString(inference.default_model, "inference.default_model").trim();
    if (!/^[A-Za-z0-9._:/-]+$/u.test(model)) {
      fail("inference.default_model", "must be a safe model ID");
    }
  }
  for (const key of ["base_url_config_key", "model_config_key"] as const) {
    if (inference[key] !== undefined && typeof inference[key] !== "string") {
      fail(`inference.${key}`, "must be a string");
    }
  }
  if (
    inference.proxy_support !== undefined &&
    inference.proxy_support !== "implicit" &&
    inference.proxy_support !== "explicit"
  ) {
    fail("inference.proxy_support", "must be implicit or explicit");
  }
  if (
    inference.provider_key_credential_alias !== undefined &&
    inference.provider_key_credential_alias !== "hosted-inference"
  ) {
    fail("inference.provider_key_credential_alias", "must be hosted-inference");
  }
  if (inference.refresh_route_for_messaging_providers !== undefined) {
    const providers = inference.refresh_route_for_messaging_providers;
    if (
      !Array.isArray(providers) ||
      providers.length === 0 ||
      providers.length > 32 ||
      new Set(providers).size !== providers.length ||
      providers.some(
        (provider) =>
          typeof provider !== "string" ||
          provider.length > 256 ||
          !/^[A-Za-z0-9._-]+$/u.test(provider),
      )
    ) {
      fail(
        "inference.refresh_route_for_messaging_providers",
        "must contain 1 through 32 unique canonical provider identifiers",
      );
    }
  }
  if (inference.sandbox_smoke !== undefined) {
    const smoke = requireRecord(inference.sandbox_smoke, "inference.sandbox_smoke");
    requireExactFields(smoke, new Set(["config_path", "kind"]), "inference.sandbox_smoke");
    if (smoke.kind !== "compatible-endpoint") {
      fail("inference.sandbox_smoke.kind", "must be compatible-endpoint");
    }
    if (typeof smoke.config_path !== "string" || !isCanonicalSandboxPath(smoke.config_path)) {
      fail("inference.sandbox_smoke.config_path", "must be a canonical path below /sandbox");
    }
  }
  if (inference.route_probe !== undefined) {
    const routeProbe = requireRecord(inference.route_probe, "inference.route_probe");
    requireKnownFields(
      routeProbe,
      new Set(["models_404", "rebuild_preflight", "terminal_connect"]),
      new Set(),
      "inference.route_probe",
    );
    if (Object.keys(routeProbe).length === 0) {
      fail("inference.route_probe", "must select at least one core-owned probe behavior");
    }
    if (routeProbe.terminal_connect !== undefined && routeProbe.terminal_connect !== "required") {
      fail("inference.route_probe.terminal_connect", "must be required");
    }
    if (
      routeProbe.terminal_connect === "required" &&
      requireRecord(manifest.runtime, "runtime").kind !== "terminal"
    ) {
      fail("inference.route_probe.terminal_connect", "requires runtime.kind terminal");
    }
    if (routeProbe.models_404 !== undefined && routeProbe.models_404 !== "inference-invocation") {
      fail("inference.route_probe.models_404", "must be inference-invocation");
    }
    if (
      routeProbe.rebuild_preflight !== undefined &&
      routeProbe.rebuild_preflight !== "inference-invocation"
    ) {
      fail("inference.route_probe.rebuild_preflight", "must be inference-invocation");
    }
  }
}
