// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/// <reference path="./js-yaml.d.ts" />

import fs from "node:fs";
import { TextDecoder } from "node:util";

import yaml from "js-yaml";
import type { HarnessSecondaryForwardAllocationDeclaration } from "@nvidia/nemoclaw-harness-contract";
import { isCanonicalSandboxPath } from "@nvidia/nemoclaw-harness-contract/manifest-validator";

import { isPlainObject } from "../shared/object-record.ts";
import { isSafeModelId } from "../validation.ts";
import type {
  AgentDashboard,
  AgentDashboardKind,
  AgentHealthProbe,
  AgentInference,
  AgentMcpCapability,
  AgentMcpSupport,
  AgentStateFile,
  AgentVersionScheme,
  ManifestRecord,
  ManifestValue,
  StringMap,
} from "./manifest-types";
import { isAgentMcpAdapter } from "./manifest-types.ts";
import {
  HARNESS_MANIFEST_MAX_BYTES,
  parseValidatedHarnessManifestDocument,
} from "./manifest-document.ts";
import { isSnapshotControlPath } from "../state/snapshot/content-digest.ts";
import { readStateFileRestore } from "./state/file-restore.ts";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function isManifestValue(value: unknown): value is ManifestValue {
  if (value === null || value instanceof Date) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((entry) => isManifestValue(entry));
  }
  return isManifestRecord(value);
}

function isManifestRecord(value: unknown): value is ManifestRecord {
  if (!isPlainObject(value)) return false;
  return Object.values(value).every((entry) => isManifestValue(entry));
}

export function readString(record: ManifestRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function readBoolean(record: ManifestRecord, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

export function readVersionScheme(record: ManifestRecord): AgentVersionScheme | undefined {
  const value = record.version_scheme;
  if (value === "semver" || value === "calendar") return value;
  return undefined;
}

export function readObject(record: ManifestRecord, key: string): ManifestRecord | undefined {
  const value = record[key];
  return isManifestRecord(value) ? value : undefined;
}

export function readStringArray(record: ManifestRecord, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const STATE_FILE_FIELDS = new Set(["path", "strategy", "backup", "restore"]);
const STATE_FILE_BACKUP_FIELDS = new Set(["fallback"]);
const MCP_POLICY_BINARY_PATH_RE = /^\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+\*?$/u;

function assertStateFilePath(value: string, field: string): void {
  if (value.length === 0) {
    throw new Error(`Agent manifest field '${field}' must not be empty`);
  }
  if (CONTROL_CHAR_RE.test(value)) {
    throw new Error(`Agent manifest field '${field}' must not contain control characters`);
  }
  if (value.startsWith("/")) {
    throw new Error(`Agent manifest field '${field}' must be a relative path, not absolute`);
  }
  if (value.includes("\\")) {
    throw new Error(`Agent manifest field '${field}' must use canonical forward slashes`);
  }
  if (value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(
      `Agent manifest field '${field}' must be a canonical relative path without empty, '.', or '..' components`,
    );
  }
  if (isSnapshotControlPath(value)) {
    throw new Error(`Agent manifest field '${field}' uses a path reserved for snapshot metadata`);
  }
}

export function readUserManagedFiles(record: ManifestRecord): string[] | undefined {
  const value = record.user_managed_files;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("Agent manifest field 'user_managed_files' must be an array");
  }

  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(
        `Agent manifest field 'user_managed_files[${String(index)}]' must be a string`,
      );
    }
    if (entry.length === 0) {
      throw new Error(
        `Agent manifest field 'user_managed_files[${String(index)}]' must not be empty`,
      );
    }
    if (CONTROL_CHAR_RE.test(entry)) {
      throw new Error(
        `Agent manifest field 'user_managed_files[${String(index)}]' must not contain control characters`,
      );
    }
    if (entry.startsWith("/")) {
      throw new Error(
        `Agent manifest field 'user_managed_files[${String(index)}]' must be a relative path, not absolute`,
      );
    }
    const segments = entry.split("/");
    if (segments.some((segment) => segment === "..")) {
      throw new Error(
        `Agent manifest field 'user_managed_files[${String(index)}]' must not contain '..' path components`,
      );
    }
    return entry;
  });
}

export function readStateFiles(record: ManifestRecord): AgentStateFile[] | undefined {
  const value = record.state_files;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("Agent manifest field 'state_files' must be an array");
  }

  return value.map((entry, index) => {
    const field = `state_files[${String(index)}]`;
    if (typeof entry === "string") {
      assertStateFilePath(entry, field);
      return { path: entry, strategy: "copy" };
    }
    if (!isManifestRecord(entry)) {
      throw new Error(`Agent manifest field '${field}' must be a string or object`);
    }
    for (const key of Object.keys(entry)) {
      if (!STATE_FILE_FIELDS.has(key)) {
        throw new Error(`Agent manifest field '${field}.${key}' is not allowed`);
      }
    }
    const statePath = readString(entry, "path");
    if (!statePath) {
      throw new Error(`Agent manifest field '${field}.path' is required`);
    }
    assertStateFilePath(statePath, `${field}.path`);
    if (entry.strategy !== undefined && typeof entry.strategy !== "string") {
      throw new Error(`Agent manifest field '${field}.strategy' must be copy or sqlite_backup`);
    }
    const rawStrategy = readString(entry, "strategy") ?? "copy";
    if (rawStrategy !== "copy" && rawStrategy !== "sqlite_backup") {
      throw new Error(`Agent manifest field '${field}.strategy' must be copy or sqlite_backup`);
    }
    const backup = readStateFileBackup(entry, index, rawStrategy);
    const restore = readStateFileRestore(entry, index, rawStrategy);
    return {
      path: statePath,
      strategy: rawStrategy,
      ...(backup ? { backup } : {}),
      ...(restore ? { restore } : {}),
    };
  });
}

function readStateFileBackup(
  entry: ManifestRecord,
  index: number,
  strategy: AgentStateFile["strategy"],
): AgentStateFile["backup"] {
  const value = entry.backup;
  if (value === undefined) return undefined;
  const field = `state_files[${String(index)}].backup`;
  if (!isManifestRecord(value)) {
    throw new Error(`Agent manifest field '${field}' must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!STATE_FILE_BACKUP_FIELDS.has(key)) {
      throw new Error(`Agent manifest field '${field}.${key}' is not allowed`);
    }
  }
  if (strategy !== "copy") {
    throw new Error(`Agent manifest field '${field}' requires strategy 'copy'`);
  }
  if (value.fallback !== "privileged-copy") {
    throw new Error(`Agent manifest field '${field}.fallback' must be privileged-copy`);
  }
  return { fallback: "privileged-copy" };
}

function isValidPort(value: unknown, min = 1): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= 65535;
}

export function readPortArray(record: ManifestRecord, key: string): number[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Agent manifest field '${key}' must be an array of TCP ports`);
  }

  const ports = value.map((entry, index) => {
    if (!isValidPort(entry, 1024)) {
      throw new Error(
        `Agent manifest field '${key}[${String(index)}]' must be an integer TCP port between 1024 and 65535`,
      );
    }
    return entry;
  });

  return ports.length > 0 ? ports : undefined;
}

export function readStringMap(record: ManifestRecord, key: string): StringMap | undefined {
  const value = readObject(record, key);
  if (!value) return undefined;

  const result: StringMap = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue === "string") {
      result[entryKey] = entryValue;
    }
  }
  return result;
}

function readSecondaryForwardAllocation(
  healthProbe: ManifestRecord,
): HarnessSecondaryForwardAllocationDeclaration | undefined {
  const value = readObject(healthProbe, "secondary_forward");
  if (!value) return undefined;
  const environmentVariable = value.environment_variable;
  const preferredPort = value.preferred_port;
  const rangeStart = value.range_start;
  const rangeEnd = value.range_end;
  const label = value.label;
  const remedy = value.remedy;
  if (
    typeof environmentVariable !== "string" ||
    typeof label !== "string" ||
    typeof remedy !== "string" ||
    !isValidPort(preferredPort, 1024) ||
    !isValidPort(rangeStart, 1024) ||
    !isValidPort(rangeEnd, 1024)
  ) {
    throw new Error("Agent manifest field 'health_probe.secondary_forward' is invalid");
  }
  return {
    environment_variable: environmentVariable,
    preferred_port: preferredPort,
    range_start: rangeStart,
    range_end: rangeEnd,
    label,
    remedy,
  };
}

export function readHealthProbe(record: ManifestRecord): AgentHealthProbe | undefined {
  const healthProbe = readObject(record, "health_probe");
  if (!healthProbe) return undefined;

  const url = readString(healthProbe, "url");
  const port = healthProbe.port;
  const timeoutSeconds = healthProbe.timeout_seconds;
  const successStatuses = healthProbe.success_statuses;
  const portResolution = healthProbe.port_resolution;
  const secondaryForward = readSecondaryForwardAllocation(healthProbe);

  if (port !== undefined && !isValidPort(port)) {
    throw new Error(
      "Agent manifest field 'health_probe.port' must be an integer TCP port between 1 and 65535",
    );
  }
  if (portResolution !== undefined && portResolution !== "sandbox-secondary-forward") {
    throw new Error(
      "Agent manifest field 'health_probe.port_resolution' must be sandbox-secondary-forward",
    );
  }
  if (portResolution === "sandbox-secondary-forward" && !secondaryForward) {
    throw new Error(
      "Agent manifest field 'health_probe.secondary_forward' is required for sandbox-secondary-forward",
    );
  }
  if (portResolution === undefined && secondaryForward !== undefined) {
    throw new Error(
      "Agent manifest field 'health_probe.secondary_forward' requires sandbox-secondary-forward",
    );
  }
  if (
    successStatuses !== undefined &&
    (!Array.isArray(successStatuses) ||
      successStatuses.length === 0 ||
      successStatuses.length > 16 ||
      successStatuses.some(
        (status) =>
          !Number.isInteger(status) || (status as number) < 100 || (status as number) > 599,
      ) ||
      new Set(successStatuses).size !== successStatuses.length)
  ) {
    throw new Error("Agent manifest field 'health_probe.success_statuses' is invalid");
  }

  if (
    typeof url === "string" &&
    isValidPort(port) &&
    typeof timeoutSeconds === "number" &&
    Number.isFinite(timeoutSeconds)
  ) {
    return {
      url,
      port,
      timeout_seconds: timeoutSeconds,
      success_statuses: (successStatuses as readonly number[] | undefined) ?? [200],
      ...(portResolution ? { port_resolution: portResolution } : {}),
      ...(secondaryForward
        ? {
            secondary_forward: secondaryForward,
          }
        : {}),
    };
  }

  return undefined;
}

export function readDashboard(record: ManifestRecord): AgentDashboard {
  const dashboard = readObject(record, "dashboard") ?? {};
  const rawKind = dashboard.kind;
  if (rawKind !== undefined && rawKind !== "ui" && rawKind !== "api") {
    throw new Error("Agent manifest field 'dashboard.kind' must be ui or api");
  }
  const kind: AgentDashboardKind = rawKind === "api" ? "api" : "ui";
  const defaultLabel = kind === "api" ? "API" : "UI";
  const normalizedLabel = typeof dashboard.label === "string" ? dashboard.label.trim() : "";

  const normalizePath = (key: "path" | "health_path", fallback: string): string => {
    const value = dashboard[key];
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !value.startsWith("/")) {
      throw new Error(`Agent manifest field 'dashboard.${key}' must be an absolute path`);
    }
    return value.trim() || fallback;
  };

  const rawAuth = dashboard.auth;
  if (
    rawAuth !== undefined &&
    rawAuth !== "url_token" &&
    rawAuth !== "session" &&
    rawAuth !== "none"
  ) {
    throw new Error("Agent manifest field 'dashboard.auth' must be url_token, session, or none");
  }

  const auth = rawAuth ?? (kind === "api" ? "none" : "url_token");
  const rawTokenPath = dashboard.token_path;
  if (rawTokenPath !== undefined && typeof rawTokenPath !== "string") {
    throw new Error("Agent manifest field 'dashboard.token_path' must be a dotted config path");
  }
  const tokenPath =
    auth === "url_token"
      ? String(rawTokenPath ?? "gateway.auth.token")
          .split(".")
          .map((segment) => segment.trim())
      : null;
  if (
    tokenPath !== null &&
    (tokenPath.length === 0 ||
      tokenPath.length > 16 ||
      tokenPath.some((segment) => !/^[A-Za-z0-9_-]+$/u.test(segment)))
  ) {
    throw new Error(
      "Agent manifest field 'dashboard.token_path' must be a safe dotted config path",
    );
  }

  const rawTunnelAllowedOriginsPath = dashboard.tunnel_allowed_origins_path;
  if (
    rawTunnelAllowedOriginsPath !== undefined &&
    typeof rawTunnelAllowedOriginsPath !== "string"
  ) {
    throw new Error(
      "Agent manifest field 'dashboard.tunnel_allowed_origins_path' must be a dotted config path",
    );
  }
  const tunnelAllowedOriginsPath =
    typeof rawTunnelAllowedOriginsPath === "string"
      ? rawTunnelAllowedOriginsPath.split(".").map((segment) => segment.trim())
      : null;
  if (
    tunnelAllowedOriginsPath !== null &&
    (tunnelAllowedOriginsPath.length === 0 ||
      tunnelAllowedOriginsPath.length > 16 ||
      tunnelAllowedOriginsPath.some((segment) => !/^[A-Za-z0-9_-]+$/u.test(segment)))
  ) {
    throw new Error(
      "Agent manifest field 'dashboard.tunnel_allowed_origins_path' must be a safe dotted config path",
    );
  }

  return {
    kind,
    label: normalizedLabel || defaultLabel,
    path: normalizePath("path", "/"),
    healthPath: normalizePath("health_path", "/health"),
    auth,
    tokenPath,
    tunnelAllowedOriginsPath,
  };
}

export function readInference(record: ManifestRecord): AgentInference | undefined {
  const inference = readObject(record, "inference");
  if (!inference) return undefined;

  const providerType = inference.provider_type;
  if (providerType !== undefined && typeof providerType !== "string") {
    throw new Error("Agent manifest field 'inference.provider_type' must be a string");
  }

  const providerOptions = inference.provider_options;
  let providerOptionList: string[] | undefined;
  if (providerOptions !== undefined) {
    if (
      !Array.isArray(providerOptions) ||
      providerOptions.some((entry) => typeof entry !== "string")
    ) {
      throw new Error(
        "Agent manifest field 'inference.provider_options' must be an array of strings",
      );
    }
    providerOptionList = providerOptions as string[];
  }

  const defaultModel = inference.default_model;
  if (
    defaultModel !== undefined &&
    (typeof defaultModel !== "string" || !isSafeModelId(defaultModel.trim()))
  ) {
    throw new Error("Agent manifest field 'inference.default_model' must be a safe model ID");
  }

  const providerKeyCredentialAlias = inference.provider_key_credential_alias;
  if (
    providerKeyCredentialAlias !== undefined &&
    providerKeyCredentialAlias !== "hosted-inference"
  ) {
    throw new Error(
      "Agent manifest field 'inference.provider_key_credential_alias' must be hosted-inference",
    );
  }

  const rawContextWindowRequirements = inference.context_window_requirements;
  let contextWindowRequirements: AgentInference["contextWindowRequirements"];
  if (rawContextWindowRequirements !== undefined) {
    if (
      !Array.isArray(rawContextWindowRequirements) ||
      rawContextWindowRequirements.length < 1 ||
      rawContextWindowRequirements.length > 8
    ) {
      throw new Error(
        "Agent manifest field 'inference.context_window_requirements' must contain 1 through 8 entries",
      );
    }
    const seenProviders = new Set<string>();
    contextWindowRequirements = Object.freeze(
      rawContextWindowRequirements.map((value, index) => {
        const field = `inference.context_window_requirements[${String(index)}]`;
        if (!isManifestRecord(value)) {
          throw new Error(`Agent manifest field '${field}' must be an object`);
        }
        if (
          Object.keys(value).length !== 2 ||
          !Object.hasOwn(value, "provider") ||
          !Object.hasOwn(value, "minimum_tokens") ||
          value.provider !== "ollama-local" ||
          seenProviders.has(value.provider) ||
          !Number.isInteger(value.minimum_tokens) ||
          (value.minimum_tokens as number) < 16_384 ||
          (value.minimum_tokens as number) > 4_194_304
        ) {
          throw new Error(`Agent manifest field '${field}' is invalid`);
        }
        seenProviders.add(value.provider);
        return Object.freeze({
          provider: "ollama-local" as const,
          minimumTokens: value.minimum_tokens as number,
        });
      }),
    );
  }

  const refreshRouteProviders = inference.refresh_route_for_messaging_providers;
  if (
    refreshRouteProviders !== undefined &&
    (!Array.isArray(refreshRouteProviders) ||
      refreshRouteProviders.length === 0 ||
      refreshRouteProviders.length > 32 ||
      new Set(refreshRouteProviders).size !== refreshRouteProviders.length ||
      refreshRouteProviders.some(
        (provider) =>
          typeof provider !== "string" ||
          provider.length > 256 ||
          !/^[A-Za-z0-9._-]+$/u.test(provider),
      ))
  ) {
    throw new Error(
      "Agent manifest field 'inference.refresh_route_for_messaging_providers' must contain unique canonical provider identifiers",
    );
  }
  const sandboxSmoke = inference.sandbox_smoke;
  let parsedSandboxSmoke: AgentInference["sandbox_smoke"];
  if (sandboxSmoke !== undefined) {
    if (sandboxSmoke === null || typeof sandboxSmoke !== "object" || Array.isArray(sandboxSmoke)) {
      throw new Error("Agent manifest field 'inference.sandbox_smoke' must be an object");
    }
    const smoke = sandboxSmoke as ManifestRecord;
    const fields = Object.keys(smoke);
    if (
      fields.length !== 2 ||
      !Object.hasOwn(smoke, "kind") ||
      !Object.hasOwn(smoke, "config_path") ||
      smoke.kind !== "compatible-endpoint" ||
      typeof smoke.config_path !== "string" ||
      !isCanonicalSandboxPath(smoke.config_path)
    ) {
      throw new Error(
        "Agent manifest field 'inference.sandbox_smoke' must declare compatible-endpoint and a config path below /sandbox",
      );
    }
    parsedSandboxSmoke = Object.freeze({
      kind: "compatible-endpoint",
      config_path: smoke.config_path as `/sandbox/${string}`,
    });
  }

  const routeProbe = inference.route_probe;
  let parsedRouteProbe: AgentInference["route_probe"];
  if (routeProbe !== undefined) {
    if (routeProbe === null || typeof routeProbe !== "object" || Array.isArray(routeProbe)) {
      throw new Error("Agent manifest field 'inference.route_probe' must be an object");
    }
    const probe = routeProbe as ManifestRecord;
    if (
      Object.keys(probe).some((key) => key !== "terminal_connect" && key !== "models_404") ||
      (probe.terminal_connect !== undefined && probe.terminal_connect !== "required") ||
      (probe.models_404 !== undefined && probe.models_404 !== "inference-invocation")
    ) {
      throw new Error(
        "Agent manifest field 'inference.route_probe' must use the supported core-owned probe modes",
      );
    }
    parsedRouteProbe = Object.freeze({
      ...(probe.terminal_connect ? { terminal_connect: "required" as const } : {}),
      ...(probe.models_404 ? { models_404: "inference-invocation" as const } : {}),
    });
  }

  const configUpdate = readObject(inference, "config_update");
  const rawProviderApiOverrides = configUpdate?.provider_api_overrides;
  let providerApiOverrides: AgentInference["providerApiOverrides"];
  if (rawProviderApiOverrides !== undefined) {
    if (!Array.isArray(rawProviderApiOverrides) || rawProviderApiOverrides.length > 32) {
      throw new Error(
        "Agent manifest field 'inference.config_update.provider_api_overrides' must be an array with at most 32 entries",
      );
    }
    const seenProviders = new Set<string>();
    providerApiOverrides = Object.freeze(
      rawProviderApiOverrides.map((entry, index) => {
        const field = `inference.config_update.provider_api_overrides[${String(index)}]`;
        if (!isManifestRecord(entry)) {
          throw new Error(`Agent manifest field '${field}' must be an object`);
        }
        const provider = readString(entry, "provider");
        const api = readString(entry, "api");
        if (
          !provider ||
          !/^[A-Za-z0-9._-]+$/u.test(provider) ||
          seenProviders.has(provider) ||
          (api !== "openai-completions" &&
            api !== "anthropic-messages" &&
            api !== "openai-responses")
        ) {
          throw new Error(`Agent manifest field '${field}' is invalid`);
        }
        seenProviders.add(provider);
        return Object.freeze({ provider, api });
      }),
    );
  }

  return {
    provider_type: providerType,
    provider_options: providerOptionList,
    default_model: typeof defaultModel === "string" ? defaultModel.trim() : undefined,
    ...(providerKeyCredentialAlias
      ? { provider_key_credential_alias: providerKeyCredentialAlias }
      : {}),
    ...(contextWindowRequirements ? { contextWindowRequirements } : {}),
    ...(refreshRouteProviders
      ? {
          refresh_route_for_messaging_providers: Object.freeze([
            ...(refreshRouteProviders as string[]),
          ]),
        }
      : {}),
    ...(parsedSandboxSmoke ? { sandbox_smoke: parsedSandboxSmoke } : {}),
    ...(parsedRouteProbe ? { route_probe: parsedRouteProbe } : {}),
    ...(providerApiOverrides ? { providerApiOverrides } : {}),
  };
}

export function readMcpCapability(record: ManifestRecord): AgentMcpCapability {
  const mcp = readObject(record, "mcp");
  if (!mcp) {
    return { support: "disabled", reason: "MCP support is not declared for this agent." };
  }

  const support = readString(mcp, "support");
  if (support !== "bridge" && support !== "disabled") {
    throw new Error("Agent manifest field 'mcp.support' must be bridge or disabled");
  }

  const adapter = readString(mcp, "adapter");
  if (adapter !== undefined && !isAgentMcpAdapter(adapter)) {
    throw new Error("Agent manifest field 'mcp.adapter' must be a canonical lowercase identifier");
  }
  if (support === "bridge" && !adapter) {
    throw new Error("Agent manifest field 'mcp.adapter' is required when mcp.support is bridge");
  }
  if (support === "disabled" && adapter) {
    throw new Error("Agent manifest field 'mcp.adapter' is only valid when mcp.support is bridge");
  }

  const policyBinaries = readMcpPolicyBinaryPaths(mcp, support);
  const policyPresets = readStringArray(mcp, "policy_presets")?.map((entry) => entry.trim());
  if (
    policyPresets &&
    (support !== "bridge" ||
      policyPresets.length > 64 ||
      new Set(policyPresets).size !== policyPresets.length ||
      policyPresets.some((entry) => !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(entry)))
  ) {
    throw new Error(
      "Agent manifest field 'mcp.policy_presets' must contain unique canonical policy preset names for bridge support",
    );
  }
  const reason = readString(mcp, "reason")?.trim();
  if (support === "bridge") {
    return {
      support,
      adapter: adapter!,
      policy_binaries: policyBinaries!,
      ...(policyPresets ? { policy_presets: Object.freeze(policyPresets) } : {}),
      ...(reason ? { reason } : {}),
    };
  }
  return { support, ...(reason ? { reason } : {}) };
}

function readMcpPolicyBinaryPaths(
  mcp: ManifestRecord,
  support: AgentMcpSupport,
): string[] | undefined {
  const rawPolicyBinaries = mcp.policy_binaries;
  if (support === "bridge" && rawPolicyBinaries === undefined) {
    throw new Error(
      "Agent manifest field 'mcp.policy_binaries' is required when mcp.support is bridge",
    );
  }
  if (support === "disabled" && rawPolicyBinaries !== undefined) {
    throw new Error(
      "Agent manifest field 'mcp.policy_binaries' is only valid when mcp.support is bridge",
    );
  }

  let policyBinaries: string[] | undefined;
  if (rawPolicyBinaries !== undefined) {
    if (!Array.isArray(rawPolicyBinaries) || rawPolicyBinaries.length === 0) {
      throw new Error("Agent manifest field 'mcp.policy_binaries' must be a non-empty array");
    }

    const seenPaths = new Set<string>();
    policyBinaries = rawPolicyBinaries.map((entry, index) => {
      const field = `mcp.policy_binaries[${String(index)}]`;
      if (typeof entry !== "string") {
        throw new Error(`Agent manifest field '${field}' must be a string`);
      }
      const segments = entry.slice(1).split("/");
      if (
        !entry.startsWith("/") ||
        CONTROL_CHAR_RE.test(entry) ||
        entry.includes("\\") ||
        segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
        !MCP_POLICY_BINARY_PATH_RE.test(entry)
      ) {
        throw new Error(
          `Agent manifest field '${field}' must be a canonical absolute binary path with only an optional trailing '*' wildcard`,
        );
      }
      if (seenPaths.has(entry)) {
        throw new Error(`Agent manifest field '${field}' duplicates '${entry}'`);
      }
      seenPaths.add(entry);
      return entry;
    });
  }
  return policyBinaries;
}

export function parseManifestRecord(source: string, label: string): ManifestRecord {
  const parsed = yaml.load(source);
  if (!isManifestRecord(parsed)) {
    throw new Error(`Agent manifest must be a YAML object: ${label}`);
  }
  return parsed;
}

/** Load a repository-owned legacy manifest whose schema predates the public harness contract. */
export function loadLegacyRepositoryManifest(manifestPath: string): ManifestRecord {
  return parseManifestRecord(fs.readFileSync(manifestPath, "utf8"), manifestPath);
}

/** Load one source package manifest through the same semantic contract used by installed receipts. */
export function loadValidatedHarnessManifest(
  manifestPath: string,
  expectedHarnessId?: string,
): ManifestRecord {
  const bytes = fs.readFileSync(manifestPath);
  if (bytes.byteLength > HARNESS_MANIFEST_MAX_BYTES) {
    throw new Error("Harness agent manifest exceeds its byte boundary");
  }
  let source: string;
  try {
    source = UTF8_DECODER.decode(bytes);
  } catch {
    throw new Error("Harness agent manifest must contain valid UTF-8");
  }
  return parseValidatedHarnessManifestDocument(source, expectedHarnessId);
}
