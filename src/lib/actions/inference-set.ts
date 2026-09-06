// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CaptureOpenshellResult } from "../adapters/openshell/client";
import { parseHttpsPinRouteId } from "../inference/https-pin-runtime";
import { inferenceSelectionRegistryFields } from "../inference/selection";
import { resolveSandboxGatewayName } from "../onboard/gateway-binding";
import {
  assertNoOpenShellGatewayEndpointOverride,
  OpenShellGatewayEndpointOverrideError,
} from "../openshell-gateway-endpoint-guard";
import { withSandboxMutationLock } from "../state/mcp-lifecycle-lock";
import { enforceRemovedImmutabilityMigrationBoundary } from "../state/migrations/removed-immutability";
import { isSafeModelId } from "../validation";
import { resolveRuntimeInferenceApi } from "./inference-route-api";
import {
  buildInferenceRebuildCommand,
  InferenceSetError,
  OPEN_SHELL_FAILURE_CAPTURE_MAX_BUFFER,
  openshellReportsProviderNotFound,
  sanitizeInferenceProbeFailureDetail,
} from "./inference-set-error";
import {
  completeInferencePostCommit,
  finalizeInferenceMutation,
  type InferenceMutation,
} from "./inference-set-gateway-restart";
import {
  completeLegacyInferencePostCommit,
  legacyInferencePostCommit,
  readPreviousLegacyInferenceApi,
  requireLegacyInferenceAgent,
  type LegacyInferenceCompletion,
} from "./inference-set/legacy";
import {
  type InferenceSetSandboxRouteProbe,
  assertInferenceSetCommandAvailable,
  assertInferenceSetProviderOwnership,
  prepareInferenceSetProviderBinding,
  probeInferenceSetSandboxRouteUntilConverged,
  requireInferenceSetRuntimeAuthority,
} from "./inference-set-provider";
import { buildInferenceSetFailure } from "./inference-set-provider-diagnostics";
import {
  patchHermesInferenceConfig,
  patchOpenClawInferenceConfig,
  resolveLegacyAgentInferenceApi,
  type PreparedInferenceConfig,
} from "./inference-set/config";
import {
  finalizeInferenceSetRoute,
  isSandboxBridgeProviderBinding,
  prepareInferenceSetRoute,
  type RegistryInferenceMetadata,
  sandboxCustomCompatibleCredentialEnv,
  usesLoopbackNoAuthProxyRoute,
} from "./inference-set-route-containment";
import { createInferenceSetDeps } from "./inference-set/deps";
import {
  assertCompatibleAnthropicOpenAiProvider,
  assertReasoningEffortProvider,
  assertReasoningEffortRoute,
  assertRequestedInferenceApi,
  getPreferredInferenceApi,
  openshellInferenceSetArgs,
  prepareInferenceConfigPreflight,
  recordedDirectProviderBindingMismatches,
  resolveHermesContextWindowForSwitch,
  resolveInferenceConfigAuthority,
  resolveReceiptBackedInferenceApi,
  resolveScopedReasoningEffortRequest,
  updateMatchingOnboardSession,
  validateLocalInferenceProvider,
} from "./inference-set/preflight";
import {
  assertInferenceSetRuntimeAuthority,
  assertSupportedProvider,
  normalizeSandboxAgent,
  normalizeInferenceSetProvider,
  resolveTargetSandbox,
  trimRequired,
} from "./inference-set/target";
import type {
  InferenceSetDeps,
  InferenceSetOptions,
  InferenceSetResult,
} from "./inference-set/types";

export {
  ENDPOINT_URL_NOT_ALLOWED_PREFIX,
  normalizeCustomEndpointUrl,
} from "./inference-set-route-containment";
export { patchHermesInferenceConfig, patchOpenClawInferenceConfig } from "./inference-set/config";
export { readInSandboxConfigOrFail } from "./inference-set/preflight";
export {
  INFERENCE_SET_INSTALLER_PROVIDER_ALIASES,
  INFERENCE_SET_SUPPORTED_PROVIDER_NAMES,
  normalizeInferenceSetProvider,
} from "./inference-set/target";
export type {
  InferenceSetDeps,
  InferenceSetOptions,
  InferenceSetResult,
} from "./inference-set/types";
export { InferenceSetError };

interface InferenceSetMutationResult extends InferenceSetResult {
  /** Internal post-commit convergence state used before returning to the CLI caller. */
  dashboardConverged?: boolean;
}

interface PreparedInferenceMutation extends InferenceMutation<InferenceSetMutationResult> {
  readonly legacyCompletion: LegacyInferenceCompletion | null;
}

async function runInferenceSetWithoutHostLock(
  options: InferenceSetOptions,
  deps: InferenceSetDeps,
  expectedGatewayName: string,
  runtimeProvider: ReturnType<typeof requireInferenceSetRuntimeAuthority>,
): Promise<PreparedInferenceMutation> {
  // #6321: accept the installer-style provider name onboard uses (e.g.
  // `anthropicCompatible`) as well as the OpenShell provider name, by
  // normalizing to the OpenShell name before validation and all downstream use.
  const provider = normalizeInferenceSetProvider(trimRequired(options.provider, "provider"));
  const model = trimRequired(options.model, "model");
  const reasoningEffortRequest = resolveScopedReasoningEffortRequest(options.reasoningEffort);
  assertSupportedProvider(provider, model);
  assertReasoningEffortProvider(reasoningEffortRequest, provider);
  if (!isSafeModelId(model)) {
    throw new InferenceSetError(
      "Invalid model id. Model values may only contain letters, numbers, '.', '_', ':', '/', and '-'.",
      2,
    );
  }

  const { sandboxName, entry, agentName } = resolveTargetSandbox(options.sandboxName, deps);
  const priorHttpsPinRouteId = parseHttpsPinRouteId(entry.endpointUrl);
  const target = deps.resolveAgentConfig(sandboxName);
  const targetAgent = normalizeSandboxAgent(target.agentName);
  if (targetAgent !== agentName) {
    throw new InferenceSetError(
      `Sandbox '${sandboxName}' is registered as '${agentName}' but resolved config for '${target.agentName}'.`,
      2,
    );
  }
  const configUpdateSupport = deps.inspectInstalledInferenceConfigSupport(sandboxName, target);
  const { packageIdentity, receiptBackedSupport, requiredPackageApi } =
    resolveInferenceConfigAuthority({
      support: configUpdateSupport,
      entry,
      sandboxName,
      agentName,
      provider,
    });
  const session = deps.loadSession();
  const explicitInferenceApi =
    typeof options.inferenceApi === "string" && options.inferenceApi.trim()
      ? options.inferenceApi.trim()
      : null;
  assertRequestedInferenceApi({
    packageIdentity,
    agentName,
    provider,
    explicitInferenceApi,
    requiredPackageApi,
  });
  const explicitOrRecordedInferenceApi =
    explicitInferenceApi ??
    (entry.provider === provider ? (entry.preferredInferenceApi ?? null) : null);
  const resolveSelectedInferenceApi = (selectedProvider: string, preferred: string | null) =>
    receiptBackedSupport
      ? resolveReceiptBackedInferenceApi(receiptBackedSupport, selectedProvider, preferred)
      : resolveLegacyAgentInferenceApi(agentName, selectedProvider, preferred);
  const hasExplicitCustomRoute = Boolean(
    options.endpointUrl || options.credentialEnv || options.inferenceApi,
  );
  const customRoute = hasExplicitCustomRoute
    ? {
        ...options,
        // A same-provider request may omit --inference-api because the durable
        // registry row already identifies the route family. New provider
        // routes still require the operator to supply a complete identity.
        inferenceApi: resolveSelectedInferenceApi(provider, explicitOrRecordedInferenceApi),
      }
    : options;
  const routeEntry = {
    ...entry,
    preferredInferenceApi: resolveSelectedInferenceApi(
      provider,
      entry.preferredInferenceApi ?? null,
    ),
  };
  const routeSession = session
    ? {
        ...session,
        preferredInferenceApi: resolveSelectedInferenceApi(
          provider,
          session.preferredInferenceApi ?? null,
        ),
      }
    : null;
  // Registered peers are compared exactly as recorded. In particular, a
  // stopped legacy Hermes row that still records the Anthropic frontend will
  // depend on that route when restarted and must not be normalized away.
  const routeSandboxes = deps.listSandboxes().sandboxes;
  const preparedRoute = prepareInferenceSetRoute({
    entry: routeEntry,
    sandboxName,
    provider,
    model,
    customRoute,
    session: routeSession,
    sandboxes: routeSandboxes,
  });
  if (preparedRoute.gatewayName !== expectedGatewayName) {
    throw new InferenceSetError(
      `Sandbox '${sandboxName}' moved from OpenShell gateway '${expectedGatewayName}' to ` +
        `'${preparedRoute.gatewayName}' while waiting for the route mutation lock. Retry the command.`,
      2,
    );
  }

  // Explicit custom routes may start an HTTPS-pin adapter during finalization,
  // so complete config reads and package-owned preparation before that first
  // possible mutation. A failed read, stale receipt, incompatible API override,
  // or rejected adapter plan must not leave an unused route behind.
  if (preparedRoute.preliminaryExplicitMetadata) {
    assertReasoningEffortRoute(
      reasoningEffortRequest,
      provider,
      preparedRoute.preliminaryExplicitMetadata.preferredInferenceApi ?? null,
    );
  }

  const { config, preMutationInferenceApi, previousInferenceApi, preparedPackageConfig } =
    prepareInferenceConfigPreflight({
      deps,
      sandboxName,
      target,
      agentName,
      entry,
      session,
      provider,
      model,
      reasoning: reasoningEffortRequest,
      preliminaryExplicitInferenceApi:
        preparedRoute.preliminaryExplicitMetadata?.preferredInferenceApi ?? null,
      packageIdentity,
      receiptBackedSupport,
      requiredPackageApi,
    });

  const {
    registryMetadata,
    explicitPreferredInferenceApi,
    directProviderBinding,
    httpsPinProviderBinding,
  } = await finalizeInferenceSetRoute({
    prepared: preparedRoute,
    sandboxName,
    provider,
    model,
    canReuseRecordedRoute:
      entry.provider === provider &&
      typeof entry.endpointUrl === "string" &&
      entry.endpointUrl.trim().length > 0 &&
      typeof entry.preferredInferenceApi === "string" &&
      entry.preferredInferenceApi.trim().length > 0,
    onboardEndpointUrl:
      entry.provider === provider && entry.endpointSource === "onboard"
        ? (entry.endpointUrl ?? null)
        : null,
    getSandboxes: () => deps.listSandboxes().sandboxes,
    rewriteUrlWithDnsPinning: deps.rewriteConfigUrlsWithDnsPinning,
    resolveCredentialValue: deps.resolveCredentialValue,
    ensureHttpsPinRuntimeAdapter: (adapterOptions) =>
      deps.ensureHttpsPinRuntimeAdapter({
        ...adapterOptions,
        discoverAllowedSourceCidrs: () =>
          runtimeProvider.gateway
            .prepareHostRuntime({ environment: process.env, platform: process.platform })
            .network.sandboxSourceCidrs(),
      }),
    effectiveInferenceApi: preMutationInferenceApi,
  });

  // `inference set` cannot change a gateway provider's protocol type. The
  // receipt-backed path derives the required frontend from package-declared
  // provider/API metadata rather than a known harness identifier.
  if (
    requiredPackageApi === "openai-completions" ||
    (!packageIdentity && requireLegacyInferenceAgent(agentName) === "dashboard-config")
  ) {
    assertCompatibleAnthropicOpenAiProvider(
      sandboxName,
      packageIdentity ? "The installed harness package" : "Hermes",
      preparedRoute.gatewayName,
      provider,
      preMutationInferenceApi,
      registryMetadata.endpointUrl ?? null,
      deps,
      httpsPinProviderBinding ?? directProviderBinding,
    );
  }

  // Local providers (ollama-local, vllm-local) route through the sandbox-facing
  // host.openshell.internal hostname, which the host-side `openshell inference set`
  // verify cannot resolve — its default verification is a guaranteed false negative
  // on a valid route. Validate the host stack ourselves, then skip the gateway-side
  // verify. Only a genuinely-unreachable host stack hard-fails here, before the
  // route is touched.
  let effectiveNoVerify = options.noVerify === true;
  // A loopback endpoint onboarded without authentication is published to the
  // gateway through the local no-auth proxy on NemoClaw's sandbox bridge, so
  // the provider's base URL is a `host.openshell.internal` address even though
  // the registry records the operator's loopback URL. The host-side OpenShell
  // verifier cannot resolve that address; verify from inside the sandbox
  // instead, exactly like an explicit bridge route.
  const loopbackNoAuthProxyRoute = usesLoopbackNoAuthProxyRoute(entry, provider);
  const probeDirectSandboxBridge =
    isSandboxBridgeProviderBinding(directProviderBinding) || loopbackNoAuthProxyRoute;
  // Adapter routes and explicit custom routes on NemoClaw's sandbox bridge
  // resolve only from inside the sandbox network. The host-side OpenShell
  // verifier cannot resolve host.openshell.internal, so its result would be a
  // guaranteed false negative. HTTPS-pin adapters retain their local-health
  // verification; direct bridge routes are probed from the sandbox below.
  if (httpsPinProviderBinding || probeDirectSandboxBridge) {
    effectiveNoVerify = true;
  }
  if (validateLocalInferenceProvider(provider, deps)) effectiveNoVerify = true;

  const previousProvider = typeof entry.provider === "string" ? entry.provider.trim() : "";
  const previousModel = typeof entry.model === "string" ? entry.model.trim() : "";
  if (probeDirectSandboxBridge && (!previousProvider || !previousModel)) {
    throw new InferenceSetError(
      `Cannot verify the sandbox-only provider route because sandbox '${sandboxName}' does not record ` +
        "the previous provider and model needed to restore its OpenShell inference selection.",
      2,
    );
  }

  let appliedProvider = false;
  let appliedInferenceSelection = false;
  let restoredSelectionAfterProviderFailure = false;
  let providerMutation: ReturnType<typeof prepareInferenceSetProviderBinding> | null = null;
  const restorePreviousInferenceSelection = (): string | null => {
    let restoreResult: CaptureOpenshellResult;
    try {
      restoreResult = deps.captureOpenshell(
        openshellInferenceSetArgs({
          gatewayName: preparedRoute.gatewayName,
          provider: previousProvider,
          model: previousModel,
          noVerify: true,
        }),
        {
          ignoreError: true,
          includeStreams: true,
          maxBuffer: OPEN_SHELL_FAILURE_CAPTURE_MAX_BUFFER,
        },
      );
    } catch {
      return "the restore command could not be invoked";
    }
    if (restoreResult.status !== 0) {
      return `the restore command exited with status ${restoreResult.status ?? "unknown"}`;
    }
    appliedInferenceSelection = false;
    return null;
  };
  try {
    const providerBinding = httpsPinProviderBinding ?? directProviderBinding;
    if (providerBinding) {
      providerMutation = prepareInferenceSetProviderBinding({
        gatewayName: preparedRoute.gatewayName,
        providerName: provider,
        binding: providerBinding,
        captureOpenshell: deps.captureOpenshell,
        allowCreate: !loopbackNoAuthProxyRoute,
      });
      if (directProviderBinding && providerMutation.action === "update") {
        const bindingMismatches = recordedDirectProviderBindingMismatches({
          entry,
          provider,
          binding: directProviderBinding,
        });
        if (bindingMismatches.length > 0) {
          throw new InferenceSetError(
            `Cannot replace existing provider '${provider}' because the requested binding differs in: ${bindingMismatches.join(", ")}. ` +
              `OpenShell does not expose the previous provider configuration required for rollback. ` +
              `Re-run onboarding with the requested binding. If this sandbox already uses '${provider}', omit the endpoint options to switch only the model.`,
            2,
          );
        }
        // OpenShell redacts provider configuration values. The matching
        // registry route is the only durable evidence that this request does
        // not replace the provider binding.
        providerMutation = null;
      }
    } else if (loopbackNoAuthProxyRoute) {
      // A model-only switch builds no provider binding, so nothing above
      // inspects the live provider. This route's credential is the local
      // no-auth proxy token that OpenShell holds and sends on selection, and
      // its host-side verification is skipped, so confirm the durable binding
      // is still the one onboarding registered before selecting it.
      assertInferenceSetProviderOwnership({
        gatewayName: preparedRoute.gatewayName,
        providerName: provider,
        providerType: preMutationInferenceApi === "anthropic-messages" ? "anthropic" : "openai",
        credentialEnv: sandboxCustomCompatibleCredentialEnv(entry, provider),
        captureOpenshell: deps.captureOpenshell,
      });
    }
    if (providerMutation) {
      appliedProvider = providerMutation.action === "create";
      if (providerMutation.action === "update" && (!previousProvider || !previousModel)) {
        throw new InferenceSetError(
          `Cannot update existing ${httpsPinProviderBinding ? "HTTPS-pinned " : ""}provider '${provider}' because sandbox '${sandboxName}' ` +
            `does not record the previous provider and model needed to restore its inference selection.`,
          2,
        );
      }
    }

    deps.log(`  Setting OpenShell inference route: ${provider} / ${model}`);
    const setInferenceRoute = () =>
      deps.captureOpenshell(
        openshellInferenceSetArgs({
          gatewayName: preparedRoute.gatewayName,
          provider,
          model,
          noVerify: effectiveNoVerify,
        }),
        {
          ignoreError: true,
          includeStreams: true,
          maxBuffer: OPEN_SHELL_FAILURE_CAPTURE_MAX_BUFFER,
        },
      );
    let setResult = setInferenceRoute();
    if (
      setResult.status !== 0 &&
      directProviderBinding &&
      openshellReportsProviderNotFound(
        `${setResult.stderr ?? ""}\n${setResult.stdout ?? ""}`,
        provider,
      )
    ) {
      setResult = setInferenceRoute();
    }
    if (setResult.status !== 0) {
      const failure = buildInferenceSetFailure(setResult, provider, deps);
      throw new InferenceSetError(failure.message, failure.exitCode);
    }
    appliedInferenceSelection = true;
    if (providerMutation) {
      try {
        providerMutation.commit();
        appliedProvider = true;
      } catch (providerError) {
        const providerDetail =
          providerError instanceof Error ? providerError.message : String(providerError);
        const providerExitCode =
          providerError instanceof InferenceSetError ? providerError.exitCode : 1;
        const restoreFailure = restorePreviousInferenceSelection();
        if (restoreFailure) {
          throw new InferenceSetError(
            `${providerDetail}\n  Failed to restore the previous OpenShell inference selection ` +
              `'${previousProvider}' / '${previousModel}': ${restoreFailure}. ` +
              `The live selection and provider binding may be split; re-run onboarding before using this route.`,
            providerExitCode,
          );
        }
        restoredSelectionAfterProviderFailure = true;
        throw new InferenceSetError(
          `${providerDetail}\n  The previous OpenShell inference selection was restored to ` +
            `'${previousProvider}' / '${previousModel}'. Provider state may still be partial; ` +
            `retry this command or re-run onboarding to reconcile it.`,
          providerExitCode,
        );
      }
    }

    if (probeDirectSandboxBridge) {
      let probe: ReturnType<InferenceSetSandboxRouteProbe>;
      try {
        probe = await probeInferenceSetSandboxRouteUntilConverged(
          {
            input: {
              sandboxName,
              provider,
              model,
              preferredInferenceApi: preMutationInferenceApi,
            },
            previousProvider,
            previousModel,
            previousInferenceApi,
            targetInferenceApi: preMutationInferenceApi,
          },
          {
            probe: deps.probeSandboxRoute,
            sleep: deps.sleep,
            onRetry: (result, delayMs, attempt) => {
              if (result.ok) return;
              deps.log(
                `  Waiting ${delayMs / 1_000}s for OpenShell route convergence after HTTP ${result.httpStatus} (probe ${attempt}/3)...`,
              );
            },
          },
        );
      } catch (probeError) {
        const probeFailureDetail =
          probeError instanceof Error && probeError.message
            ? sanitizeInferenceProbeFailureDetail(probeError.message)
            : "";
        probe = {
          ok: false,
          detail: probeFailureDetail
            ? `sandbox inference invocation probe was unavailable: ${probeFailureDetail}`
            : "sandbox inference invocation probe was unavailable",
          httpStatus: null,
        };
      }
      if (!probe.ok) {
        const restoreFailure = restorePreviousInferenceSelection();
        if (restoreFailure) {
          throw new InferenceSetError(
            `Sandbox-side verification rejected provider '${provider}' / '${model}': ${probe.detail}. ` +
              `Failed to restore the previous OpenShell inference selection '${previousProvider}' / ` +
              `'${previousModel}': ${restoreFailure}. Re-run onboarding before using this route.`,
          );
        }
        throw new InferenceSetError(
          `Sandbox-side verification rejected provider '${provider}' / '${model}': ${probe.detail}. ` +
            `The previous OpenShell inference selection was restored to '${previousProvider}' / '${previousModel}'.`,
        );
      }
    }

    // Write minimal registry state before any sandbox-facing config read so the
    // gateway and registry cannot split if the in-sandbox layer is unavailable.
    const registryFields = (preferredInferenceApi: string | null) =>
      inferenceSelectionRegistryFields({
        provider,
        model,
        endpointUrl: registryMetadata.endpointUrl ?? null,
        endpointSource: registryMetadata.endpointSource ?? null,
        credentialEnv: registryMetadata.credentialEnv ?? null,
        preferredInferenceApi,
        compatibleEndpointReasoningEffort:
          provider === "compatible-endpoint" && preferredInferenceApi === "openai-completions"
            ? reasoningEffortRequest.explicit
              ? reasoningEffortRequest.effort
              : (entry.compatibleEndpointReasoningEffort ?? null)
            : null,
        nimContainer: registryMetadata.nimContainer ?? null,
      });
    if (
      !deps.updateSandbox(
        sandboxName,
        registryFields(
          resolveSelectedInferenceApi(provider, registryMetadata.preferredInferenceApi ?? null),
        ),
      )
    ) {
      throw new InferenceSetError(
        `Failed to update NemoClaw registry for sandbox '${sandboxName}'.`,
      );
    }

    const previousOpenClawInferenceApi = packageIdentity
      ? null
      : readPreviousLegacyInferenceApi(agentName, config);
    const preferredInferenceApi =
      explicitPreferredInferenceApi ??
      (receiptBackedSupport
        ? preMutationInferenceApi
        : resolveRuntimeInferenceApi({
            agentName,
            config,
            currentProvider: entry.provider,
            provider,
            sandboxName,
            session,
          }));
    const effectiveRegistryMetadata: RegistryInferenceMetadata = {
      ...registryMetadata,
      preferredInferenceApi,
    };
    // Refresh the registry with config-derived API-family metadata before the
    // crash-prone in-sandbox sync (#3725/#3726). Explicit operator-supplied
    // metadata remains authoritative when present.
    if (!deps.updateSandbox(sandboxName, registryFields(preferredInferenceApi))) {
      throw new InferenceSetError(
        `Failed to update NemoClaw registry for sandbox '${sandboxName}'.`,
      );
    }

    const currentHttpsPinRouteId = parseHttpsPinRouteId(registryMetadata.endpointUrl);
    if (priorHttpsPinRouteId && priorHttpsPinRouteId !== currentHttpsPinRouteId) {
      try {
        const peerStillReferencesRoute = deps
          .listSandboxes()
          .sandboxes.some(
            (candidate) =>
              candidate.name !== sandboxName &&
              parseHttpsPinRouteId(candidate.endpointUrl) === priorHttpsPinRouteId,
          );
        if (!peerStillReferencesRoute) {
          const revoked = await deps.revokeHttpsPinRuntimeAdapterRoute(priorHttpsPinRouteId);
          if (!revoked) throw new Error("the adapter did not confirm route revocation");
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        deps.log(
          `  Warning: the new inference route is committed, but superseded HTTPS Pin Runtime route ` +
            `'${priorHttpsPinRouteId}' could not be revoked: ${detail}. The raw upstream endpoint was not restored; ` +
            `uninstall NemoClaw to stop the adapter and purge its in-memory credentials if this persists.`,
        );
      }
    }

    let patched: PreparedInferenceConfig;
    if (preparedPackageConfig) {
      patched = preparedPackageConfig;
    } else if (requireLegacyInferenceAgent(agentName) === "dashboard-config") {
      const contextWindow = resolveHermesContextWindowForSwitch(provider, model, deps);
      const legacyPatch = patchHermesInferenceConfig(
        config,
        provider,
        model,
        preferredInferenceApi,
        contextWindow,
      );
      patched = {
        ...legacyPatch,
        config,
        postCommit: legacyInferencePostCommit(agentName, previousOpenClawInferenceApi),
      };
    } else {
      // Recompute the context window for the model being switched to, so it does
      // not inherit the prior model's window (#context-window-on-switch).
      const contextWindow = deps.resolveContextWindowForModel(provider, model);
      if (contextWindow != null) {
        deps.log(`  Context window for '${model}': ${contextWindow} tokens`);
      } else {
        deps.log(
          `  Warning: could not determine the context window for '${model}'; keeping the ` +
            `existing value. Run '${buildInferenceRebuildCommand(sandboxName)}' to re-probe it.`,
        );
      }
      const legacyPatch = patchOpenClawInferenceConfig(
        config,
        provider,
        model,
        preferredInferenceApi || getPreferredInferenceApi(config),
        contextWindow ?? undefined,
        provider,
        reasoningEffortRequest,
      );
      patched = {
        ...legacyPatch,
        config,
        postCommit: legacyInferencePostCommit(agentName, previousOpenClawInferenceApi),
      };
    }

    deps.log(
      `  Syncing ${packageIdentity ? "package-owned" : agentName} model configuration in sandbox '${sandboxName}'...`,
    );
    // In-sandbox config is the last, crash-prone layer (gateway + registry already consistent).
    // OpenClaw keeps its existing degraded result on failure. Hermes finalizes the committed
    // route and registry, then returns an error so automation cannot accept partial convergence.
    // Two degraded states, both fixed by `rebuild` (regenerates openclaw.json + .config-hash from registry):
    //   - write fails:           config left old (old .config-hash still matches it)
    //   - hash recompute fails:  config new but .config-hash stale -> integrity-guard mismatch
    let inSandboxConfigSynced = false;
    try {
      deps.writeSandboxConfig(sandboxName, target, patched.config);
      try {
        // A receipt-backed package owns its complete configuration transaction,
        // including any native integrity marker. The pathname-based pass below
        // exists only for legacy sandboxes whose config writer predates the
        // package contract.
        if (!packageIdentity) deps.recomputeSandboxConfigHash(sandboxName, target);
        inSandboxConfigSynced = true;
      } catch (hashError) {
        const detail =
          hashError instanceof Error && hashError.message ? hashError.message : String(hashError);
        deps.log(
          `  Warning: wrote the in-sandbox config for '${sandboxName}' but failed to refresh its ` +
            `integrity hash: ${detail}`,
        );
        deps.log(
          `  Run '${buildInferenceRebuildCommand(sandboxName)}' to resync the in-sandbox config.`,
        );
      }
    } catch (writeError) {
      const detail =
        writeError instanceof Error && writeError.message ? writeError.message : String(writeError);
      deps.log(
        `  Warning: gateway and registry now use ${provider} / ${model}, but writing the ` +
          `in-sandbox config failed: ${detail}`,
      );
      deps.log(
        `  Run '${buildInferenceRebuildCommand(sandboxName)}' to finish applying the model inside the sandbox.`,
      );
    }
    // Hermes keeps an isolated dashboard profile config that only mirrors the gateway
    // config's model routing at sandbox startup. Re-seed it after an in-place
    // switch so Dashboard Chat (and /api/model/info) converge on the new model
    // instead of silently staying on the previous one (#6893).
    //   - "converged": dashboard now matches the switch.
    //   - "absent":    Dashboard disabled — nothing to converge, still a success.
    //   - "failed":    warn and fail after the committed mutation is finalized so
    //                  callers cannot accept a partially converged switch.
    let dashboardConverged: boolean | undefined;
    if (
      !packageIdentity &&
      requireLegacyInferenceAgent(agentName) === "dashboard-config" &&
      inSandboxConfigSynced
    ) {
      const reseed = deps.seedHermesDashboardConfig(sandboxName, target);
      dashboardConverged = reseed !== "failed";
      if (reseed === "failed") {
        deps.log(
          `  Warning: updated the model route but could not refresh the dashboard ` +
            `config for '${sandboxName}'. Restart the sandbox to converge Dashboard Chat.`,
        );
      }
    }
    const sessionUpdated = updateMatchingOnboardSession(
      sandboxName,
      provider,
      model,
      patched.route,
      effectiveRegistryMetadata,
      deps,
      reasoningEffortRequest,
    );

    const legacyPairingRequired =
      !packageIdentity &&
      requireLegacyInferenceAgent(agentName) === "gateway-config" &&
      patched.changed &&
      inSandboxConfigSynced;
    const mutation = finalizeInferenceMutation(
      {
        additionalPostCommitRequired: legacyPairingRequired || dashboardConverged === false,
        agentName,
        configChanged: patched.changed,
        nextApi: patched.route.inferenceApi,
        packageIdentity,
        postCommit: patched.postCommit,
        result: {
          sandboxName,
          provider,
          model,
          primaryModelRef: patched.route.primaryModelRef,
          providerKey: patched.route.providerKey,
          configChanged: patched.changed,
          sessionUpdated,
          inSandboxConfigSynced,
          dashboardConverged,
        },
      },
      deps,
    );
    if (patched.postCommit.configSync === "required" && !inSandboxConfigSynced) {
      throw new InferenceSetError(
        `${packageIdentity ? "Inference route" : "Hermes inference route"} synchronization did not complete for '${sandboxName}'. ` +
          `The OpenShell route and NemoClaw registry remain committed, but the in-sandbox ` +
          `${packageIdentity ? "package" : "Hermes"} configuration did not fully converge. Run '${buildInferenceRebuildCommand(sandboxName)}' to converge it.`,
      );
    }
    return {
      ...mutation,
      legacyCompletion: legacyPairingRequired
        ? {
            target: {
              sandboxName,
              gatewayName: expectedGatewayName,
              openclawVersion: entry.agentVersion ?? "",
              stateDirectory: target.configDir,
            },
            gatewayRestartRequired: mutation.gatewayRestartRequired,
            result: mutation.result,
          }
        : null,
    };
  } catch (error) {
    if (!providerMutation) throw error;
    if (restoredSelectionAfterProviderFailure) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    const exitCode = error instanceof InferenceSetError ? error.exitCode : 1;
    if (!appliedInferenceSelection) {
      try {
        providerMutation.rollback();
      } catch (rollbackError) {
        const rollbackDetail =
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new InferenceSetError(
          `${detail}\n  ${rollbackDetail} Re-run onboarding before retrying this switch.`,
          exitCode,
        );
      }
      const unchanged =
        providerMutation.action === "create"
          ? "The newly created OpenShell provider was removed; the inference selection was not changed."
          : "The existing OpenShell provider binding and inference selection were not changed.";
      throw new InferenceSetError(`${detail}\n  ${unchanged}`, exitCode);
    }
    const residual = appliedProvider
      ? httpsPinProviderBinding
        ? "The OpenShell provider and inference selection remain committed to the safer HTTPS-pinned adapter, but NemoClaw state may not have converged. Retry this command; if convergence still fails, rebuild the sandbox."
        : "The OpenShell provider and inference selection remain committed, but NemoClaw state may not have converged. Retry this command; if convergence still fails, rebuild the sandbox."
      : httpsPinProviderBinding
        ? "The inference selection changed, but the HTTPS-pinned provider binding did not converge. Retry this command immediately; if convergence still fails, rebuild the sandbox."
        : "The inference selection changed, but the OpenShell provider binding did not converge. Retry this command immediately; if convergence still fails, rebuild the sandbox.";
    throw new InferenceSetError(`${detail}\n  ${residual}`, exitCode);
  }
}

export async function runInferenceSet(
  options: InferenceSetOptions,
  deps: InferenceSetDeps = createInferenceSetDeps(),
): Promise<InferenceSetResult> {
  try {
    const provider = normalizeInferenceSetProvider(trimRequired(options.provider, "provider"));
    assertReasoningEffortProvider(
      resolveScopedReasoningEffortRequest(options.reasoningEffort),
      provider,
    );
  } catch (error) {
    throw new InferenceSetError(error instanceof Error ? error.message : String(error), 2);
  }
  try {
    assertNoOpenShellGatewayEndpointOverride();
  } catch (error) {
    if (error instanceof OpenShellGatewayEndpointOverrideError) {
      throw new InferenceSetError(error.message, 2);
    }
    throw error;
  }
  // Resolve once before acquiring so a default-sandbox change cannot make the
  // protected callback mutate a different sandbox from the one whose lock we
  // hold. Prime the default OpenShell runner before acquiring too: its legacy
  // missing-binary path exits the process, which cannot be deferred safely by
  // an async lock. The inner resolution still validates the live registry entry.
  const selected = resolveTargetSandbox(options.sandboxName, deps);
  try {
    enforceRemovedImmutabilityMigrationBoundary(selected.sandboxName);
  } catch (error) {
    throw new InferenceSetError(error instanceof Error ? error.message : String(error), 2);
  }
  assertInferenceSetRuntimeAuthority(selected.entry, deps.runtimeProviders);
  assertInferenceSetCommandAvailable(selected.sandboxName);
  deps.prepareRunOpenshell();
  return withSandboxMutationLock(selected.sandboxName, async () => {
    enforceRemovedImmutabilityMigrationBoundary(selected.sandboxName);
    assertInferenceSetCommandAvailable(selected.sandboxName);
    const lockedSelection = resolveTargetSandbox(selected.sandboxName, deps);
    const runtimeProvider = assertInferenceSetRuntimeAuthority(
      lockedSelection.entry,
      deps.runtimeProviders,
    );
    const gatewayName = resolveSandboxGatewayName(lockedSelection.entry);
    const mutation = await deps.withGatewayRouteMutationLock(gatewayName, () =>
      runInferenceSetWithoutHostLock(
        { ...options, sandboxName: selected.sandboxName },
        deps,
        gatewayName,
        runtimeProvider,
      ),
    );
    // Retain the outer sandbox lifecycle lock so another process cannot replace
    // this sandbox between the committed write, an optional restart, and
    // device-scope convergence.
    completeInferencePostCommit(mutation, deps);
    if (mutation.legacyCompletion) {
      completeLegacyInferencePostCommit(mutation.legacyCompletion, deps);
    }
    if (mutation.result.dashboardConverged === false) {
      throw new InferenceSetError(
        `Inference route and main package config were updated for '${mutation.result.sandboxName}', ` +
          `but the Dashboard config did not converge. The committed route was not rolled back. ` +
          `Restart the sandbox to converge Dashboard Chat.`,
      );
    }
    return mutation.result;
  });
}
