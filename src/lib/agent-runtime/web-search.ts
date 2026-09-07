// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessWebSearchCapability,
  HarnessWebSearchConfigAssertion,
  HarnessWebSearchProviderBinding,
  HarnessWebSearchProvider,
  HarnessWebSearchRequestParameter,
} from "@nvidia/nemoclaw-harness-contract";
import { isCanonicalSandboxPath } from "@nvidia/nemoclaw-harness-contract/manifest-validator";

import { isObjectRecord } from "../core/json-types";
import type { ManifestRecord } from "./manifest-types";

const WEB_SEARCH_PROVIDERS = new Set<HarnessWebSearchProvider>(["brave", "tavily"]);
const TOOL_GATEWAY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const PROFILE_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const PATH_SEGMENT_PATTERN = /^[^\u0000\r\n]{1,128}$/u;

function readObjectPath(value: unknown, field: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 8 ||
    value.some((segment) => typeof segment !== "string" || !PATH_SEGMENT_PATTERN.test(segment))
  ) {
    throw new Error(`Agent manifest field '${field}' is invalid`);
  }
  return Object.freeze([...(value as string[])]);
}

function readConfigAssertions(
  value: unknown,
  field: string,
): readonly HarnessWebSearchConfigAssertion[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new Error(`Agent manifest field '${field}' is invalid`);
  }
  return Object.freeze(
    value.map((entry, index) => {
      const entryField = `${field}[${String(index)}]`;
      if (
        !isObjectRecord(entry) ||
        (typeof entry.equals !== "string" && typeof entry.equals !== "boolean") ||
        (typeof entry.equals === "string" &&
          (entry.equals.length > 256 || /[\u0000\r\n]/u.test(entry.equals)))
      ) {
        throw new Error(`Agent manifest field '${entryField}' is invalid`);
      }
      return Object.freeze({
        path: readObjectPath(entry.path, `${entryField}.path`),
        equals: entry.equals,
      });
    }),
  );
}

function readRequestParameters(
  value: unknown,
  field: string,
): readonly HarnessWebSearchRequestParameter[] {
  if (!Array.isArray(value) || value.length > 16) {
    throw new Error(`Agent manifest field '${field}' is invalid`);
  }
  const names = new Set<string>();
  return Object.freeze(
    value.map((entry, index) => {
      const entryField = `${field}[${String(index)}]`;
      if (
        !isObjectRecord(entry) ||
        typeof entry.name !== "string" ||
        !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(entry.name) ||
        names.has(entry.name) ||
        (typeof entry.value !== "string" && typeof entry.value !== "number") ||
        (typeof entry.value === "string" &&
          (entry.value.length > 256 || /[\u0000\r\n]/u.test(entry.value))) ||
        (typeof entry.value === "number" && !Number.isFinite(entry.value))
      ) {
        throw new Error(`Agent manifest field '${entryField}' is invalid`);
      }
      names.add(entry.name);
      return Object.freeze({ name: entry.name, value: entry.value });
    }),
  );
}

function readProviderBinding(value: unknown, field: string): HarnessWebSearchProviderBinding {
  if (!isObjectRecord(value)) {
    throw new Error(`Agent manifest field '${field}' is invalid`);
  }
  const provider = value.provider as HarnessWebSearchProvider;
  const credentialEnv = value.credential_env;
  if (
    !WEB_SEARCH_PROVIDERS.has(provider) ||
    typeof credentialEnv !== "string" ||
    credentialEnv !== (provider === "brave" ? "BRAVE_API_KEY" : "TAVILY_API_KEY") ||
    typeof value.profile_type !== "string" ||
    value.profile_type.length > 64 ||
    !PROFILE_TYPE_PATTERN.test(value.profile_type) ||
    !isObjectRecord(value.config_verification) ||
    !isObjectRecord(value.egress_verification)
  ) {
    throw new Error(`Agent manifest field '${field}' is invalid`);
  }
  const config = value.config_verification;
  if (
    typeof config.path !== "string" ||
    !isCanonicalSandboxPath(config.path) ||
    (config.format !== "json" && config.format !== "yaml") ||
    !Array.isArray(config.credential_paths) ||
    config.credential_paths.length > 8
  ) {
    throw new Error(`Agent manifest field '${field}.config_verification' is invalid`);
  }
  const egress = value.egress_verification;
  if (
    (egress.method !== "GET" && egress.method !== "POST") ||
    typeof egress.url !== "string" ||
    !egress.url.startsWith("https://") ||
    !isObjectRecord(egress.credential)
  ) {
    throw new Error(`Agent manifest field '${field}.egress_verification' is invalid`);
  }
  const credential = egress.credential;
  const placement =
    credential.kind === "header" &&
    typeof credential.name === "string" &&
    /^[A-Za-z][A-Za-z0-9-]{0,63}$/u.test(credential.name) &&
    (credential.prefix === "none" || credential.prefix === "bearer")
      ? Object.freeze({
          kind: "header" as const,
          name: credential.name,
          prefix: credential.prefix,
        })
      : credential.kind === "json-body" &&
          egress.method === "POST" &&
          typeof credential.name === "string" &&
          /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(credential.name)
        ? Object.freeze({ kind: "json-body" as const, name: credential.name })
        : null;
  if (!placement) {
    throw new Error(`Agent manifest field '${field}.egress_verification.credential' is invalid`);
  }
  return Object.freeze({
    provider,
    credential_env: credentialEnv,
    profile_type: value.profile_type,
    config_verification: Object.freeze({
      path: config.path as `/sandbox/${string}`,
      format: config.format,
      assertions: readConfigAssertions(
        config.assertions,
        `${field}.config_verification.assertions`,
      ),
      credential_paths: Object.freeze(
        config.credential_paths.map((entry, index) =>
          readObjectPath(entry, `${field}.config_verification.credential_paths[${String(index)}]`),
        ),
      ),
    }),
    egress_verification: Object.freeze({
      method: egress.method,
      url: egress.url as `https://${string}`,
      parameters: readRequestParameters(
        egress.parameters,
        `${field}.egress_verification.parameters`,
      ),
      credential: placement,
      result_array_path: readObjectPath(
        egress.result_array_path,
        `${field}.egress_verification.result_array_path`,
      ),
    }),
  });
}

/** Read one package's bounded web-search capability. */
export function readWebSearchCapability(
  manifest: ManifestRecord,
): HarnessWebSearchCapability | undefined {
  const value = manifest.web_search;
  if (value === undefined) return undefined;
  if (!isObjectRecord(value)) {
    throw new Error("Agent manifest field 'web_search' must be an object");
  }
  if (value.support === "disabled") {
    if (typeof value.reason !== "string" || !value.reason.trim()) {
      throw new Error("Agent manifest field 'web_search.reason' must be non-empty text");
    }
    return Object.freeze({ support: "disabled", reason: value.reason });
  }
  if (value.support !== "providers") {
    throw new Error("Agent manifest field 'web_search.support' must be providers or disabled");
  }
  if (
    !Array.isArray(value.providers) ||
    value.providers.length === 0 ||
    value.providers.length > WEB_SEARCH_PROVIDERS.size
  ) {
    throw new Error("Agent manifest field 'web_search.providers' must contain provider bindings");
  }
  const providers = Object.freeze(
    value.providers.map((provider, index) =>
      readProviderBinding(provider, `web_search.providers[${String(index)}]`),
    ),
  );
  if (new Set(providers.map((provider) => provider.provider)).size !== providers.length) {
    throw new Error("Agent manifest field 'web_search.providers' must contain unique providers");
  }
  const rawConflicts = value.tool_gateway_conflicts;
  if (
    rawConflicts !== undefined &&
    (!Array.isArray(rawConflicts) || rawConflicts.length === 0 || rawConflicts.length > 16)
  ) {
    throw new Error(
      "Agent manifest field 'web_search.tool_gateway_conflicts' must contain 1 through 16 conflicts",
    );
  }
  const seen = new Set<string>();
  const toolGatewayConflicts = Object.freeze(
    (rawConflicts ?? []).map((entry, index) => {
      const field = `web_search.tool_gateway_conflicts[${String(index)}]`;
      if (
        !isObjectRecord(entry) ||
        !WEB_SEARCH_PROVIDERS.has(entry.provider as HarnessWebSearchProvider) ||
        !providers.some((provider) => provider.provider === entry.provider) ||
        typeof entry.tool_gateway !== "string" ||
        !TOOL_GATEWAY_PATTERN.test(entry.tool_gateway)
      ) {
        throw new Error(`Agent manifest field '${field}' is invalid`);
      }
      const key = `${String(entry.provider)}\0${entry.tool_gateway}`;
      if (seen.has(key)) throw new Error(`Agent manifest field '${field}' is duplicated`);
      seen.add(key);
      return Object.freeze({
        provider: entry.provider as HarnessWebSearchProvider,
        tool_gateway: entry.tool_gateway,
      });
    }),
  );
  return Object.freeze({
    support: "providers",
    providers,
    ...(toolGatewayConflicts.length > 0 ? { tool_gateway_conflicts: toolGatewayConflicts } : {}),
  });
}

/** Return whether a receipt-backed package declares one web-search provider. */
export function packageSupportsWebSearchProvider(
  agent: { web_search?: HarnessWebSearchCapability } | null | undefined,
  provider: HarnessWebSearchProvider,
): boolean {
  return (
    agent?.web_search?.support === "providers" &&
    agent.web_search.providers.some((binding) => binding.provider === provider)
  );
}

/** Read the selected package's complete binding for one core-supported provider. */
export function packageWebSearchProviderBinding(
  agent: { web_search?: HarnessWebSearchCapability } | null | undefined,
  provider: HarnessWebSearchProvider,
): HarnessWebSearchProviderBinding | null {
  if (agent?.web_search?.support !== "providers") return null;
  return agent.web_search.providers.find((binding) => binding.provider === provider) ?? null;
}

/** Remove tool gateways that the selected package declares incompatible with web search. */
export function filterPackageWebSearchToolGateways(
  agent: { web_search?: HarnessWebSearchCapability } | null | undefined,
  provider: HarnessWebSearchProvider | null,
  gateways: readonly string[],
): string[] {
  if (!provider || agent?.web_search?.support !== "providers") return [...gateways];
  const conflicts = new Set(
    (agent.web_search.tool_gateway_conflicts ?? [])
      .filter((conflict) => conflict.provider === provider)
      .map((conflict) => conflict.tool_gateway),
  );
  return gateways.filter((gateway) => !conflicts.has(gateway));
}
