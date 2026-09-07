#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Generate openclaw.json from environment variables.
//
// Called at Docker image build time after ARG->ENV promotion. Reads all
// configuration from process.env, never from Dockerfile source interpolation.
//
// Main inputs:
//   CHAT_UI_URL, NEMOCLAW_DASHBOARD_PORT, NEMOCLAW_MODEL,
//   NEMOCLAW_INFERENCE_PROVIDER_ID, NEMOCLAW_UPSTREAM_PROVIDER, NEMOCLAW_PRIMARY_MODEL_REF,
//   NEMOCLAW_INFERENCE_BASE_URL, NEMOCLAW_INFERENCE_API,
//   NEMOCLAW_INFERENCE_INPUTS, NEMOCLAW_CONTEXT_WINDOW,
//   NEMOCLAW_MAX_TOKENS, NEMOCLAW_REASONING,
//   NEMOCLAW_TOOL_DISCLOSURE,
//   NEMOCLAW_AGENT_TIMEOUT, NEMOCLAW_AGENT_HEARTBEAT_EVERY,
//   NEMOCLAW_INFERENCE_COMPAT_B64,
//   NEMOCLAW_DASHBOARD_BIND, NEMOCLAW_WSL_DASHBOARD_EXPOSURE,
//   NEMOCLAW_DISABLE_DEVICE_AUTH,
//   NEMOCLAW_DEVICE_AUTH_OPT_OUT_SOURCE,
//   NEMOCLAW_EXTRA_AGENTS_JSON_B64,
//   NEMOCLAW_PROXY_HOST, NEMOCLAW_PROXY_PORT,
//   NEMOCLAW_OPENCLAW_MANAGED_PROXY, NEMOCLAW_WEB_SEARCH_ENABLED,
//   NEMOCLAW_WEB_SEARCH_PROVIDER,
//   NEMOCLAW_OPENCLAW_OTEL, NEMOCLAW_OPENCLAW_OTEL_ENDPOINT,
//   NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME, NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE,
//   NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { readToolDisclosureEnv } from "./tool-disclosure.ts";
import { buildOpenClawAgentList, parseExtraAgentConfig } from "./agent-config.mts";
import { applyOpenClawSetupEffects, findMatchingModelSetups } from "./model-setup.mts";

export type { ExtraAgentsPayload } from "./agent-config.mts";

type Env = Record<string, string | undefined>;
type JsonObject = Record<string, any>;
type OpenClawReplyBudgetRuntime = {
  readonly DEFAULT_OPENCLAW_MAX_TOKENS: number;
};

const { DEFAULT_OPENCLAW_MAX_TOKENS } = createRequire(import.meta.url)(
  "../host/config-runtime.cts",
) as OpenClawReplyBudgetRuntime;

const DEFAULT_DASHBOARD_PORT = 18789;
const FABRIC_ADAPTER_PATH = "/usr/local/share/nemoclaw/openclaw.fabric-adapter.json";
const FABRIC_ARTIFACTS_PATH = "/sandbox/.openclaw/fabric-artifacts";
const MIN_DASHBOARD_PORT = 1024;
const MAX_DASHBOARD_PORT = 65535;
const REMOTE_DASHBOARD_BIND_VALUES = new Set(["0.0.0.0"]);
const DEVICE_AUTH_OPT_OUT_SOURCES = new Set(["operator", "managed-onboard"]);
const BOOLEAN_BUILD_FLAG_VALUES = new Set(["0", "1"]);

function readOptionalEnumEnv(env: Env, name: string, allowedValues: ReadonlySet<string>): string {
  const value = env[name] ?? "";
  if (value !== "" && !allowedValues.has(value)) {
    throw new Error(`${name} must be empty or one of: ${[...allowedValues].join(", ")}`);
  }
  return value;
}

function readBooleanBuildFlag(env: Env, name: string): boolean {
  return readOptionalEnumEnv(env, name, BOOLEAN_BUILD_FLAG_VALUES) === "1";
}

// Local Ollama small-context compaction policy (NemoClaw #5468).
//
// OpenClaw 2026.5.x auto-compaction reserves `reserveTokensFloor` tokens at the
// tail of the context window for reply generation (default 20_000, see the
// pinned openclaw package's pi-settings), then clamps that reserve so at least
// OPENCLAW_MIN_PROMPT_BUDGET_TOKENS (8_000) of the window stays available for
// prompt content. NemoClaw floors a Local Ollama runtime window to 16_384
// (ollama-runtime-context.ts), so the default 20k reserve is clamped down and
// the prompt budget is pinned at ~8k — too small for OpenClaw's base prompt +
// tool catalogue (~7.4k tokens). The first user turn overflows and preemptive
// compaction, with no prior history to compact, fails with
// "Auto-compaction could not recover this turn".
//
// Below SMALL_OLLAMA_CONTEXT_THRESHOLD we lower both reserveTokens and
// reserveTokensFloor to the model's own reply budget (maxTokens) so the prompt
// budget becomes `contextWindow - reserve` and the first turn fits. Above the
// threshold OpenClaw's default reserve already leaves an ample prompt budget, so
// its safeguard is left untouched. Both keys must be set: OpenClaw applies
// max(reserveTokens, reserveTokensFloor), so lowering the floor alone would let
// the 20k default pull the reserve back up.
const OPENCLAW_DEFAULT_RESERVE_TOKENS_FLOOR = 20_000;
const OPENCLAW_MIN_PROMPT_BUDGET_TOKENS = 8_000;
const SMALL_OLLAMA_CONTEXT_THRESHOLD =
  OPENCLAW_DEFAULT_RESERVE_TOKENS_FLOOR + OPENCLAW_MIN_PROMPT_BUDGET_TOKENS;
const LOCAL_OLLAMA_UPSTREAM_PROVIDER = "ollama-local";
const MANAGED_INFERENCE_PROVIDER_KEY = "inference";
const MANAGED_INFERENCE_HOSTNAME = "inference.local";
// Upstream source of truth (#4781): OpenClaw's `AgentCompactionConfig` schema and
// safeguard compactor/session runtime shipped by the exact `OPENCLAW_VERSION`
// pin in the production image (`Dockerfile` and `Dockerfile.base`). The observed
// long-running `/compact` operation and growing active context occur there after
// NemoClaw hands off this config.
// NemoClaw does not own that runtime, so this is a generator-side mitigation,
// not a source fix.
// The runtime-overrides E2E validates this object with the pinned OpenClaw CLI;
// that does not prove live token reduction, so keep #4781 open. Remove this
// override only after a newer pinned OpenClaw runtime has managed-inference
// regression evidence that `/compact` completes and leaves a no-larger active
// context without it.
const MANAGED_INFERENCE_SAFEGUARD_COMPACTION: JsonObject = {
  mode: "safeguard",
  timeoutSeconds: 120,
  maxHistoryShare: 0.35,
  recentTurnsPreserve: 1,
  qualityGuard: { enabled: true, maxRetries: 0 },
  notifyUser: true,
  truncateAfterCompaction: true,
};
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const WEB_SEARCH_PROVIDERS = {
  brave: { credentialEnv: "BRAVE_API_KEY" },
  tavily: { credentialEnv: "TAVILY_API_KEY" },
} as const;
type WebSearchProvider = keyof typeof WEB_SEARCH_PROVIDERS;
const DEFAULT_OPENCLAW_OTEL_ENDPOINT = "http://host.openshell.internal:4318";
const DEFAULT_OPENCLAW_OTEL_SERVICE_NAME = "openclaw-gateway";
// Runtime-facing IDs declared by the built-in messaging manifests. Package
// selection remains manifest-derived in messaging-build-applier.mts; this
// paired contract keeps each installed/bundled plugin bound to the channel key
// that must remain disabled in a neutral managed image.
export const MANAGED_IMAGE_OPENCLAW_MESSAGING_CAPABILITIES = [
  { channelId: "telegram", pluginId: "telegram" },
  { channelId: "discord", pluginId: "discord" },
  { channelId: "openclaw-weixin", pluginId: "openclaw-weixin" },
  { channelId: "slack", pluginId: "slack" },
  { channelId: "whatsapp", pluginId: "whatsapp" },
  { channelId: "msteams", pluginId: "msteams" },
  { channelId: "googlechat", pluginId: "googlechat" },
] as const;
// OpenClaw also ships channel plugins outside NemoClaw's currently supported
// messaging manifests. Keep those bundled entrypoints explicitly inert without
// representing them as activatable managed-image capabilities.
export const MANAGED_IMAGE_OPENCLAW_BUNDLED_INERT_CAPABILITIES = [
  { channelId: "imessage", pluginId: "imessage" },
] as const;
const MANAGED_IMAGE_OPENCLAW_NEUTRAL_CAPABILITIES = [
  ...MANAGED_IMAGE_OPENCLAW_MESSAGING_CAPABILITIES,
  ...MANAGED_IMAGE_OPENCLAW_BUNDLED_INERT_CAPABILITIES,
] as const;
const MANAGED_IMAGE_OPENCLAW_PLUGIN_IDS = [
  ...MANAGED_IMAGE_OPENCLAW_NEUTRAL_CAPABILITIES.map(({ pluginId }) => pluginId),
  "diagnostics-otel",
  "brave",
  "tavily",
] as const;
function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveWebSearchProvider(env: Env): WebSearchProvider {
  const provider = (env.NEMOCLAW_WEB_SEARCH_PROVIDER || "brave").trim();
  if (provider === "brave" || provider === "tavily") return provider;
  throw new Error(
    `NEMOCLAW_WEB_SEARCH_PROVIDER must be "brave" or "tavily", got ${JSON.stringify(provider)}`,
  );
}

function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

function expandUser(pathValue: string): string {
  if (pathValue === "~") {
    return process.env.HOME || pathValue;
  }
  if (pathValue.startsWith(`~${sep}`) || pathValue.startsWith("~/")) {
    return join(process.env.HOME || "~", pathValue.slice(2));
  }
  return pathValue;
}

function coercePositiveInt(env: Env, name: string, defaultValue: number): number {
  const raw = env[name] || String(defaultValue);
  let value = 0;
  if (/^\d+$/.test(raw) && raw.length < 1000) {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed)) {
      value = parsed;
    }
  }
  if (value > 0) {
    return value;
  }
  console.error(
    `[SECURITY] ${name} must be a positive integer, got "${raw}" ` +
      `-- skipping override, falling back to default (${defaultValue})`,
  );
  return defaultValue;
}

function isLoopback(hostname: string): boolean {
  const normalized = (hostname || "").trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  return /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function normalizeUrlForParse(rawUrl: string): string {
  if (rawUrl && !/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl)) {
    return `http://${rawUrl}`;
  }
  return rawUrl;
}

function truthyEnvDefault(env: Env, name: string, defaultValue: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return defaultValue;
  }
  return !FALSE_VALUES.has(raw.trim().toLowerCase());
}

function parseOpenClawOtelSampleRate(raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0.0 || value > 1.0) {
    throw new Error("NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE must be between 0.0 and 1.0");
  }
  return value;
}

function buildOpenClawOtelConfig(env: Env): JsonObject | undefined {
  if (!truthyEnvDefault(env, "NEMOCLAW_OPENCLAW_OTEL", false)) {
    return undefined;
  }

  const endpoint = (env.NEMOCLAW_OPENCLAW_OTEL_ENDPOINT || DEFAULT_OPENCLAW_OTEL_ENDPOINT).trim();
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    throw new Error("NEMOCLAW_OPENCLAW_OTEL_ENDPOINT must be an http(s) OTLP/HTTP endpoint");
  }
  if (!["http:", "https:"].includes(parsedEndpoint.protocol) || !parsedEndpoint.host) {
    throw new Error("NEMOCLAW_OPENCLAW_OTEL_ENDPOINT must be an http(s) OTLP/HTTP endpoint");
  }
  if (parsedEndpoint.username || parsedEndpoint.password) {
    throw new Error("NEMOCLAW_OPENCLAW_OTEL_ENDPOINT must not include credentials");
  }

  const serviceName = (
    env.NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME || DEFAULT_OPENCLAW_OTEL_SERVICE_NAME
  ).trim();
  if (!serviceName) {
    throw new Error("NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME must not be empty");
  }

  return {
    enabled: true,
    endpoint,
    protocol: "http/protobuf",
    serviceName,
    traces: true,
    metrics: false,
    logs: false,
    sampleRate: parseOpenClawOtelSampleRate(
      (env.NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE || "1.0").trim(),
    ),
  };
}

function validateDashboardPort(raw: string, envName: string): number {
  const stripped = raw.trim();
  if (!/^\d+$/.test(stripped)) {
    throw new Error(`${envName} must be an integer between 1024 and 65535`);
  }
  const value = Number(stripped);
  if (value < MIN_DASHBOARD_PORT || value > MAX_DASHBOARD_PORT) {
    throw new Error(`${envName} must be an integer between 1024 and 65535`);
  }
  return value;
}

type ParsedUrl = {
  scheme: string;
  hostname: string;
  port: number | null;
  origin: string | null;
};

function parseUrl(rawUrl: string): ParsedUrl {
  // Match browser URL semantics for CHAT_UI_URL security decisions. In
  // particular, userinfo such as "localhost@remote" must not be treated as
  // the effective host.
  try {
    const url = new URL(rawUrl);
    const port = url.port ? Number(url.port) : null;
    return {
      scheme: url.protocol.replace(/:$/, ""),
      hostname: url.hostname.toLowerCase(),
      port: port !== null && Number.isSafeInteger(port) ? port : null,
      origin: url.origin === "null" ? null : url.origin,
    };
  } catch {
    return { scheme: "", hostname: "", port: null, origin: null };
  }
}

function chatUiUrlPort(chatUiUrl: string): number | null {
  const parsed = parseUrl(normalizeUrlForParse(chatUiUrl));
  if (parsed.port === null) {
    return null;
  }
  if (parsed.port < MIN_DASHBOARD_PORT || parsed.port > MAX_DASHBOARD_PORT) {
    return null;
  }
  return parsed.port;
}

function resolveGatewayPort(env: Env, chatUiUrl: string): number {
  const rawDashboardPort = env.NEMOCLAW_DASHBOARD_PORT || "";
  if (rawDashboardPort.trim()) {
    return validateDashboardPort(rawDashboardPort, "NEMOCLAW_DASHBOARD_PORT");
  }
  return chatUiUrlPort(chatUiUrl) || DEFAULT_DASHBOARD_PORT;
}

function hostForOrigin(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname;
  }
  return hostname.includes(":") ? `[${hostname}]` : hostname;
}

function coerceCompatDict(value: unknown): JsonObject {
  if (value === null || value === undefined) {
    return {};
  }
  if (isObject(value)) {
    return value;
  }
  throw new Error("NEMOCLAW_INFERENCE_COMPAT_B64 must decode to a JSON object or null");
}

const REASONING_EFFORT_VALUES = ["low", "medium", "high"];
const REASONING_EFFORT_DEFAULT = "default";
const REASONING_EFFORT_PROVIDER = "compatible-endpoint";

// OpenClaw merges params.extra_body into openai-completions request bodies, so
// this is the config-level route to a reasoning_effort the endpoint receives.
function buildReasoningEffortParams(env: Env): JsonObject {
  const raw = (env.NEMOCLAW_REASONING_EFFORT || "").trim().toLowerCase();
  const upstreamProvider = (env.NEMOCLAW_UPSTREAM_PROVIDER || "").trim();
  if (!raw || raw === REASONING_EFFORT_DEFAULT) return {};
  if (upstreamProvider !== REASONING_EFFORT_PROVIDER) return {};
  if (!REASONING_EFFORT_VALUES.includes(raw)) {
    throw new Error(
      `NEMOCLAW_REASONING_EFFORT must be one of: ${[
        ...REASONING_EFFORT_VALUES,
        REASONING_EFFORT_DEFAULT,
      ].join(", ")}`,
    );
  }
  if ((env.NEMOCLAW_INFERENCE_API as string) !== "openai-completions") return {};
  return { params: { extra_body: { reasoning_effort: raw } } };
}

function decodeJsonEnv(env: Env, name: string, defaultValue: string): any {
  const raw = env[name] || defaultValue;
  return JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
}

// Build the agents.defaults.compaction override for a Local Ollama small-context
// window, or undefined when it does not apply. See the policy constants above.
export function buildLocalOllamaSmallContextCompaction(
  upstreamProvider: string | undefined,
  contextWindow: number,
  maxTokens: number,
): JsonObject | undefined {
  if ((upstreamProvider || "").trim() !== LOCAL_OLLAMA_UPSTREAM_PROVIDER) {
    return undefined;
  }
  if (!Number.isFinite(contextWindow) || contextWindow > SMALL_OLLAMA_CONTEXT_THRESHOLD) {
    return undefined;
  }
  // Reserve the model's reply budget, but never so much that the remaining
  // prompt budget drops below OpenClaw's own minimum — mirrors OpenClaw's clamp
  // so a pathological maxTokens cannot make the window worse than the default.
  const maxReserve = Math.max(0, contextWindow - OPENCLAW_MIN_PROMPT_BUDGET_TOKENS);
  const reserveTokens = Math.max(0, Math.min(maxTokens, maxReserve));
  return { reserveTokens, reserveTokensFloor: reserveTokens };
}

function isManagedInferenceLocalRoute(
  providerKey: string | undefined,
  inferenceBaseUrl: string,
): boolean {
  if ((providerKey || "").trim() !== MANAGED_INFERENCE_PROVIDER_KEY) {
    return false;
  }
  return parseUrl(normalizeUrlForParse(inferenceBaseUrl)).hostname === MANAGED_INFERENCE_HOSTNAME;
}

// Managed inference sessions other than Local Ollama use OpenClaw's safeguard
// compaction rather than its plain runtime compactor. A two-minute timeout
// bounds each attempt, lifecycle notices expose automatic and agent-run
// compaction progress, and
// successful compaction rotates the active transcript. These safeguards do not
// guarantee that summarization succeeds or that the resulting context is smaller.
export function buildManagedInferenceSafeguardCompaction(
  providerKey: string | undefined,
  upstreamProvider: string | undefined,
  inferenceBaseUrl: string,
): JsonObject | undefined {
  if (!isManagedInferenceLocalRoute(providerKey, inferenceBaseUrl)) {
    return undefined;
  }
  if ((upstreamProvider || "").trim() === LOCAL_OLLAMA_UPSTREAM_PROVIDER) {
    return undefined;
  }
  return {
    ...MANAGED_INFERENCE_SAFEGUARD_COMPACTION,
    qualityGuard: { ...MANAGED_INFERENCE_SAFEGUARD_COMPACTION.qualityGuard },
  };
}

export function buildConfig(env: Env = process.env): JsonObject {
  const proxyHost = env.NEMOCLAW_PROXY_HOST || "10.200.0.1";
  const proxyPort = env.NEMOCLAW_PROXY_PORT || "3128";
  const proxyUrl = `http://${proxyHost}:${proxyPort}`;
  const emitOpenClawManagedProxy = truthyEnvDefault(env, "NEMOCLAW_OPENCLAW_MANAGED_PROXY", true);
  const model = env.NEMOCLAW_MODEL as string;
  const rawChatUiUrl = env.CHAT_UI_URL || "";
  let chatUiUrl = rawChatUiUrl || `http://127.0.0.1:${DEFAULT_DASHBOARD_PORT}`;
  const gatewayPort = resolveGatewayPort(env, chatUiUrl);
  if (
    (env.NEMOCLAW_DASHBOARD_PORT || "").trim() &&
    (!rawChatUiUrl || rawChatUiUrl === `http://127.0.0.1:${DEFAULT_DASHBOARD_PORT}`)
  ) {
    chatUiUrl = `http://127.0.0.1:${gatewayPort}`;
  }
  const providerKey = (env.NEMOCLAW_INFERENCE_PROVIDER_ID || env.NEMOCLAW_PROVIDER_KEY) as string;
  const primaryModelRef = env.NEMOCLAW_PRIMARY_MODEL_REF as string;
  const inferenceBaseUrl = env.NEMOCLAW_INFERENCE_BASE_URL as string;
  const inferenceApi = env.NEMOCLAW_INFERENCE_API as string;
  const contextWindow = coercePositiveInt(env, "NEMOCLAW_CONTEXT_WINDOW", 131072);
  const maxTokens = coercePositiveInt(env, "NEMOCLAW_MAX_TOKENS", DEFAULT_OPENCLAW_MAX_TOKENS);
  const toolDisclosure = readToolDisclosureEnv(env);

  const reasoning = (env.NEMOCLAW_REASONING || "false") === "true";
  const reasoningEffortParams = buildReasoningEffortParams(env);
  const inferenceInputs = (env.NEMOCLAW_INFERENCE_INPUTS || "text")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (inferenceInputs.length === 0) {
    inferenceInputs.push("text");
  }

  const rawAgentTimeout = env.NEMOCLAW_AGENT_TIMEOUT || "600";
  const parsedAgentTimeout = /^\d+$/.test(rawAgentTimeout) ? Number(rawAgentTimeout) : 0;
  if (!Number.isSafeInteger(parsedAgentTimeout) || parsedAgentTimeout <= 0) {
    throw new Error("NEMOCLAW_AGENT_TIMEOUT must be a positive integer");
  }
  const agentTimeout = parsedAgentTimeout;

  let agentHeartbeat = (env.NEMOCLAW_AGENT_HEARTBEAT_EVERY || "").trim();
  if (agentHeartbeat && !/^\d+(s|m|h)$/.test(agentHeartbeat)) {
    console.error(
      `[SECURITY] NEMOCLAW_AGENT_HEARTBEAT_EVERY must match ^\\d+(s|m|h)$, ` +
        `got "${agentHeartbeat}" -- skipping override, preserving OpenClaw default`,
    );
    agentHeartbeat = "";
  }

  const modelSpecificSetups = findMatchingModelSetups(
    "openclaw",
    {
      model,
      providerKey,
      baseUrl: inferenceBaseUrl,
      inferenceApi,
    },
    env,
  );

  const inferenceCompat = coerceCompatDict(
    decodeJsonEnv(env, "NEMOCLAW_INFERENCE_COMPAT_B64", "e30="),
  );
  const extraAgentsPayload = parseExtraAgentConfig(
    decodeJsonEnv(env, "NEMOCLAW_EXTRA_AGENTS_JSON_B64", "W10="),
    providerKey,
  );
  const extraAgents = extraAgentsPayload.agents;
  const openclawPlugins: JsonObject[] = [];
  const openclawPluginIds = new Set<string>();
  const openclawToolOverrides: JsonObject = {};
  for (const setup of modelSpecificSetups) {
    applyOpenClawSetupEffects(
      setup,
      inferenceCompat,
      openclawPlugins,
      openclawPluginIds,
      openclawToolOverrides,
    );
  }
  // OpenClaw v2026.5.27 accepts either a boolean shorthand or this object form.
  // Model-specific manifests intentionally remain boolean-only and replace this
  // value wholesale: false disables Tool Search; true restores upstream code
  // mode. Do not shallow-merge a boolean override into the structured object.
  const structuredToolSearch: JsonObject = {
    mode: "tools",
    searchDefaultLimit: 8,
    maxSearchLimit: 20,
  };
  const openclawTools: JsonObject = {
    ...openclawToolOverrides,
    // An explicit direct request is authoritative. Compatibility manifests may
    // downgrade progressive mode to false, but may never re-enable search over
    // a user's direct selection.
    toolSearch:
      toolDisclosure === "direct"
        ? false
        : "toolSearch" in openclawToolOverrides
          ? openclawToolOverrides.toolSearch
          : structuredToolSearch,
  };

  if (providerKey === "ollama" || providerKey === "ollama-local") {
    inferenceCompat.supportsUsageInStreaming ??= true;
  }

  const normalizedUrl = normalizeUrlForParse(chatUiUrl);
  const parsed = parseUrl(normalizedUrl);
  const loopbackOrigin = `http://127.0.0.1:${gatewayPort}`;
  const chatOrigin = parsed.origin || loopbackOrigin;
  const portlessOrigin =
    parsed.scheme && parsed.hostname && parsed.port !== null && !isLoopback(parsed.hostname)
      ? `${parsed.scheme}://${hostForOrigin(parsed.hostname)}`
      : null;
  const origins = unique([loopbackOrigin, chatOrigin, portlessOrigin].filter(Boolean) as string[]);

  const isRemote = !isLoopback(parsed.hostname || "");
  const dashboardBind = readOptionalEnumEnv(
    env,
    "NEMOCLAW_DASHBOARD_BIND",
    REMOTE_DASHBOARD_BIND_VALUES,
  );
  const remoteBindOptIn = dashboardBind === "0.0.0.0";
  const wslDashboardExposure = readBooleanBuildFlag(env, "NEMOCLAW_WSL_DASHBOARD_EXPOSURE");
  const hasRemoteDashboardExposure = isRemote || remoteBindOptIn || wslDashboardExposure;
  const deviceAuthOptOut = env.NEMOCLAW_DISABLE_DEVICE_AUTH === "1";
  const deviceAuthOptOutSource = readOptionalEnumEnv(
    env,
    "NEMOCLAW_DEVICE_AUTH_OPT_OUT_SOURCE",
    DEVICE_AUTH_OPT_OUT_SOURCES,
  );
  const managedDeviceAuthOptOut = deviceAuthOptOut && deviceAuthOptOutSource === "managed-onboard";
  const disableDeviceAuth = deviceAuthOptOut || hasRemoteDashboardExposure;
  const allowInsecure = parsed.scheme === "http";
  const securityAuditSuppressions: JsonObject[] = [];
  if (allowInsecure && !hasRemoteDashboardExposure) {
    const reason =
      "NemoClaw derives this setting from a loopback HTTP CHAT_UI_URL; use HTTPS for non-loopback dashboards.";
    securityAuditSuppressions.push(
      { checkId: "gateway.control_ui.insecure_auth", reason },
      {
        checkId: "config.insecure_or_dangerous_flags",
        detailIncludes: "gateway.controlUi.allowInsecureAuth=true",
        reason,
      },
    );
  }
  if (managedDeviceAuthOptOut && !hasRemoteDashboardExposure) {
    const reason =
      "NemoClaw onboarding disables device authentication for immediate dashboard access (managed compatibility behavior; see #1217).";
    securityAuditSuppressions.push(
      { checkId: "gateway.control_ui.device_auth_disabled", reason },
      {
        checkId: "config.insecure_or_dangerous_flags",
        detailIncludes: "gateway.controlUi.dangerouslyDisableDeviceAuth=true",
        reason,
      },
    );
  }

  const providerModels: JsonObject[] = [
    {
      ...(Object.keys(inferenceCompat).length > 0 ? { compat: inferenceCompat } : {}),
      id: model,
      name: primaryModelRef,
      reasoning,
      ...reasoningEffortParams,
      input: inferenceInputs,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow,
      maxTokens,
    },
  ];
  const seenModelRefs = new Set<string>([primaryModelRef]);
  const referencedRefs: string[] = [];
  const collectRef = (ref: unknown): void => {
    if (typeof ref !== "string" || !ref) return;
    if (seenModelRefs.has(ref)) return;
    seenModelRefs.add(ref);
    referencedRefs.push(ref);
  };
  for (const agent of extraAgents) {
    collectRef(agent.model);
    if (isObject(agent.subagents)) {
      collectRef(agent.subagents.model);
    }
  }
  if (extraAgentsPayload.main.subagents !== undefined) {
    collectRef(extraAgentsPayload.main.subagents.model);
  }
  for (const ref of referencedRefs) {
    const slash = ref.indexOf("/");
    const secondaryModelId = ref.slice(slash + 1);
    providerModels.push({
      id: secondaryModelId,
      name: ref,
      reasoning,
      ...reasoningEffortParams,
      input: inferenceInputs,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow,
      maxTokens,
    });
  }
  const providers = {
    [providerKey]: {
      baseUrl: inferenceBaseUrl,
      apiKey: "unused",
      api: inferenceApi,
      timeoutSeconds: agentTimeout,
      models: providerModels,
    },
  };

  const pluginEntries: JsonObject = {
    bonjour: { enabled: false },
  };
  const managedImageCapabilityUnion = readBooleanBuildFlag(
    env,
    "NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION",
  );
  if (managedImageCapabilityUnion) {
    for (const pluginId of MANAGED_IMAGE_OPENCLAW_PLUGIN_IDS) {
      pluginEntries[pluginId] = { enabled: false };
    }
  }
  const openclawOtel = buildOpenClawOtelConfig(env);
  if (openclawOtel) {
    pluginEntries["diagnostics-otel"] = { enabled: true };
  }
  const webSearchProvider =
    env.NEMOCLAW_WEB_SEARCH_ENABLED === "1" ? resolveWebSearchProvider(env) : undefined;

  const plugins: JsonObject = {
    allow: unique([
      "nemoclaw",
      ...openclawPlugins.map((plugin) => plugin.id),
      ...(openclawOtel ? ["diagnostics-otel"] : []),
      ...(webSearchProvider ? [webSearchProvider] : []),
    ]),
    entries: pluginEntries,
  };
  const pluginLoadPaths: string[] = [];
  for (const plugin of openclawPlugins) {
    pluginEntries[plugin.id] = { enabled: true };
    if (!pluginLoadPaths.includes(plugin.loadPath)) {
      pluginLoadPaths.push(plugin.loadPath);
    }
  }
  if (pluginLoadPaths.length > 0) {
    plugins.load = { paths: pluginLoadPaths };
  }

  const agentDefaults: JsonObject = {
    model: { primary: primaryModelRef },
    timeoutSeconds: agentTimeout,
    ...(agentHeartbeat ? { heartbeat: { every: agentHeartbeat } } : {}),
    skipBootstrap: true,
    thinkingDefault: "off",
  };
  if (Object.keys(extraAgentsPayload.defaults.subagents).length > 0) {
    agentDefaults.subagents = extraAgentsPayload.defaults.subagents;
  }

  const smallOllamaCompaction = buildLocalOllamaSmallContextCompaction(
    env.NEMOCLAW_UPSTREAM_PROVIDER,
    contextWindow,
    maxTokens,
  );
  if (smallOllamaCompaction) {
    agentDefaults.compaction = smallOllamaCompaction;
  }
  const managedInferenceCompaction = buildManagedInferenceSafeguardCompaction(
    providerKey,
    env.NEMOCLAW_UPSTREAM_PROVIDER,
    inferenceBaseUrl,
  );
  if (managedInferenceCompaction) {
    agentDefaults.compaction = managedInferenceCompaction;
  }

  const channels: JsonObject = { defaults: {} };
  if (managedImageCapabilityUnion) {
    for (const { channelId } of MANAGED_IMAGE_OPENCLAW_NEUTRAL_CAPABILITIES) {
      channels[channelId] = { enabled: false };
    }
  }

  const config: JsonObject = {
    agents: {
      defaults: agentDefaults,
      list: buildOpenClawAgentList(extraAgents, extraAgentsPayload.main),
    },
    models: { mode: "merge", providers },
    channels,
    tools: openclawTools,
    update: { checkOnStart: false },
    ...(securityAuditSuppressions.length > 0
      ? { security: { audit: { suppressions: securityAuditSuppressions } } }
      : {}),
    plugins,
    gateway: {
      mode: "local",
      port: gatewayPort,
      controlUi: {
        allowInsecureAuth: allowInsecure,
        dangerouslyDisableDeviceAuth: disableDeviceAuth,
        allowedOrigins: origins,
        ...(remoteBindOptIn && !isRemote ? { dangerouslyAllowHostHeaderOriginFallback: true } : {}),
      },
      trustedProxies: ["127.0.0.1", "::1"],
      auth: { token: "" },
      // Restart-class config changes (plugins.installs, models.pricing,
      // unrecognized keys, ...) must not let the gateway SIGUSR1-restart
      // itself: in containers the in-process restart path can fail and park
      // the process alive with no HTTP listener, which the PID-wait respawn
      // loop in nemoclaw-start.sh cannot observe (#4710). Hot mode makes the
      // gateway ignore plan-driven restarts; NemoClaw applies restart-class
      // changes through sandbox rebuild or `nemoclaw <name> recover` instead.
      // Removal condition (also for the serving watchdog in
      // nemoclaw-start.sh): once the pinned OpenClaw release exits non-zero
      // when a failed in-process restart cannot re-bind its listener — so the
      // respawn loop sees the death — this pin can revert to the default
      // reload mode after a wedge drill proves no regression.
      reload: { mode: "hot" },
    },
  };

  if (emitOpenClawManagedProxy) {
    config.proxy = {
      enabled: true,
      proxyUrl,
      loopbackMode: "gateway-only",
    };
  }
  if (openclawOtel) {
    config.diagnostics = {
      enabled: true,
      otel: openclawOtel,
    };
  }

  const tools = config.tools;
  tools.web ??= {};
  tools.web.fetch = { enabled: true, useTrustedEnvProxy: true };
  if (managedImageCapabilityUnion) {
    tools.web.search = { enabled: false };
  }

  if (webSearchProvider) {
    // OpenClaw 2026.5.x keeps provider-owned credentials under
    // plugins.entries.<provider>.config rather than inline on tools.web.search.
    // Brave is installed externally during the image build; Tavily ships as a
    // bundled OpenClaw extension. Both use the same plugin-scoped config shape.
    const credentialEnv = WEB_SEARCH_PROVIDERS[webSearchProvider].credentialEnv;
    tools.web.search = { enabled: true, provider: webSearchProvider };
    config.plugins.entries[webSearchProvider] = {
      enabled: true,
      config: { webSearch: { apiKey: `openshell:resolve:env:${credentialEnv}` } },
    };
  }

  return config;
}

/** Select OpenClaw's package-owned adapter without duplicating native agent configuration. */
export function buildOpenClawFabricConfig(): JsonObject {
  return {
    schema_version: "fabric.agent/v1alpha1",
    metadata: {
      name: "nemoclaw-openclaw",
      description: "NemoClaw-managed OpenClaw headless runtime",
    },
    harness: {
      adapter_id: "nvidia.nemoclaw.openclaw",
      resolution: "preinstalled",
    },
    discovery: {
      local_paths: [FABRIC_ADAPTER_PATH],
    },
    runtime: {
      input_schema: "text",
      output_schema: "message",
      artifacts: FABRIC_ARTIFACTS_PATH,
      timeout_seconds: 90,
    },
    environment: {
      provider: "local",
      workspace: "/sandbox",
      artifacts: FABRIC_ARTIFACTS_PATH,
      ownership: "caller_owned",
      control_location: "in_env_control",
    },
  };
}

function boundedOpenClawMetadataText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    Buffer.byteLength(value, "utf8") <= 256 &&
    !/[\0\r\n]/u.test(value)
  );
}

function readExistingOpenClawConfig(configPath: string): JsonObject | null {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return null;
  }
  return isObject(value) ? value : null;
}

function openClawContinuityMetadata(value: unknown): JsonObject | null {
  if (
    !isObject(value) ||
    !boundedOpenClawMetadataText(value.lastTouchedVersion) ||
    !boundedOpenClawMetadataText(value.lastTouchedAt)
  ) {
    return null;
  }
  return {
    lastTouchedVersion: value.lastTouchedVersion,
    lastTouchedAt: value.lastTouchedAt,
  };
}

function preserveExistingOpenClawState(config: JsonObject, configPath: string): void {
  const existing = readExistingOpenClawConfig(configPath);

  // OpenClaw 2026.7 rejects a regenerated config that drops the write
  // metadata carried by its last-known-good snapshot, then restores the old
  // config with `missing-meta-vs-last-good`. The final image-generation pass
  // can leave the active file without metadata while its exact OpenClaw-owned
  // `.bak` retains it, so prefer the active pair and otherwise inspect only
  // that one fixed backup path. Copy only the two bounded continuity fields;
  // every NemoClaw-owned routing field still comes from the managed profile.
  const continuityMeta =
    openClawContinuityMetadata(existing?.meta) ??
    openClawContinuityMetadata(readExistingOpenClawConfig(`${configPath}.bak`)?.meta);
  if (continuityMeta) config.meta = continuityMeta;

  if (!existing) return;
  const existingPlugins = existing.plugins;
  if (!isObject(existingPlugins)) {
    return;
  }
  const currentPlugins = config.plugins;
  if (Array.isArray(existingPlugins.allow)) {
    currentPlugins.allow = unique([
      ...(Array.isArray(currentPlugins.allow) ? currentPlugins.allow : []),
      ...existingPlugins.allow.filter(
        (pluginId): pluginId is string => typeof pluginId === "string",
      ),
    ]);
  }
  const existingInstalls = existingPlugins.installs;
  if (!isObject(existingInstalls) || Object.keys(existingInstalls).length === 0) {
    return;
  }
  if (!isObject(currentPlugins.installs)) {
    currentPlugins.installs = {};
  }
  Object.assign(currentPlugins.installs, existingInstalls);
}

export function writeOpenClawConfig(): void {
  const config = buildConfig();
  const configPath = expandUser("~/.openclaw/openclaw.json");
  const fabricConfigPath = expandUser("~/.openclaw/fabric.json");
  preserveExistingOpenClawState(config, configPath);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  chmodSync(configPath, 0o600);
  writeFileSync(fabricConfigPath, `${JSON.stringify(buildOpenClawFabricConfig(), null, 2)}\n`);
  chmodSync(fabricConfigPath, 0o600);
}

export function main(): void {
  writeOpenClawConfig();
}

function isMainModule(): boolean {
  return process.argv[1] ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href : false;
}

if (isMainModule()) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
