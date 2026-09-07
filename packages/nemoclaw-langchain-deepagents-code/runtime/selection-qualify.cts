#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { spawnSync } = require("node:child_process") as typeof import("node:child_process");

interface ManagedDcodeIdentity {
  readonly provider: "openai" | "openrouter";
  readonly model: string;
  readonly defaultModel: string;
}

interface ManagedIdentityRuntime {
  resolveManagedDcodeIdentity(
    upstreamProvider: string,
    model: string,
    upstreamEndpointUrl: string | null,
  ): ManagedDcodeIdentity;
}

interface SelectionQualificationRequest {
  readonly schemaVersion: 1;
  readonly packageId: "langchain-deepagents-code";
  readonly selection: {
    readonly upstreamProvider: string;
    readonly model: string;
    readonly providerKey: string;
    readonly baseUrl: string;
    readonly api: "openai-completions" | "openai-responses" | "anthropic-messages";
    readonly endpointUrl: string | null;
  };
}

interface DcodeInferenceIdentity {
  readonly route: string;
  readonly provider: string;
  readonly model: string;
  readonly endpoint: string;
}

const PACKAGE_ID = "langchain-deepagents-code";
const QUALIFIED_MARKER = "__NEMOCLAW_SELECTION_QUALIFIED__=";
const NONCE_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_PAYLOAD_BYTES = 32 * 1024;
const MAX_NATIVE_OUTPUT_BYTES = 16 * 1024;
const IDENTITY_FIELDS = ["Route", "Provider", "Model", "Endpoint"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function safeText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 4096 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  );
}

function safeEndpoint(value: unknown): value is string | null {
  if (value === null) return true;
  if (!safeText(value)) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/** Decode only the finite, credential-free selection request owned by the public contract. */
function parseSelectionQualificationRequest(encoded: string): SelectionQualificationRequest | null {
  if (
    encoded.length === 0 ||
    encoded.length > MAX_PAYLOAD_BYTES * 2 ||
    !/^[A-Za-z0-9_-]+$/u.test(encoded)
  ) {
    return null;
  }
  let raw: Buffer;
  let value: unknown;
  try {
    raw = Buffer.from(encoded, "base64url");
    if (
      raw.length === 0 ||
      raw.length > MAX_PAYLOAD_BYTES ||
      raw.toString("base64url") !== encoded
    ) {
      return null;
    }
    value = JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "packageId", "selection"])) {
    return null;
  }
  const selection = value.selection;
  if (
    value.schemaVersion !== 1 ||
    value.packageId !== PACKAGE_ID ||
    !isRecord(selection) ||
    !hasExactKeys(selection, [
      "upstreamProvider",
      "model",
      "providerKey",
      "baseUrl",
      "api",
      "endpointUrl",
    ]) ||
    !safeText(selection.upstreamProvider) ||
    !safeText(selection.model) ||
    !safeText(selection.providerKey) ||
    typeof selection.baseUrl !== "string" ||
    !safeEndpoint(selection.baseUrl) ||
    (selection.api !== "openai-completions" &&
      selection.api !== "openai-responses" &&
      selection.api !== "anthropic-messages") ||
    !safeEndpoint(selection.endpointUrl)
  ) {
    return null;
  }
  return value as unknown as SelectionQualificationRequest;
}

/** Parse exactly one safe value for every package-owned identity field. */
function parseDcodeSelectionIdentity(output: string): DcodeInferenceIdentity | null {
  if (Buffer.byteLength(output, "utf8") > MAX_NATIVE_OUTPUT_BYTES) return null;
  const values = new Map<(typeof IDENTITY_FIELDS)[number], string>();
  for (const line of output.split(/\r?\n/u)) {
    const prefix = line.match(/^(Route|Provider|Model|Endpoint):/u);
    if (!prefix) continue;
    const match = line.match(/^(Route|Provider|Model|Endpoint):[ \t]+(\S(?:.*\S)?)$/u);
    if (!match) return null;
    const field = match[1] as (typeof IDENTITY_FIELDS)[number];
    const entry = match[2];
    if (values.has(field) || !safeText(entry)) return null;
    values.set(field, entry);
  }
  if (IDENTITY_FIELDS.some((field) => !values.has(field))) return null;
  return {
    route: values.get("Route")!,
    provider: values.get("Provider")!,
    model: values.get("Model")!,
    endpoint: values.get("Endpoint")!,
  };
}

/** Keep every DCode-native normalization decision inside its package. */
function selectionMatchesNativeIdentity(
  request: SelectionQualificationRequest,
  output: string,
  identityRuntime: ManagedIdentityRuntime,
): boolean {
  const actual = parseDcodeSelectionIdentity(output);
  if (!actual) return false;
  const selection = request.selection;
  let managed: ManagedDcodeIdentity;
  try {
    managed = identityRuntime.resolveManagedDcodeIdentity(
      selection.upstreamProvider,
      selection.model,
      selection.endpointUrl,
    );
  } catch {
    return false;
  }
  const expectedProvider =
    managed.provider === "openrouter" ? managed.provider : selection.upstreamProvider;
  return (
    actual.route === selection.providerKey &&
    actual.provider === expectedProvider &&
    actual.model === managed.defaultModel &&
    actual.endpoint === selection.baseUrl
  );
}

function main(): void {
  const encoded = process.argv[2] ?? "";
  const nonce = process.argv[3] ?? "";
  const request = parseSelectionQualificationRequest(encoded);
  if (!request || !NONCE_PATTERN.test(nonce)) process.exit(2);
  const identityRuntime =
    require("/opt/nemoclaw-deepagents-code/packages/nemoclaw-langchain-deepagents-code/host/managed-identity.cts") as ManagedIdentityRuntime;
  const sandboxName = process.env.NEMOCLAW_SANDBOX_NAME;
  const result = spawnSync("/usr/local/bin/dcode", ["identity"], {
    encoding: "utf8",
    env: {
      HOME: "/sandbox",
      PATH: "/usr/local/bin:/opt/venv/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin",
      ...(safeText(sandboxName) ? { NEMOCLAW_SANDBOX_NAME: sandboxName } : {}),
    },
    timeout: 20_000,
    maxBuffer: MAX_NATIVE_OUTPUT_BYTES,
    windowsHide: true,
  });
  if (
    result.error ||
    result.status !== 0 ||
    result.signal !== null ||
    typeof result.stdout !== "string" ||
    !selectionMatchesNativeIdentity(request, result.stdout, identityRuntime)
  ) {
    process.exit(1);
  }
  process.stdout.write(`${QUALIFIED_MARKER}${nonce}\n`);
}

module.exports = {
  parseSelectionQualificationRequest,
  parseDcodeSelectionIdentity,
  selectionMatchesNativeIdentity,
};

if (require.main === module) main();
