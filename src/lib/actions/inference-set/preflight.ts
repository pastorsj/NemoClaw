// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { harnessPackageIdentitiesEqual } from "../../agent-runtime/package/identity-validation";
import type { HarnessInferenceApi } from "../../agent-runtime/config-module";
import type { HarnessPackageIdentity } from "../../agent-runtime/package/types";
import { isBedrockRuntimeEndpoint } from "../../inference/bedrock-runtime";
import {
  type ReasoningEffortRequest,
  resolveReasoningEffortRequest,
} from "../../inference/selection";
import {
  matchesGatewayProviderBinding,
  parseGatewayProviderMetadata,
} from "../../onboard/gateway-provider-metadata";
import { type AgentConfigTarget, SandboxConfigError } from "../../sandbox/config";
import type { InstalledInferenceConfigSupport } from "../../sandbox/package-config";
import type { ConfigObject } from "../../security/credential-filter";
import { isConfigObject } from "../../security/credential-filter";
import type { Session } from "../../state/onboard-session";
import type { SandboxEntry } from "../../state/registry";
import { resolveRuntimeInferenceApi } from "../inference-route-api";
import {
  buildInferenceRebuildCommand,
  InferenceSetError,
  OPEN_SHELL_FAILURE_CAPTURE_MAX_BUFFER,
} from "../inference-set-error";
import { assertLegacyRequestedInferenceApi, requireLegacyInferenceAgent } from "./legacy";
import {
  getInferenceSelectionConfig,
  preparePackageInferenceConfig,
  resolveManagedInferenceRoute,
  type PreparedInferenceConfig,
  type SandboxInferenceConfig,
} from "./config";
import type {
  InferenceSetProviderBinding,
  RegistryInferenceMetadata,
} from "../inference-set-route-containment";
import type { InferenceSetDeps } from "./types";

export function resolveHermesContextWindowForSwitch(
  provider: string,
  model: string,
  deps: Pick<InferenceSetDeps, "resolveContextWindowForModel" | "log">,
): number | undefined {
  const contextWindow = deps.resolveContextWindowForModel(provider, model);
  if (contextWindow != null) {
    deps.log(`  Context window for '${model}': ${contextWindow} tokens`);
    return contextWindow;
  }
  deps.log(
    `  Warning: could not determine the context window for '${model}'; omitting ` +
      `context_length so Hermes can discover it from the selected model.`,
  );
  return undefined;
}

export function updateMatchingOnboardSession(
  sandboxName: string,
  provider: string,
  model: string,
  route: SandboxInferenceConfig,
  registryMetadata: RegistryInferenceMetadata,
  deps: Pick<InferenceSetDeps, "loadSession" | "updateSession">,
  reasoningEffort: ReasoningEffortRequest = { effort: null, explicit: false },
): boolean {
  const session = deps.loadSession();
  if (!session || session.sandboxName !== sandboxName) return false;
  deps.updateSession((current) => {
    if (current.sandboxName !== sandboxName) return current;
    current.provider = provider;
    current.model = model;
    current.endpointUrl =
      registryMetadata.endpointUrl ??
      getInferenceSelectionConfig(provider, model)?.endpointUrl ??
      current.endpointUrl;
    current.credentialEnv =
      registryMetadata.credentialEnv ??
      getInferenceSelectionConfig(provider, model)?.credentialEnv ??
      current.credentialEnv;
    current.preferredInferenceApi = registryMetadata.preferredInferenceApi ?? route.inferenceApi;
    if (provider !== "compatible-endpoint" || route.inferenceApi !== "openai-completions") {
      current.compatibleEndpointReasoningEffort = null;
    } else if (reasoningEffort.explicit) {
      current.compatibleEndpointReasoningEffort = reasoningEffort.effort;
    }
    current.nimContainer = registryMetadata.nimContainer ?? null;
    return current;
  });
  return true;
}

export function resolveScopedReasoningEffortRequest(value: unknown): ReasoningEffortRequest {
  return resolveReasoningEffortRequest(value);
}

export function assertReasoningEffortProvider(
  request: ReasoningEffortRequest,
  provider: string,
): void {
  if (!request.explicit || provider === "compatible-endpoint") return;
  throw new InferenceSetError(
    "--reasoning-effort applies only to the compatible-endpoint provider.",
    2,
  );
}

export function assertReasoningEffortRoute(
  request: ReasoningEffortRequest,
  provider: string,
  inferenceApi: string | null,
): void {
  assertReasoningEffortProvider(request, provider);
  if (!request.explicit) return;
  if (inferenceApi !== "openai-completions") {
    throw new InferenceSetError(
      "--reasoning-effort applies only to compatible-endpoint routes using openai-completions.",
      2,
    );
  }
}

export function resolveReceiptBackedInferenceApi(
  support: Extract<InstalledInferenceConfigSupport, { kind: "mutable" }>,
  provider: string | null | undefined,
  preferredInferenceApi: string | null,
): string | null {
  const override = support.providerApiOverrides.find(
    (candidate) => candidate.provider === provider,
  );
  return override?.api ?? preferredInferenceApi;
}

function resolveReceiptBackedInferenceRoute(options: {
  model: string;
  provider: string;
  preferredInferenceApi: string | null;
  requiredPackageApi: HarnessInferenceApi | undefined;
}): SandboxInferenceConfig {
  const route = resolveManagedInferenceRoute(
    options.model,
    options.provider,
    options.preferredInferenceApi,
  );
  if (options.requiredPackageApi && route.inferenceApi !== options.requiredPackageApi) {
    throw new InferenceSetError(
      `The installed harness package requires the managed ${options.requiredPackageApi} frontend for provider '${options.provider}', ` +
        `but NemoClaw routes that provider through ${route.inferenceApi}. ` +
        "The package provider/API override is incompatible with this provider route.",
      2,
    );
  }
  return route;
}

export function resolveInferenceConfigAuthority(options: {
  support: InstalledInferenceConfigSupport;
  entry: SandboxEntry;
  sandboxName: string;
  agentName: string;
  provider: string;
}): {
  packageIdentity: HarnessPackageIdentity | null;
  receiptBackedSupport: Extract<InstalledInferenceConfigSupport, { kind: "mutable" }> | null;
  requiredPackageApi: HarnessInferenceApi | undefined;
} {
  if (options.support.kind === "unsupported") {
    throw new InferenceSetError(
      `Inference configuration is not mutable for '${options.agentName}': ${options.support.reason}`,
      2,
    );
  }
  const packageIdentity = options.entry.harnessPackage ?? null;
  if (packageIdentity && packageIdentity.id !== options.agentName) {
    throw new InferenceSetError(
      `Sandbox '${options.sandboxName}' package receipt does not match its registered agent.`,
      2,
    );
  }
  if (packageIdentity && options.support.kind === "legacy") {
    throw new InferenceSetError(
      `Sandbox '${options.sandboxName}' has a package receipt but no receipt-backed inference configuration authority.`,
      2,
    );
  }
  if (!packageIdentity) requireLegacyInferenceAgent(options.agentName);
  const receiptBackedSupport =
    packageIdentity && options.support.kind === "mutable" ? options.support : null;
  return {
    packageIdentity,
    receiptBackedSupport,
    requiredPackageApi: receiptBackedSupport?.providerApiOverrides.find(
      (candidate) => candidate.provider === options.provider,
    )?.api,
  };
}

export function assertRequestedInferenceApi(options: {
  packageIdentity: HarnessPackageIdentity | null;
  agentName: string;
  provider: string;
  explicitInferenceApi: string | null;
  requiredPackageApi: HarnessInferenceApi | undefined;
}): void {
  if (
    options.requiredPackageApi &&
    options.explicitInferenceApi !== null &&
    options.explicitInferenceApi !== options.requiredPackageApi
  ) {
    throw new InferenceSetError(
      `The installed harness package requires the managed ${options.requiredPackageApi} frontend for provider '${options.provider}'. ` +
        `Set --inference-api ${options.requiredPackageApi} or omit --inference-api so NemoClaw selects it.`,
      2,
    );
  }
  if (!options.packageIdentity) assertLegacyRequestedInferenceApi(options);
}

export function prepareInferenceConfigPreflight(options: {
  deps: InferenceSetDeps;
  sandboxName: string;
  target: AgentConfigTarget;
  agentName: string;
  entry: SandboxEntry;
  session: Session | null;
  provider: string;
  model: string;
  reasoning: ReasoningEffortRequest;
  preliminaryExplicitInferenceApi: string | null;
  packageIdentity: HarnessPackageIdentity | null;
  receiptBackedSupport: Extract<InstalledInferenceConfigSupport, { kind: "mutable" }> | null;
  requiredPackageApi: HarnessInferenceApi | undefined;
}): {
  config: ConfigObject;
  preMutationInferenceApi: string | null;
  previousInferenceApi: string | null;
  preparedPackageConfig: PreparedInferenceConfig | null;
} {
  const config = readInSandboxConfigOrFail(options.deps, options.sandboxName, options.target);
  const preMutationInferenceApi =
    options.preliminaryExplicitInferenceApi ??
    (options.receiptBackedSupport
      ? resolveReceiptBackedInferenceApi(
          options.receiptBackedSupport,
          options.provider,
          options.entry.provider === options.provider
            ? (options.entry.preferredInferenceApi ??
                options.session?.preferredInferenceApi ??
                null)
            : null,
        )
      : resolveRuntimeInferenceApi({
          agentName: options.agentName,
          config,
          currentProvider: options.entry.provider,
          provider: options.provider,
          sandboxName: options.sandboxName,
          session: options.session,
        }));
  const previousInferenceApi = options.receiptBackedSupport
    ? resolveReceiptBackedInferenceApi(
        options.receiptBackedSupport,
        options.entry.provider,
        options.entry.preferredInferenceApi ?? options.session?.preferredInferenceApi ?? null,
      )
    : resolveRuntimeInferenceApi({
        agentName: options.agentName,
        config,
        currentProvider: options.entry.provider,
        provider: options.entry.provider ?? "",
        sandboxName: options.sandboxName,
        session: options.session,
      });
  assertReasoningEffortRoute(options.reasoning, options.provider, preMutationInferenceApi);

  if (!options.packageIdentity) {
    return { config, preMutationInferenceApi, previousInferenceApi, preparedPackageConfig: null };
  }
  const currentPackageIdentity =
    options.deps.getSandbox(options.sandboxName)?.harnessPackage ?? null;
  if (!harnessPackageIdentitiesEqual(options.packageIdentity, currentPackageIdentity)) {
    throw new InferenceSetError(
      `Sandbox '${options.sandboxName}' package receipt changed before inference configuration was prepared. Retry the command.`,
      2,
    );
  }
  const packageRoute = resolveReceiptBackedInferenceRoute({
    model: options.model,
    provider: options.provider,
    preferredInferenceApi: preMutationInferenceApi,
    requiredPackageApi: options.requiredPackageApi,
  });
  const contextWindow = options.deps.resolveContextWindowForModel(options.provider, options.model);
  if (contextWindow !== null) {
    options.deps.log(`  Context window for '${options.model}': ${String(contextWindow)} tokens`);
  } else {
    options.deps.log(
      `  Warning: could not determine the context window for '${options.model}'; the package adapter will preserve its runtime-specific fallback.`,
    );
  }
  const preparedPackageConfig = preparePackageInferenceConfig({
    identity: options.packageIdentity,
    target: options.target,
    config,
    route: packageRoute,
    provider: options.provider,
    model: options.model,
    contextWindow,
    reasoning: options.reasoning,
    deps: options.deps,
  });
  return { config, preMutationInferenceApi, previousInferenceApi, preparedPackageConfig };
}

export function validateLocalInferenceProvider(
  provider: string,
  deps: Pick<
    InferenceSetDeps,
    "isLocalInferenceProvider" | "validateLocalProvider" | "ensureLocalProviderReachable" | "log"
  >,
): boolean {
  if (!deps.isLocalInferenceProvider(provider)) return false;
  const localValidation = deps.validateLocalProvider(provider);
  if (localValidation.ok) return true;
  if (deps.ensureLocalProviderReachable(provider)) {
    if (localValidation.message) deps.log(`  ⚠ ${localValidation.message}`);
    deps.log(
      "  Host inference service is reachable — proceeding. The sandbox reaches it " +
        "through the gateway route at runtime; host-side verification cannot resolve " +
        "the container hostname, so it is skipped.",
    );
    return true;
  }
  throw new InferenceSetError(
    `Cannot reach local provider '${provider}': ${
      localValidation.message ?? "the host inference service is not responding."
    }${localValidation.diagnostic ? `\n  Diagnostic: ${localValidation.diagnostic}` : ""}`,
    1,
  );
}

export function openshellInferenceSetArgs(options: {
  gatewayName: string;
  provider: string;
  model: string;
  noVerify?: boolean;
}): string[] {
  const args = [
    "inference",
    "set",
    "-g",
    options.gatewayName,
    "--provider",
    options.provider,
    "--model",
    options.model,
  ];
  if (options.noVerify) args.push("--no-verify");
  return args;
}

export function recordedDirectProviderBindingMismatches(options: {
  entry: SandboxEntry;
  provider: string;
  binding: InferenceSetProviderBinding;
}): string[] {
  return [
    options.entry.provider === options.provider ? null : "provider",
    options.entry.endpointUrl === options.binding.baseUrl ? null : "endpoint URL",
    options.entry.credentialEnv === options.binding.credentialEnv
      ? null
      : "credential environment variable",
  ].filter((field): field is string => field !== null);
}

export function getPreferredInferenceApi(config: ConfigObject): string | null {
  const models = config.models;
  if (!isConfigObject(models)) return null;
  const providers = models.providers;
  if (!isConfigObject(providers)) return null;
  const inferenceProvider = providers.inference;
  if (!isConfigObject(inferenceProvider)) return null;
  return typeof inferenceProvider.api === "string" ? inferenceProvider.api : null;
}

export function assertCompatibleAnthropicOpenAiProvider(
  sandboxName: string,
  runtimeLabel: string,
  gatewayName: string,
  provider: string,
  inferenceApi: string | null,
  endpointUrl: string | null,
  deps: InferenceSetDeps,
  httpsPinProviderBinding: {
    providerType: "openai" | "anthropic";
  } | null = null,
): void {
  if (
    provider !== "compatible-anthropic-endpoint" ||
    inferenceApi !== "openai-completions" ||
    isBedrockRuntimeEndpoint(endpointUrl)
  ) {
    return;
  }
  if (httpsPinProviderBinding?.providerType === "openai") return;

  const result = deps.captureOpenshell(["provider", "get", "-g", gatewayName, provider], {
    ignoreError: true,
    includeStreams: true,
    maxBuffer: OPEN_SHELL_FAILURE_CAPTURE_MAX_BUFFER,
  });
  const output = result.output || `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const metadata = result.status === 0 ? parseGatewayProviderMetadata(output) : null;
  if (
    matchesGatewayProviderBinding(metadata, {
      name: provider,
      type: "openai",
      credentialKey: "COMPATIBLE_ANTHROPIC_API_KEY",
      configKey: "OPENAI_BASE_URL",
    })
  ) {
    return;
  }

  throw new InferenceSetError(
    `${runtimeLabel} requires provider '${provider}' to be registered on its verified OpenAI-compatible surface. ` +
      `Run '${buildInferenceRebuildCommand(sandboxName)}' to migrate this sandbox, or re-run onboarding for the endpoint before using inference set.`,
    2,
  );
}

/**
 * Read the in-sandbox agent config, converting a `SandboxConfigError` (the
 * in-sandbox config could not be read or parsed — most commonly because the
 * sandbox container is stopped) into a clean `InferenceSetError`. Callers use
 * this as a pre-flight gate before the gateway route and registry are mutated,
 * so an unreadable config aborts the command cleanly instead of crashing with a
 * raw stack after a half-applied switch (#6997).
 */
export function readInSandboxConfigOrFail(
  deps: Pick<InferenceSetDeps, "readSandboxConfig">,
  sandboxName: string,
  target: AgentConfigTarget,
): ConfigObject {
  try {
    return deps.readSandboxConfig(sandboxName, target);
  } catch (error) {
    if (error instanceof SandboxConfigError) {
      const lines = [...error.lines];
      // `readSandboxConfig` also raises this for a corrupt/unparseable config,
      // which starting the sandbox would NOT fix — only add the start hint for
      // the stopped-sandbox case (the one that asks "Is the sandbox running?").
      if (lines.some((line) => /is the sandbox running/i.test(line))) {
        lines.push("  Start the sandbox and retry.");
      }
      throw new InferenceSetError(lines.join("\n"), error.exitCode);
    }
    throw error;
  }
}
