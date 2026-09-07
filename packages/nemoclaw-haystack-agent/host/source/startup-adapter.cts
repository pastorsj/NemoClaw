// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessPackageStartupRequest,
  HarnessStartupAdapterModule,
  HarnessStartupJsonObject,
  HarnessStartupPlan,
  HarnessStartupRequest,
  HarnessStartupRootFileMaterial,
  HarnessStartupSettings,
} from "@nvidia/nemoclaw-harness-contract";

const PACKAGE_ID = "haystack-agent";
const MANAGED_BASE_URL = "https://inference.local/v1";
const DEFAULT_SYSTEM_INSTRUCTION =
  "Answer the user's request directly. Do not claim tools or durable memory.";

interface HaystackRuntimeConfig extends HarnessStartupJsonObject {
  readonly temperature: number;
  readonly maxTurns: number;
  readonly systemInstruction: string;
}

type StartupPackageConfig = HarnessStartupJsonObject & {
  readonly settings: HarnessStartupSettings;
  readonly runtime: HaystackRuntimeConfig;
};

type StartupAdapterRequest =
  | HarnessStartupRequest
  | HarnessPackageStartupRequest<StartupPackageConfig>;

interface NormalizedStartupRequest {
  readonly packageId: string;
  readonly settings: HarnessStartupSettings;
  readonly runtime: HaystackRuntimeConfig;
  readonly applicationEnvironment: Readonly<Record<string, string>>;
}

const DEFAULT_RUNTIME_CONFIG: HaystackRuntimeConfig = Object.freeze({
  temperature: 0,
  maxTurns: 8,
  systemInstruction: DEFAULT_SYSTEM_INSTRUCTION,
});

function fail(message: string): never {
  throw new Error(`Cannot build Haystack Agent startup plan: ${message}`);
}

function requirePackageIdentity(request: {
  readonly packageId: string;
  readonly harnessPackage?: { readonly id: string };
}): void {
  if (
    request.packageId !== PACKAGE_ID ||
    (request.harnessPackage !== undefined && request.harnessPackage.id !== PACKAGE_ID)
  ) {
    fail("package identity is inconsistent");
  }
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("receipt-backed package config is inconsistent");
  }
}

function runtimeConfigFrom(value: unknown): HaystackRuntimeConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("receipt-backed runtime config is invalid");
  }
  const runtime = value as Record<string, unknown>;
  requireExactKeys(runtime, ["maxTurns", "systemInstruction", "temperature"]);
  if (
    typeof runtime.temperature !== "number" ||
    !Number.isFinite(runtime.temperature) ||
    runtime.temperature < 0 ||
    runtime.temperature > 2
  ) {
    fail("runtime temperature must be a number between 0 and 2");
  }
  if (
    typeof runtime.maxTurns !== "number" ||
    !Number.isSafeInteger(runtime.maxTurns) ||
    runtime.maxTurns < 1 ||
    runtime.maxTurns > 32
  ) {
    fail("runtime maxTurns must be an integer between 1 and 32");
  }
  if (
    typeof runtime.systemInstruction !== "string" ||
    runtime.systemInstruction.trim() === "" ||
    runtime.systemInstruction.length > 4096 ||
    /[\p{Cc}\p{Cf}]/u.test(runtime.systemInstruction)
  ) {
    fail("runtime systemInstruction must be bounded text without control characters");
  }
  return Object.freeze({
    temperature: runtime.temperature,
    maxTurns: runtime.maxTurns,
    systemInstruction: runtime.systemInstruction,
  });
}

function normalizeStartupRequest(request: StartupAdapterRequest): NormalizedStartupRequest {
  requirePackageIdentity(request);
  if (request.profileKind !== "package") {
    return { ...request, runtime: DEFAULT_RUNTIME_CONFIG };
  }
  requireExactKeys(request.packageConfig, ["runtime", "settings"]);
  const settings = request.packageConfig.settings as unknown;
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    fail("receipt-backed startup settings are invalid");
  }
  return {
    packageId: request.packageId,
    settings: { ...(settings as HarnessStartupSettings), corporateCa: request.corporateCa },
    runtime: runtimeConfigFrom(request.packageConfig.runtime),
    applicationEnvironment: request.applicationEnvironment,
  };
}

function rootFile(
  legacyInput: string,
  path: HarnessStartupRootFileMaterial["path"],
  value: string,
): HarnessStartupRootFileMaterial {
  return {
    kind: "root-owned-file",
    legacyInput,
    path,
    contents: `${value}\n`,
    owner: "root",
    group: "root",
    mode: 0o444,
  };
}

function assertSupportedSettings(settings: HarnessStartupSettings): void {
  if (
    settings.configuration.agent !== PACKAGE_ID ||
    settings.dashboard.agent !== PACKAGE_ID ||
    settings.dashboard.mode !== "disabled" ||
    settings.messaging.plan !== null ||
    settings.tools.enabledGateways.length > 0 ||
    settings.inference.api !== "openai-completions" ||
    settings.inference.routedBaseUrl !== MANAGED_BASE_URL
  ) {
    fail("startup settings request unsupported package behavior");
  }
}

function buildStartupPlan(adapterRequest: StartupAdapterRequest): HarnessStartupPlan {
  const request = normalizeStartupRequest(adapterRequest);
  const { runtime, settings } = request;
  assertSupportedSettings(settings);
  return {
    schemaVersion: 1,
    packageId: PACKAGE_ID,
    configurationEnvironment: {
      NEMOCLAW_INFERENCE_API: settings.inference.api,
      NEMOCLAW_INFERENCE_BASE_URL: settings.inference.routedBaseUrl,
      NEMOCLAW_MAX_TURNS: String(runtime.maxTurns),
      NEMOCLAW_MODEL: settings.inference.model,
      NEMOCLAW_SYSTEM_INSTRUCTION: runtime.systemInstruction,
      NEMOCLAW_TEMPERATURE: String(runtime.temperature),
    },
    runtimeEnvironment: {
      NEMOCLAW_INFERENCE_API: settings.inference.api,
      NEMOCLAW_MODEL: settings.inference.model,
    },
    applicationRuntime: {
      exportEnvironment: {},
      unsetEnvironment: ["NEMOCLAW_DASHBOARD_BIND", "NEMOCLAW_MINIMAL_BOOTSTRAP"],
    },
    managedState: {
      root: "/sandbox/.haystack-agent",
      files: ["fabric.json"],
      directories: ["fabric-artifacts"],
    },
    materials: [
      {
        kind: "corporate-ca-handoff",
        legacyInput: "NEMOCLAW_CORPORATE_CA_B64",
        expectedSha256: settings.corporateCa.bundleSha256,
      },
      rootFile(
        "NEMOCLAW_PROXY_HOST",
        "/usr/local/share/nemoclaw/haystack-proxy-host",
        settings.proxy.managedHost,
      ),
      rootFile(
        "NEMOCLAW_PROXY_PORT",
        "/usr/local/share/nemoclaw/haystack-proxy-port",
        String(settings.proxy.managedPort),
      ),
    ],
    actions: [{ kind: "generate-config", runAs: "sandbox" }],
  };
}

function prepareStartupProfile(
  request: Parameters<HarnessStartupAdapterModule["prepareStartupProfile"]>[0],
): ReturnType<HarnessStartupAdapterModule["prepareStartupProfile"]> {
  requirePackageIdentity(request);
  const input = request.input;
  const candidate = input.inference.candidates.find(
    (entry) => entry.requestedApi === "openai-completions" && entry.api === "openai-completions",
  );
  if (!candidate) fail("an OpenAI Completions inference candidate is required");
  if (candidate.routedBaseUrl !== MANAGED_BASE_URL) {
    fail(`the managed inference route must be ${MANAGED_BASE_URL}`);
  }
  if (input.dashboard.managed || input.messagingPlan !== null || input.webSearch !== null) {
    fail("dashboard, messaging, and web search are not supported");
  }
  if (input.tools.enabledGateways.length > 0) fail("tool gateways are not supported");
  if (Object.keys(input.environment).length > 0) {
    fail("package-specific startup environment is not supported");
  }
  const desiredState: HarnessStartupSettings = {
    configuration: { agent: PACKAGE_ID },
    inference: {
      routeProvider: candidate.routeProvider,
      upstreamProvider: input.inference.selectedProvider ?? candidate.routeProvider,
      model: input.inference.model,
      routedBaseUrl: candidate.routedBaseUrl,
      upstreamEndpointUrl: null,
      api: candidate.api,
      primaryModelRef: null,
      compatibility: null,
      inputModalities: null,
    },
    proxy: input.proxy,
    dashboard: { agent: PACKAGE_ID, mode: "disabled" },
    tools: { disclosure: input.tools.disclosure, enabledGateways: [] },
    messaging: { plan: null },
    tuning: {
      contextWindow: null,
      maxTokens: null,
      reasoning: null,
      reasoningEffort: null,
    },
    corporateCa: input.corporateCa,
  };
  buildStartupPlan({ packageId: PACKAGE_ID, settings: desiredState, applicationEnvironment: {} });
  return {
    kind: "prepared",
    desiredState,
    credentialProxyReplayRequired: false,
    dashboardRemoteBindPrepared: false,
  };
}

function packageConfigForDesiredState(
  request: Parameters<HarnessStartupAdapterModule["buildInitialStartupProfile"]>[0],
  runtime: HaystackRuntimeConfig = DEFAULT_RUNTIME_CONFIG,
): StartupPackageConfig {
  requirePackageIdentity(request);
  const legacyRequest: HarnessStartupRequest = {
    packageId: request.packageId,
    settings: request.desiredState,
    applicationEnvironment: {},
  };
  assertSupportedSettings(request.desiredState);
  runtimeConfigFrom(runtime);
  buildStartupPlan(legacyRequest);
  return { settings: request.desiredState, runtime } as unknown as StartupPackageConfig;
}

function canonicalStartupJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStartupJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalStartupJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? fail("startup profile contains a non-JSON value");
}

function buildInitialStartupProfile(
  request: Parameters<HarnessStartupAdapterModule["buildInitialStartupProfile"]>[0],
): ReturnType<HarnessStartupAdapterModule["buildInitialStartupProfile"]> {
  return { kind: "package-config", packageConfig: packageConfigForDesiredState(request) };
}

function reconcileStartupProfile(
  request: Parameters<HarnessStartupAdapterModule["reconcileStartupProfile"]>[0],
): ReturnType<HarnessStartupAdapterModule["reconcileStartupProfile"]> {
  const current = normalizeStartupRequest({
    profileKind: "package",
    packageId: request.packageId,
    harnessPackage: request.harnessPackage,
    packageConfig: request.currentPackageConfig as StartupPackageConfig,
    corporateCa: request.desiredState.corporateCa,
    applicationEnvironment: {},
  });
  const packageConfig = packageConfigForDesiredState(request, current.runtime);
  return {
    kind: "package-config",
    packageConfig,
    changed:
      canonicalStartupJson(packageConfig) !== canonicalStartupJson(request.currentPackageConfig),
  };
}

const startupAdapter: HarnessStartupAdapterModule<StartupAdapterRequest> = {
  buildStartupPlan,
  prepareStartupProfile,
  buildInitialStartupProfile,
  reconcileStartupProfile,
};

export = startupAdapter;
