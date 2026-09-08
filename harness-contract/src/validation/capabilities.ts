// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CONTROL_CHARACTER_PATTERN,
  DISPLAY_CONTROL_PATTERN,
  fail,
  isCanonicalAbsolutePath,
  isCanonicalRelativePath,
  isCanonicalSandboxPath,
  type ManifestRecord,
  requireCanonicalId,
  requireExactFields,
  requireKnownFields,
  requireRecord,
  requireString,
  SAFE_PATH_SEGMENT_PATTERN,
  utf8ByteLength,
} from "./shared.js";

function validateMcp(manifest: ManifestRecord): void {
  if (manifest.mcp === undefined) return;
  const mcp = requireRecord(manifest.mcp, "mcp");
  if (mcp.support !== "bridge" && mcp.support !== "disabled") {
    fail("mcp.support", "must be bridge or disabled");
  }
  if (mcp.support === "disabled") {
    requireKnownFields(mcp, new Set(["reason", "support"]), new Set(["support"]), "mcp");
    if (mcp.reason !== undefined && typeof mcp.reason !== "string") {
      fail("mcp.reason", "must be a string");
    }
    return;
  }

  requireKnownFields(
    mcp,
    new Set(["adapter", "policy_binaries", "policy_presets", "reason", "support"]),
    new Set(["adapter", "support"]),
    "mcp",
  );
  requireCanonicalId(mcp.adapter, "mcp.adapter");
  if (!Array.isArray(mcp.policy_binaries) || mcp.policy_binaries.length === 0) {
    fail("mcp.policy_binaries", "must be a non-empty array when mcp.support is bridge");
  }
  const pathPattern = /^\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+\*?$/u;
  const seen = new Set<string>();
  mcp.policy_binaries.forEach((entry, index) => {
    const field = `mcp.policy_binaries[${String(index)}]`;
    if (
      typeof entry !== "string" ||
      CONTROL_CHARACTER_PATTERN.test(entry) ||
      entry.includes("\\") ||
      !pathPattern.test(entry) ||
      seen.has(entry)
    ) {
      fail(field, "must be a unique canonical absolute binary path with only a trailing wildcard");
    }
    seen.add(entry);
  });
  if (mcp.policy_presets !== undefined) {
    if (
      !Array.isArray(mcp.policy_presets) ||
      mcp.policy_presets.length > 64 ||
      new Set(mcp.policy_presets).size !== mcp.policy_presets.length ||
      mcp.policy_presets.some(
        (entry) => typeof entry !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(entry),
      )
    ) {
      fail("mcp.policy_presets", "must contain unique canonical policy preset names");
    }
  }
  if (mcp.reason !== undefined && typeof mcp.reason !== "string") {
    fail("mcp.reason", "must be a string");
  }
}

function validateAgentRoster(manifest: ManifestRecord): void {
  if (manifest.agent_roster === undefined) return;
  const roster = requireRecord(manifest.agent_roster, "agent_roster");
  requireExactFields(
    roster,
    new Set(["adapter", "onboarding_environment", "support"]),
    "agent_roster",
  );
  if (roster.support !== "managed") {
    fail("agent_roster.support", "must be managed");
  }
  if (roster.adapter !== "agent-roster") {
    fail("agent_roster.adapter", "must be agent-roster");
  }
  if (roster.onboarding_environment !== "NEMOCLAW_EXTRA_AGENTS_JSON") {
    fail("agent_roster.onboarding_environment", "must be NEMOCLAW_EXTRA_AGENTS_JSON");
  }
}

function validatePolicy(manifest: ManifestRecord): void {
  const policy = requireRecord(manifest.policy, "policy");
  requireKnownFields(
    policy,
    new Set(["automatic_presets", "baseline_exclusion_impacts", "context_target", "owned_presets"]),
    new Set(["automatic_presets", "baseline_exclusion_impacts", "owned_presets"]),
    "policy",
  );
  if (policy.context_target !== undefined) {
    const contextTarget = requireString(policy.context_target, "policy.context_target");
    if (
      !isCanonicalAbsolutePath(contextTarget) ||
      !contextTarget.startsWith("/sandbox/") ||
      contextTarget.length > 512 ||
      contextTarget
        .split("/")
        .some((segment) => segment !== "" && !SAFE_PATH_SEGMENT_PATTERN.test(segment))
    ) {
      fail(
        "policy.context_target",
        "must be a bounded canonical /sandbox path containing only safe path segments",
      );
    }
  }
  if (
    !Array.isArray(policy.owned_presets) ||
    policy.owned_presets.length > 64 ||
    new Set(policy.owned_presets).size !== policy.owned_presets.length ||
    policy.owned_presets.some(
      (entry) => typeof entry !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(entry),
    )
  ) {
    fail("policy.owned_presets", "must contain unique canonical policy preset names");
  }
  if (!Array.isArray(policy.automatic_presets) || policy.automatic_presets.length > 16) {
    fail("policy.automatic_presets", "must be an array with at most 16 entries");
  }
  const automaticNames = new Set<string>();
  policy.automatic_presets.forEach((entry, index) => {
    const field = `policy.automatic_presets[${String(index)}]`;
    const rule = requireRecord(entry, field);
    requireExactFields(
      rule,
      new Set(["activation", "apply_during_create", "name", "suppress_in_tiers"]),
      field,
    );
    const name = requireString(rule.name, `${field}.name`);
    if (
      !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(name) ||
      automaticNames.has(name) ||
      !(policy.owned_presets as unknown[]).includes(name)
    ) {
      fail(`${field}.name`, "must uniquely reference a package-owned preset");
    }
    automaticNames.add(name);
    if (typeof rule.apply_during_create !== "boolean") {
      fail(`${field}.apply_during_create`, "must be a boolean");
    }
    if (
      !Array.isArray(rule.suppress_in_tiers) ||
      rule.suppress_in_tiers.length > 8 ||
      new Set(rule.suppress_in_tiers).size !== rule.suppress_in_tiers.length ||
      rule.suppress_in_tiers.some(
        (tier) => typeof tier !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(tier),
      )
    ) {
      fail(`${field}.suppress_in_tiers`, "must contain unique canonical policy tier names");
    }
    const activation = requireRecord(rule.activation, `${field}.activation`);
    if (activation.kind === "always" || activation.kind === "observability-enabled") {
      requireExactFields(activation, new Set(["kind"]), `${field}.activation`);
      return;
    }
    if (activation.kind !== "local-endpoint-enabled") {
      fail(
        `${field}.activation.kind`,
        "must be always, observability-enabled, or local-endpoint-enabled",
      );
    }
    requireExactFields(
      activation,
      new Set([
        "default_endpoint",
        "enabled_environment",
        "endpoint_environment",
        "kind",
        "local_origin",
      ]),
      `${field}.activation`,
    );
    for (const key of ["enabled_environment", "endpoint_environment"] as const) {
      const value = requireString(activation[key], `${field}.activation.${key}`);
      if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(value)) {
        fail(`${field}.activation.${key}`, "must be a canonical environment variable name");
      }
    }
    const defaultEndpoint = requireString(
      activation.default_endpoint,
      `${field}.activation.default_endpoint`,
    );
    const localOrigin = requireString(activation.local_origin, `${field}.activation.local_origin`);
    try {
      const endpoint = new URL(defaultEndpoint);
      const origin = new URL(localOrigin);
      if (
        (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
        origin.origin !== localOrigin ||
        endpoint.origin !== localOrigin
      ) {
        throw new Error("invalid local endpoint");
      }
    } catch {
      fail(
        `${field}.activation`,
        "must declare an HTTP default endpoint whose origin exactly matches local_origin",
      );
    }
  });
  const impacts = requireRecord(
    policy.baseline_exclusion_impacts,
    "policy.baseline_exclusion_impacts",
  );
  const entries = Object.entries(impacts);
  if (entries.length > 64) {
    fail("policy.baseline_exclusion_impacts", "must contain at most 64 entries");
  }
  for (const [key, value] of entries) {
    const field = `policy.baseline_exclusion_impacts.${key}`;
    if (!/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/u.test(key)) {
      fail(field, "must use a canonical baseline policy key");
    }
    const text = requireString(value, field);
    if (
      text.trim().length === 0 ||
      text !== text.trim() ||
      DISPLAY_CONTROL_PATTERN.test(text) ||
      utf8ByteLength(text) > 512
    ) {
      fail(field, "must be trimmed single-line text of at most 512 bytes");
    }
  }
}

function validateSessions(manifest: ManifestRecord): void {
  if (manifest.sessions === undefined) return;
  const sessions = requireRecord(manifest.sessions, "sessions");
  requireExactFields(sessions, new Set(["operations"]), "sessions");
  if (!Array.isArray(sessions.operations) || sessions.operations.length > 4) {
    fail("sessions.operations", "must be an array with at most four operations");
  }
  const allowed = new Set(["list", "delete", "reset", "export"]);
  if (
    new Set(sessions.operations).size !== sessions.operations.length ||
    sessions.operations.some((entry) => !allowed.has(entry as string))
  ) {
    fail("sessions.operations", "must contain unique list, delete, reset, or export operations");
  }
}

function validateMessaging(manifest: ManifestRecord): void {
  const messaging = requireRecord(manifest.messaging, "messaging");
  if (messaging.support === "disabled") {
    requireExactFields(messaging, new Set(["support"]), "messaging");
    return;
  }
  if (messaging.support !== "channels") fail("messaging.support", "must be channels or disabled");
  requireExactFields(messaging, new Set(["support", "channels"]), "messaging");
  if (
    !Array.isArray(messaging.channels) ||
    messaging.channels.length === 0 ||
    messaging.channels.length > 32 ||
    new Set(messaging.channels).size !== messaging.channels.length
  ) {
    fail("messaging.channels", "must be a unique list containing 1 through 32 channel identifiers");
  }
  messaging.channels.forEach((entry, index) => {
    requireCanonicalId(entry, `messaging.channels[${String(index)}]`);
  });
}

function validateWebSearch(manifest: ManifestRecord): void {
  if (manifest.web_search === undefined) return;
  const webSearch = requireRecord(manifest.web_search, "web_search");
  if (webSearch.support === "disabled") {
    requireExactFields(webSearch, new Set(["reason", "support"]), "web_search");
    const reason = requireString(webSearch.reason, "web_search.reason");
    if (
      reason.trim().length === 0 ||
      DISPLAY_CONTROL_PATTERN.test(reason) ||
      utf8ByteLength(reason) > 512
    ) {
      fail("web_search.reason", "must be non-empty single-line text of at most 512 bytes");
    }
    return;
  }
  if (webSearch.support !== "providers") {
    fail("web_search.support", "must be providers or disabled");
  }
  requireKnownFields(
    webSearch,
    new Set(["providers", "support", "tool_gateway_conflicts"]),
    new Set(["providers", "support"]),
    "web_search",
  );
  if (
    !Array.isArray(webSearch.providers) ||
    webSearch.providers.length === 0 ||
    webSearch.providers.length > 2
  ) {
    fail("web_search.providers", "must contain 1 through 2 provider bindings");
  }
  const providerNames = new Set<string>();
  webSearch.providers.forEach((entry, index) => {
    const field = `web_search.providers[${String(index)}]`;
    const binding = requireRecord(entry, field);
    requireExactFields(
      binding,
      new Set([
        "config_verification",
        "credential_env",
        "egress_verification",
        "profile_type",
        "provider",
      ]),
      field,
    );
    if (binding.provider !== "brave" && binding.provider !== "tavily") {
      fail(`${field}.provider`, "must be brave or tavily");
    }
    if (providerNames.has(binding.provider)) {
      fail(`${field}.provider`, "must be unique within web_search.providers");
    }
    providerNames.add(binding.provider);
    const credentialEnv = requireString(binding.credential_env, `${field}.credential_env`);
    const expectedCredentialEnv = binding.provider === "brave" ? "BRAVE_API_KEY" : "TAVILY_API_KEY";
    if (credentialEnv !== expectedCredentialEnv) {
      fail(
        `${field}.credential_env`,
        `must be ${expectedCredentialEnv} for the selected core credential`,
      );
    }
    const profileType = requireCanonicalId(binding.profile_type, `${field}.profile_type`);
    if (profileType.length > 64) {
      fail(`${field}.profile_type`, "must contain at most 64 characters");
    }
    validateWebSearchConfigVerification(
      binding.config_verification,
      `${field}.config_verification`,
    );
    validateWebSearchEgressVerification(
      binding.egress_verification,
      `${field}.egress_verification`,
    );
  });
  if (webSearch.tool_gateway_conflicts === undefined) return;
  if (
    !Array.isArray(webSearch.tool_gateway_conflicts) ||
    webSearch.tool_gateway_conflicts.length === 0 ||
    webSearch.tool_gateway_conflicts.length > 16
  ) {
    fail("web_search.tool_gateway_conflicts", "must contain 1 through 16 conflicts");
  }
  const seen = new Set<string>();
  webSearch.tool_gateway_conflicts.forEach((entry, index) => {
    const field = `web_search.tool_gateway_conflicts[${String(index)}]`;
    const conflict = requireRecord(entry, field);
    requireExactFields(conflict, new Set(["provider", "tool_gateway"]), field);
    if (conflict.provider !== "brave" && conflict.provider !== "tavily") {
      fail(`${field}.provider`, "must be brave or tavily");
    }
    requireCanonicalId(conflict.tool_gateway, `${field}.tool_gateway`);
    const key = `${String(conflict.provider)}\0${String(conflict.tool_gateway)}`;
    if (seen.has(key)) fail(field, "must not duplicate another conflict");
    if (!providerNames.has(String(conflict.provider))) {
      fail(`${field}.provider`, "must also appear in web_search.providers");
    }
    seen.add(key);
  });
}

function validateWebSearchPath(value: unknown, field: string): void {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 8 ||
    value.some(
      (segment) =>
        typeof segment !== "string" ||
        segment.length === 0 ||
        segment.length > 128 ||
        CONTROL_CHARACTER_PATTERN.test(segment),
    )
  ) {
    fail(field, "must contain 1 through 8 bounded object-path segments");
  }
}

function validateWebSearchConfigVerification(value: unknown, field: string): void {
  const config = requireRecord(value, field);
  requireExactFields(config, new Set(["assertions", "credential_paths", "format", "path"]), field);
  const configPath = requireString(config.path, `${field}.path`);
  if (!isCanonicalSandboxPath(configPath)) {
    fail(`${field}.path`, "must be a canonical absolute path below /sandbox");
  }
  if (config.format !== "json" && config.format !== "yaml") {
    fail(`${field}.format`, "must be json or yaml");
  }
  if (
    !Array.isArray(config.assertions) ||
    config.assertions.length === 0 ||
    config.assertions.length > 16
  ) {
    fail(`${field}.assertions`, "must contain 1 through 16 assertions");
  }
  config.assertions.forEach((entry, index) => {
    const assertionField = `${field}.assertions[${String(index)}]`;
    const assertion = requireRecord(entry, assertionField);
    requireExactFields(assertion, new Set(["equals", "path"]), assertionField);
    validateWebSearchPath(assertion.path, `${assertionField}.path`);
    if (typeof assertion.equals !== "string" && typeof assertion.equals !== "boolean") {
      fail(`${assertionField}.equals`, "must be a string or boolean");
    }
    if (
      typeof assertion.equals === "string" &&
      (assertion.equals.length > 256 || CONTROL_CHARACTER_PATTERN.test(assertion.equals))
    ) {
      fail(`${assertionField}.equals`, "must be bounded text without control characters");
    }
  });
  if (!Array.isArray(config.credential_paths) || config.credential_paths.length > 8) {
    fail(`${field}.credential_paths`, "must be an array with at most 8 object paths");
  }
  config.credential_paths.forEach((entry, index) => {
    validateWebSearchPath(entry, `${field}.credential_paths[${String(index)}]`);
  });
}

function validateWebSearchEgressVerification(value: unknown, field: string): void {
  const egress = requireRecord(value, field);
  requireExactFields(
    egress,
    new Set(["credential", "method", "parameters", "result_array_path", "url"]),
    field,
  );
  if (egress.method !== "GET" && egress.method !== "POST") {
    fail(`${field}.method`, "must be GET or POST");
  }
  const url = requireString(egress.url, `${field}.url`);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    fail(`${field}.url`, "must be a valid HTTPS URL");
  }
  if (
    url.length > 2048 ||
    parsedUrl.protocol !== "https:" ||
    parsedUrl.username !== "" ||
    parsedUrl.password !== "" ||
    parsedUrl.search !== "" ||
    parsedUrl.hash !== "" ||
    parsedUrl.port !== "" ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(parsedUrl.hostname)
  ) {
    fail(
      `${field}.url`,
      "must be a bounded public HTTPS URL without credentials, port, query, or fragment",
    );
  }
  if (!Array.isArray(egress.parameters) || egress.parameters.length > 16) {
    fail(`${field}.parameters`, "must contain at most 16 request parameters");
  }
  const parameterNames = new Set<string>();
  egress.parameters.forEach((entry, index) => {
    const parameterField = `${field}.parameters[${String(index)}]`;
    const parameter = requireRecord(entry, parameterField);
    requireExactFields(parameter, new Set(["name", "value"]), parameterField);
    const name = requireString(parameter.name, `${parameterField}.name`);
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(name) || parameterNames.has(name)) {
      fail(`${parameterField}.name`, "must be a unique bounded parameter name");
    }
    parameterNames.add(name);
    if (
      (typeof parameter.value !== "string" && typeof parameter.value !== "number") ||
      (typeof parameter.value === "string" &&
        (parameter.value.length > 256 || CONTROL_CHARACTER_PATTERN.test(parameter.value))) ||
      (typeof parameter.value === "number" && !Number.isFinite(parameter.value))
    ) {
      fail(`${parameterField}.value`, "must be a bounded string or finite number");
    }
  });
  const credential = requireRecord(egress.credential, `${field}.credential`);
  if (credential.kind === "header") {
    requireExactFields(credential, new Set(["kind", "name", "prefix"]), `${field}.credential`);
    const name = requireString(credential.name, `${field}.credential.name`);
    if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/u.test(name)) {
      fail(`${field}.credential.name`, "must be a bounded HTTP header name");
    }
    if (credential.prefix !== "none" && credential.prefix !== "bearer") {
      fail(`${field}.credential.prefix`, "must be none or bearer");
    }
  } else if (credential.kind === "json-body") {
    requireExactFields(credential, new Set(["kind", "name"]), `${field}.credential`);
    const name = requireString(credential.name, `${field}.credential.name`);
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(name)) {
      fail(`${field}.credential.name`, "must be a bounded JSON field name");
    }
    if (egress.method !== "POST") {
      fail(`${field}.credential.kind`, "json-body credentials require POST");
    }
  } else {
    fail(`${field}.credential.kind`, "must be header or json-body");
  }
  validateWebSearchPath(egress.result_array_path, `${field}.result_array_path`);
}

function validateProviderBroker(manifest: ManifestRecord): void {
  if (manifest.provider_broker === undefined) return;
  const broker = requireRecord(manifest.provider_broker, "provider_broker");
  if (broker.support === "disabled") {
    requireExactFields(broker, new Set(["reason", "support"]), "provider_broker");
    const reason = requireString(broker.reason, "provider_broker.reason");
    if (
      reason.trim().length === 0 ||
      DISPLAY_CONTROL_PATTERN.test(reason) ||
      utf8ByteLength(reason) > 512
    ) {
      fail("provider_broker.reason", "must be non-empty single-line text of at most 512 bytes");
    }
    return;
  }
  if (broker.support !== "managed") {
    fail("provider_broker.support", "must be managed or disabled");
  }
  requireExactFields(broker, new Set(["adapter", "operations", "support"]), "provider_broker");
  if (broker.adapter !== "provider-broker") {
    fail("provider_broker.adapter", "must be provider-broker");
  }
  const expected = [
    "describe-provider",
    "register-refresh-provider",
    "ensure-broker",
    "inspect-broker",
    "teardown-broker",
  ];
  const operations = broker.operations;
  if (
    !Array.isArray(operations) ||
    operations.length !== expected.length ||
    new Set(operations).size !== operations.length ||
    expected.some((operation) => !operations.includes(operation))
  ) {
    fail("provider_broker.operations", "must contain the five provider-broker operations");
  }
}

function validateToolGateways(manifest: ManifestRecord): void {
  if (manifest.tool_gateways === undefined) return;
  const capability = requireRecord(manifest.tool_gateways, "tool_gateways");
  if (capability.support === "disabled") {
    requireExactFields(capability, new Set(["reason", "support"]), "tool_gateways");
    const reason = requireString(capability.reason, "tool_gateways.reason");
    if (
      reason.trim() !== reason ||
      reason.length === 0 ||
      DISPLAY_CONTROL_PATTERN.test(reason) ||
      utf8ByteLength(reason) > 512
    ) {
      fail("tool_gateways.reason", "must be trimmed single-line text of at most 512 bytes");
    }
    return;
  }
  if (capability.support !== "managed") {
    fail("tool_gateways.support", "must be managed or disabled");
  }
  requireExactFields(
    capability,
    new Set([
      "gateways",
      "incompatible_auth_message",
      "request_environment",
      "selection_label",
      "selection_prompt",
      "support",
    ]),
    "tool_gateways",
  );
  for (const key of ["selection_label", "selection_prompt", "incompatible_auth_message"] as const) {
    const text = requireString(capability[key], `tool_gateways.${key}`);
    if (
      text.trim() !== text ||
      text.length === 0 ||
      DISPLAY_CONTROL_PATTERN.test(text) ||
      utf8ByteLength(text) > 512
    ) {
      fail(`tool_gateways.${key}`, "must be trimmed single-line text of at most 512 bytes");
    }
  }
  if (
    !Array.isArray(capability.request_environment) ||
    capability.request_environment.length === 0 ||
    capability.request_environment.length > 8 ||
    new Set(capability.request_environment).size !== capability.request_environment.length ||
    capability.request_environment.some(
      (value) => typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(value),
    )
  ) {
    fail(
      "tool_gateways.request_environment",
      "must contain 1 through 8 unique canonical environment names",
    );
  }
  if (
    !Array.isArray(capability.gateways) ||
    capability.gateways.length === 0 ||
    capability.gateways.length > 32
  ) {
    fail("tool_gateways.gateways", "must contain 1 through 32 gateway declarations");
  }

  const providerAuth = requireRecord(manifest.provider_auth, "provider_auth");
  if (providerAuth.support !== "managed") {
    fail("tool_gateways", "requires provider_auth.support: managed");
  }
  const providerBroker = requireRecord(manifest.provider_broker, "provider_broker");
  if (providerBroker.support !== "managed") {
    fail("tool_gateways", "requires provider_broker.support: managed");
  }
  const authMethodIds = new Set(
    Array.isArray(providerAuth.methods)
      ? providerAuth.methods.flatMap((entry) => {
          if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
          const id = (entry as ManifestRecord).id;
          return typeof id === "string" ? [id] : [];
        })
      : [],
  );
  const policy = requireRecord(manifest.policy, "policy");
  const ownedPresets = new Set(Array.isArray(policy.owned_presets) ? policy.owned_presets : []);
  const gatewayIds = new Set<string>();
  const selectionNames = new Set<string>();
  capability.gateways.forEach((value, index) => {
    const field = `tool_gateways.gateways[${String(index)}]`;
    const gateway = requireRecord(value, field);
    requireExactFields(
      gateway,
      new Set([
        "aliases",
        "authentication_methods",
        "default_selected",
        "description",
        "id",
        "label",
        "policy_presets",
      ]),
      field,
    );
    const id = requireCanonicalId(gateway.id, `${field}.id`);
    if (gatewayIds.has(id) || selectionNames.has(id)) {
      fail(`${field}.id`, "must be unique across gateway ids and aliases");
    }
    gatewayIds.add(id);
    selectionNames.add(id);
    for (const key of ["label", "description"] as const) {
      const text = requireString(gateway[key], `${field}.${key}`);
      if (
        text.trim() !== text ||
        text.length === 0 ||
        DISPLAY_CONTROL_PATTERN.test(text) ||
        utf8ByteLength(text) > 512
      ) {
        fail(`${field}.${key}`, "must be trimmed single-line text of at most 512 bytes");
      }
    }
    if (typeof gateway.default_selected !== "boolean") {
      fail(`${field}.default_selected`, "must be a boolean");
    }
    if (
      !Array.isArray(gateway.aliases) ||
      gateway.aliases.length > 16 ||
      new Set(gateway.aliases).size !== gateway.aliases.length ||
      gateway.aliases.some(
        (alias) => typeof alias !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(alias),
      )
    ) {
      fail(`${field}.aliases`, "must contain at most 16 unique canonical aliases");
    }
    for (const alias of gateway.aliases as string[]) {
      if (selectionNames.has(alias))
        fail(`${field}.aliases`, "must be unique across gateway ids and aliases");
      selectionNames.add(alias);
    }
    if (
      !Array.isArray(gateway.authentication_methods) ||
      gateway.authentication_methods.length === 0 ||
      gateway.authentication_methods.length > 8 ||
      new Set(gateway.authentication_methods).size !== gateway.authentication_methods.length ||
      gateway.authentication_methods.some(
        (method) => typeof method !== "string" || !authMethodIds.has(method),
      )
    ) {
      fail(
        `${field}.authentication_methods`,
        "must reference 1 through 8 unique provider authentication methods",
      );
    }
    if (
      !Array.isArray(gateway.policy_presets) ||
      gateway.policy_presets.length === 0 ||
      gateway.policy_presets.length > 8 ||
      new Set(gateway.policy_presets).size !== gateway.policy_presets.length ||
      gateway.policy_presets.some(
        (preset) => typeof preset !== "string" || !ownedPresets.has(preset),
      )
    ) {
      fail(
        `${field}.policy_presets`,
        "must reference 1 through 8 unique package-owned policy presets",
      );
    }
  });
}

function hasCanonicalSegments(value: string): boolean {
  return value
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        SAFE_PATH_SEGMENT_PATTERN.test(segment),
    );
}

function validateSandboxPath(value: unknown, field: string): void {
  if (
    typeof value !== "string" ||
    utf8ByteLength(value) > 1024 ||
    !value.startsWith("/sandbox/") ||
    !isCanonicalRelativePath(value.slice("/sandbox/".length)) ||
    !hasCanonicalSegments(value.slice("/sandbox/".length))
  ) {
    fail(field, "must be a canonical path below /sandbox");
  }
}

const SKILL_NAME_TOKEN = "{name}";
const SKILL_SOURCE_TOKEN = "{source}";

function validateSkillCommand(
  value: unknown,
  field: string,
  requiredToken: typeof SKILL_NAME_TOKEN | typeof SKILL_SOURCE_TOKEN | null,
): void {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 32 ||
    value.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.length === 0 ||
        utf8ByteLength(argument) > 4096 ||
        CONTROL_CHARACTER_PATTERN.test(argument),
    )
  ) {
    fail(field, "must be an argv array of 1 through 32 bounded strings");
  }
  for (const token of [SKILL_NAME_TOKEN, SKILL_SOURCE_TOKEN]) {
    const count = value.filter((argument) => argument === token).length;
    if (count !== Number(requiredToken === token)) {
      fail(field, `must contain ${requiredToken === token ? "exactly one" : "no"} ${token} token`);
    }
  }
}

function validateSkills(manifest: ManifestRecord): void {
  if (manifest.skills === undefined) return;
  const skills = requireRecord(manifest.skills, "skills");
  if (skills.support === "disabled") {
    requireExactFields(skills, new Set(["support", "reason"]), "skills");
    const reason = requireString(skills.reason, "skills.reason");
    if (
      reason.trim().length === 0 ||
      DISPLAY_CONTROL_PATTERN.test(reason) ||
      utf8ByteLength(reason) > 512
    ) {
      fail("skills.reason", "must be a non-empty single-line string of at most 512 bytes");
    }
    return;
  }
  if (skills.support !== "managed") fail("skills.support", "must be managed or disabled");
  requireKnownFields(
    skills,
    new Set([
      "activation",
      "add_command",
      "collision",
      "install_root",
      "list_command",
      "mirror_root",
      "removal",
      "remove_command",
      "support",
    ]),
    new Set(["activation", "collision", "install_root", "list_command", "removal", "support"]),
    "skills",
  );
  validateSandboxPath(skills.install_root, "skills.install_root");
  validateSkillCommand(skills.list_command, "skills.list_command", null);
  if (skills.add_command !== undefined) {
    validateSkillCommand(skills.add_command, "skills.add_command", SKILL_SOURCE_TOKEN);
  }
  if (skills.remove_command !== undefined) {
    validateSkillCommand(skills.remove_command, "skills.remove_command", SKILL_NAME_TOKEN);
  }
  if (skills.collision !== "replace" && skills.collision !== "refuse") {
    fail("skills.collision", "must be replace or refuse");
  }
  if (skills.removal !== "remove" && skills.removal !== "refuse") {
    fail("skills.removal", "must be remove or refuse");
  }
  if (skills.mirror_root !== undefined) {
    const mirror = requireString(skills.mirror_root, "skills.mirror_root");
    const relative = mirror.startsWith("$HOME/") ? mirror.slice("$HOME/".length) : "";
    if (
      utf8ByteLength(mirror) > 1024 ||
      !isCanonicalRelativePath(relative) ||
      !hasCanonicalSegments(relative)
    ) {
      fail("skills.mirror_root", "must be a canonical path below $HOME");
    }
    if (skills.collision !== "replace") fail("skills.mirror_root", "requires collision: replace");
  }
  if (
    skills.collision === "refuse" &&
    skills.removal !== "refuse" &&
    skills.remove_command === undefined
  ) {
    fail(
      "skills.removal",
      "must be refuse when collision is refuse without a native remove command",
    );
  }
  if (skills.remove_command !== undefined && skills.removal !== "remove") {
    fail("skills.remove_command", "requires removal: remove");
  }

  const activation = requireRecord(skills.activation, "skills.activation");
  if (activation.kind === "reset-session-index") {
    requireExactFields(activation, new Set(["kind", "path"]), "skills.activation");
    validateSandboxPath(activation.path, "skills.activation.path");
    return;
  }
  requireExactFields(activation, new Set(["kind"]), "skills.activation");
  if (activation.kind !== "new-session" && activation.kind !== "gateway-restart-required") {
    fail(
      "skills.activation.kind",
      "must be new-session, gateway-restart-required, or reset-session-index",
    );
  }
}

/** Validate independently consumable MCP, session, messaging, and skill declarations. */
export function validateHarnessCapabilities(manifest: ManifestRecord): void {
  validateAgentRoster(manifest);
  validatePolicy(manifest);
  validateMcp(manifest);
  validateSessions(manifest);
  validateMessaging(manifest);
  validateWebSearch(manifest);
  validateSkills(manifest);
  validateProviderBroker(manifest);
  validateToolGateways(manifest);
}
