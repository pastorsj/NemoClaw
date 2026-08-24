// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { join } from "node:path";

import YAML from "yaml";

import * as importedOpenShellPolicyBoundary from "#nemoclaw-shared/openshell-policy-boundary.cjs";
import { isPlainObject, type UnknownRecord } from "../shared/object-record.js";
import { isRuntimeIdentityConfig, type RuntimeIdentityConfig } from "./runtime-identity.js";

// The compiled plugin exposes named CommonJS exports. Source-mode tsx maps the
// .cjs specifier back to .cts and exposes that same module as its default.
const sourceOrGeneratedOpenShellPolicyBoundary =
  importedOpenShellPolicyBoundary as typeof importedOpenShellPolicyBoundary & {
    default?: typeof importedOpenShellPolicyBoundary;
  };
const { parseOpenShellPolicy, withoutProviderComposedPolicies } =
  sourceOrGeneratedOpenShellPolicyBoundary.default ?? sourceOrGeneratedOpenShellPolicyBoundary;

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
type RestProtocol = "rest";
type EndpointEnforcement = "enforce" | "audit";
type EndpointTls = "terminate" | "passthrough" | "skip";

interface PolicyRule {
  allow: {
    method: HttpMethod;
    path: string;
  };
}

interface PolicyEndpoint {
  host: string;
  port: number;
  protocol?: RestProtocol;
  enforcement?: EndpointEnforcement;
  tls?: EndpointTls;
  access?: "full";
  rules?: PolicyRule[];
}

interface PolicyAddition {
  name: string;
  endpoints: PolicyEndpoint[];
}

export type PolicyAdditions = { [name: string]: PolicyAddition };

export type InferenceProfileMap = { [profileName: string]: InferenceProfile };

export interface Blueprint {
  version?: string;
  components?: {
    inference?: {
      profiles?: InferenceProfileMap;
    };
    sandbox?: SandboxConfig;
    router?: RouterConfig;
    policy?: {
      additions?: PolicyAdditions;
    };
    identity?: RuntimeIdentityConfig;
  };
}

export interface InferenceProfile {
  provider_type?: string;
  provider_name?: string;
  endpoint?: string;
  model?: string;
  credential_env?: string;
  credential_default?: string;
  timeout_secs?: number;
}

export interface SandboxConfig {
  image?: string;
  name?: string;
  forward_ports?: number[];
}

export interface RouterConfig {
  enabled?: boolean;
  port?: number;
  pool_config_path?: string;
}

export const DEFAULT_ROUTER_PORT = 4000;

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const REST_PROTOCOLS = new Set(["rest"]);
const ENDPOINT_ENFORCEMENT_MODES = new Set(["enforce", "audit"]);
const ENDPOINT_TLS_MODES = new Set(["terminate", "passthrough", "skip"]);

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

export function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function isOptionalPortList(value: unknown): value is number[] | undefined {
  return (
    value === undefined || (Array.isArray(value) && value.every((entry) => isValidPort(entry)))
  );
}

function hasOnlyKeys(value: UnknownRecord, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isPolicyRule(value: unknown): value is PolicyRule {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["allow"])) {
    return false;
  }
  const allow = value.allow;
  if (!isPlainObject(allow) || !hasOnlyKeys(allow, ["method", "path"])) {
    return false;
  }
  return (
    typeof allow.method === "string" &&
    HTTP_METHODS.has(allow.method) &&
    typeof allow.path === "string" &&
    allow.path.startsWith("/")
  );
}

function isPolicyEndpoint(value: unknown): value is PolicyEndpoint {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ["host", "port", "protocol", "enforcement", "tls", "access", "rules"])
  ) {
    return false;
  }

  const protocol = value.protocol;
  const enforcement = value.enforcement;
  const tls = value.tls;
  const access = value.access;
  const rules = value.rules;

  return (
    typeof value.host === "string" &&
    isValidPort(value.port) &&
    (protocol === undefined || (typeof protocol === "string" && REST_PROTOCOLS.has(protocol))) &&
    (enforcement === undefined ||
      (typeof enforcement === "string" && ENDPOINT_ENFORCEMENT_MODES.has(enforcement))) &&
    (tls === undefined || (typeof tls === "string" && ENDPOINT_TLS_MODES.has(tls))) &&
    (access === undefined || access === "full") &&
    (rules === undefined ||
      (Array.isArray(rules) && rules.length > 0 && rules.every((entry) => isPolicyRule(entry)))) &&
    (protocol !== "rest" || rules !== undefined)
  );
}

function isPolicyAddition(value: unknown): value is PolicyAddition {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["name", "endpoints"])) {
    return false;
  }
  return (
    typeof value.name === "string" &&
    Array.isArray(value.endpoints) &&
    value.endpoints.length > 0 &&
    value.endpoints.every((entry) => isPolicyEndpoint(entry))
  );
}

export function isPolicyAdditions(value: unknown): value is PolicyAdditions {
  return isPlainObject(value) && Object.values(value).every((entry) => isPolicyAddition(entry));
}

function isInferenceProfile(value: unknown): value is InferenceProfile {
  if (!isPlainObject(value)) {
    return false;
  }

  return (
    isOptionalString(value.provider_type) &&
    isOptionalString(value.provider_name) &&
    isOptionalString(value.endpoint) &&
    isOptionalString(value.model) &&
    isOptionalString(value.credential_env) &&
    isOptionalString(value.credential_default) &&
    isOptionalFiniteNumber(value.timeout_secs)
  );
}

function isBlueprint(value: unknown): value is Blueprint {
  if (!isPlainObject(value)) {
    return false;
  }

  if (!isOptionalString(value.version)) {
    return false;
  }

  const components = value.components;
  if (components === undefined) {
    return true;
  }
  if (!isPlainObject(components)) {
    return false;
  }

  const inference = components.inference;
  if (inference !== undefined) {
    if (!isPlainObject(inference)) {
      return false;
    }
    const profiles = inference.profiles;
    if (profiles !== undefined) {
      if (
        !isPlainObject(profiles) ||
        !Object.values(profiles).every((entry) => isInferenceProfile(entry))
      ) {
        return false;
      }
    }
  }

  const sandbox = components.sandbox;
  if (sandbox !== undefined) {
    if (!isPlainObject(sandbox)) {
      return false;
    }
    if (
      !isOptionalString(sandbox.image) ||
      !isOptionalString(sandbox.name) ||
      !isOptionalPortList(sandbox.forward_ports)
    ) {
      return false;
    }
  }

  const router = components.router;
  if (router !== undefined) {
    if (!isPlainObject(router)) {
      return false;
    }
    if (
      !isOptionalBoolean(router.enabled) ||
      !(router.port === undefined || isValidPort(router.port)) ||
      !isOptionalString(router.pool_config_path)
    ) {
      return false;
    }
  }

  const policy = components.policy;
  if (policy !== undefined) {
    if (!isPlainObject(policy)) {
      return false;
    }
    const additions = policy.additions;
    if (additions !== undefined && !isPolicyAdditions(additions)) {
      return false;
    }
  }

  const identity = components.identity;
  return identity === undefined || isRuntimeIdentityConfig(identity);
}

export function mergePolicyAdditions(currentPolicyRaw: string, additions: PolicyAdditions): string {
  // sourceOfTruth: src/lib/shared/openshell-policy-boundary.cts
  const current = parseOpenShellPolicy(currentPolicyRaw).policy;
  const existingNetworkPolicies = current.network_policies ?? {};
  const output: UnknownRecord = {};

  // OpenShell 0.0.72 and later expose composable top-level policy sections as
  // mappings. Preserve unknown mapping sections for forward compatibility, but
  // fail closed on a scalar or sequence until its mutation semantics are
  // reviewed for the next supported OpenShell contract.
  for (const [key, value] of Object.entries(current)) {
    if (key !== "version" && key !== "network_policies") {
      if (!isPlainObject(value)) {
        throw new Error(`Current policy top-level field "${key}" must be a YAML mapping`);
      }
      output[key] = value;
    }
  }

  output.version = current.version ?? 1;
  output.network_policies = withoutProviderComposedPolicies({
    ...existingNetworkPolicies,
    ...additions,
  });
  return YAML.stringify(output);
}

export function loadBlueprint(): Blueprint {
  const blueprintPath = process.env.NEMOCLAW_BLUEPRINT_PATH ?? ".";
  const blueprintFile = join(blueprintPath, "blueprint.yaml");
  let content: string;
  try {
    content = readFileSync(blueprintFile, "utf-8");
  } catch {
    throw new Error(`blueprint.yaml not found at ${blueprintFile}`);
  }
  const parsed: unknown = YAML.parse(content);
  if (!isBlueprint(parsed)) {
    throw new Error(
      `blueprint.yaml at ${blueprintFile} must contain a YAML mapping with valid nested component shapes`,
    );
  }
  return parsed;
}
