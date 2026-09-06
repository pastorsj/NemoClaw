// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";

import {
  createSession,
  type Session,
  type SessionUpdates,
} from "../../src/lib/state/onboard-session";
import {
  type CoreOnboardFlowPhases,
  createProviderInferenceOnboardFlowPhase,
  createSandboxOnboardFlowPhase,
  type EndpointProvenanceOptions,
  type ProviderInferenceOnboardFlowPhaseOptions,
  type SandboxOnboardFlowPhaseOptions,
} from "../../src/lib/onboard/machine/core-flow-phases";
import type { OnboardFlowContext } from "../../src/lib/onboard/machine/flow-context";
import type { OnboardPrerequisiteRepairEventRecorder } from "../../src/lib/onboard/machine/prerequisite-repair";

type Agent = { name: string };
type Gpu = { platform: string };
type SandboxGpuConfig = { mode: string };
export type CoreContext = OnboardFlowContext<Agent, Gpu, SandboxGpuConfig>;
type TestHost = { memoryGb: number };
export type ProviderOptions = ProviderInferenceOnboardFlowPhaseOptions<CoreContext, TestHost>;
type SandboxOptions = SandboxOnboardFlowPhaseOptions<CoreContext>;

export function context(
  patch: Partial<OnboardFlowContext<Agent, Gpu, SandboxGpuConfig>> = {},
): OnboardFlowContext<Agent, Gpu, SandboxGpuConfig> {
  return {
    resume: false,
    fresh: false,
    session: createSession(),
    agent: { name: "openclaw" },
    recordedSandboxName: null,
    requestedSandboxName: null,
    sandboxName: "my-sandbox",
    fromDockerfile: null,
    model: null,
    provider: null,
    endpointUrl: null,
    credentialEnv: null,
    hermesAuthMethod: null,
    hermesToolGateways: [],
    preferredInferenceApi: null,
    compatibleEndpointReasoning: null,

    compatibleEndpointReasoningEffort: null,
    nimContainer: null,
    webSearchConfig: null,
    webSearchSupported: false,
    selectedMessagingChannels: ["slack"],
    gpu: { platform: "linux" },
    sandboxGpuConfig: { mode: "cdi" },
    gpuPassthrough: true,
    ...patch,
  };
}

export function sessionWithUpdates(updates: SessionUpdates = {}): Session {
  const session = createSession();
  Object.assign(session, updates);
  if (updates.metadata) session.metadata = { ...session.metadata, ...updates.metadata };
  return session;
}

export function completeStep(): Session["steps"][string] {
  return {
    status: "complete",
    startedAt: "2026-06-09T00:00:00.000Z",
    completedAt: "2026-06-09T00:01:00.000Z",
    error: null,
  };
}

export function repairRecorder(events: string[] = []): OnboardPrerequisiteRepairEventRecorder {
  return async (type, options) => {
    events.push(`${type}:${options.state ?? "unknown"}`);
  };
}

export function createPhases(
  overrides: {
    endpointProvenance?: Partial<EndpointProvenanceOptions>;
    inspectSandboxForCreate?: ProviderOptions["inspectSandboxForCreate"];
    providerEnv?: NodeJS.ProcessEnv;
    providerDeps?: Partial<ProviderOptions["deps"]>;
    sandboxOptions?: Partial<Omit<SandboxOptions, "deps">>;
    sandboxDeps?: Partial<SandboxOptions["deps"]>;
  } = {},
): CoreOnboardFlowPhases<CoreContext> {
  const getSandboxRegistryEntry = () => ({
    name: "my-sandbox",
    provider: "nim",
    model: "nvidia/test",
    endpointUrl: "https://example.test/v1",
    credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    preferredInferenceApi: "chat",
    gatewayName: "nemoclaw",
    gpuEnabled: false,
  });
  const endpointProvenance = {
    getSandboxRegistryEntry,
    ...overrides.endpointProvenance,
  };
  const providerInference = createProviderInferenceOnboardFlowPhase<CoreContext, TestHost>({
    gatewayName: "nemoclaw",
    forceProviderSelection: false,
    inspectSandboxForCreate:
      overrides.inspectSandboxForCreate ??
      (() => ({ existingEntry: null, preservedMcpState: undefined, liveExists: false })),
    apfInterceptorRequested: overrides.sandboxOptions?.apfInterceptorRequested === true,
    endpointProvenance,
    env: overrides.providerEnv ?? {},
    constants: {
      hermesProviderName: "hermes",
      hermesApiKeyAuthMethod: "api_key",
      hermesApiKeyCredentialEnv: "HERMES_API_KEY",
    },
    deps: {
      checkGatewayRouteCompatibility: () => ({ ok: true }),
      preflightGatewayRouteDiscovery: () => ({
        ok: true,
        requiredModel: null,
        requiredEndpointUrl: null,
        requiredInferenceApi: null,
      }),
      revalidateHarnessPackageAuthority: () => ({
        harnessPackage: null,
        harnessPackageMigration: null,
      }),
      getSandboxRecoveryAuthority: (): "missing" => "missing",
      withGatewayRouteMutationLock: async <T>(
        _gatewayName: string,
        operation: () => Promise<T> | T,
      ) => await operation(),
      withModelRouterPortLifecycleLock: async <T>(_port: number, operation: () => Promise<T> | T) =>
        await operation(),
      getModelRouterPort: () => 4000,
      normalizeHermesAuthMethod: (value) =>
        value === "oauth" || value === "api_key" ? value : null,
      setupNim: vi.fn(async () => ({
        model: "nvidia/test",
        provider: "nim",
        endpointUrl: "https://example.test/v1",
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
        hermesAuthMethod: null,
        hermesToolGateways: ["local"],
        preferredInferenceApi: "chat",
        compatibleEndpointReasoning: null,

        compatibleEndpointReasoningEffort: null,
        nimContainer: "nim-test",
      })),
      setupInference: vi.fn(async () => ({ ok: true as const })),
      resolveHostLocalInferenceStartupSelection: vi.fn(() => null),
      startRecordedStep: vi.fn(async () => undefined),
      recordStepComplete: vi.fn(async (_stepName: string, updates: SessionUpdates = {}) =>
        sessionWithUpdates(updates),
      ),
      recordStepRejected: vi.fn(async () => createSession()),
      toSessionUpdates: (updates) => updates as SessionUpdates,
      skippedStepMessage: vi.fn(),
      ensureManagedLlamaCppResumeReady: vi.fn(async () => false),
      ensureResumeProviderReady: vi.fn(
        async (
          _gatewayName: string,
          _provider: string | null | undefined,
          _credentialEnv: string | null | undefined,
        ) => ({
          forceInferenceSetup: false,
          credentialEnv: null,
        }),
      ),
      isResumeProviderSurfaceReady: vi.fn(() => true),
      recordStateSkipped: vi.fn(async () => createSession()),
      recordRepairEvent: vi.fn(async () => createSession()),
      hydrateCredentialEnv: vi.fn(),
      configureCompatibleEndpointReasoning: vi.fn(async () => "false" as const),

      configureCompatibleEndpointReasoningEffort: vi.fn(async () => null),
      clearCompatibleEndpointReasoning: vi.fn(() => null),

      clearCompatibleEndpointReasoningEffort: vi.fn(() => null),
      repairLocalInferenceSystemdOverrideOrExit: vi.fn(),
      isNonInteractive: () => true,
      getOpenshellBinary: () => "openshell",
      needsBedrockRuntimeAdapter: () => false,
      isInferenceRouteReady: (_gatewayName, _provider, _model) => false,
      isRoutedInferenceProvider: () => false,
      reconcileModelRouter: vi.fn(async () => undefined),
      reupsertRoutedProvider: (_gatewayName, _provider, _endpointUrl, _credentialEnv) => ({
        ok: true,
        endpointUrl: "https://example.test/v1",
      }),
      reserveSandboxInferenceRoute: vi.fn(() => true),
      registryUpdateSandbox: vi.fn(),
      checkpointSandboxIdentity: vi.fn(async () => undefined),
      prepareLocalProviderForInference: vi.fn(async () => null),
      promptValidatedSandboxName: vi.fn(async () => "my-sandbox"),
      assessHost: () => ({ memoryGb: 64 }),
      formatSandboxBuildEstimateNote: () => null,
      formatOnboardConfigSummary: () => "summary",
      prompt: vi.fn(async () => "1"),
      cliName: () => "nemoclaw",
      log: vi.fn(),
      error: vi.fn(),
      exitProcess: ((code: number) => {
        throw new Error(`exit ${code}`);
      }) as (code: number) => never,
      deleteEnv: vi.fn(),
      ...overrides.providerDeps,
    },
  });
  const sandbox = createSandboxOnboardFlowPhase<CoreContext>({
    gatewayName: "nemoclaw",
    resumeAgentChanged: false,
    endpointProvenance,
    recreateSandbox: () => false,
    controlUiPort: null,
    rootDir: "/repo",
    env: {},
    ...overrides.sandboxOptions,
    deps: {
      resolvePath: (value) => value,
      agentSupportsWebSearch: () => true,
      note: vi.fn(),

      cliName: () => "nemoclaw",
      updateSession: vi.fn((mutator) => mutator(createSession()) ?? createSession()),
      getStoredMessagingChannelConfig: () => null,
      hydrateMessagingChannelConfig: (config) => config,
      messagingChannelConfigsEqual: () => true,
      getSandboxReuseState: () => "missing",
      getSandboxRecreateObservation: () => ({ state: "missing", liveIdentityFingerprint: null }),
      getDcodeSelectionDrift: () => ({ changed: false, unknown: false }),
      hasSandboxGpuDrift: () => false,
      getSandboxHermesToolGateways: () => [],
      getSandboxRegistryEntry,
      normalizeHermesToolGatewaySelections: (value) => (Array.isArray(value) ? value : []),
      stringSetsEqual: (left, right) =>
        left.length === right.length && left.every((item) => right.includes(item)),
      removeSandboxFromRegistry: vi.fn(() => null),
      restoreSandboxRegistryEntryIfMissing: vi.fn(() => false),
      ensureValidatedWebSearchCredential: vi.fn(async () => null),
      isBackToSelection: () => false,
      configureWebSearch: vi.fn(async () => null),
      startRecordedStep: vi.fn(async () => undefined),
      getRecordedMessagingChannelsForResume: () => null,
      setupMessagingChannels: vi.fn(async () => ["slack", "discord"]),
      readMessagingPlanFromEnv: () => null,
      writePlanToEnv: vi.fn(),
      clearPlanEnv: vi.fn(),
      getRegistrySandboxMessagingAuthority: () => ({ authoritative: false, plan: null }),
      providerMatchesGatewayCredential: () => false,
      stageSandboxCredentialProviders: vi.fn(async () => []),
      promptValidatedSandboxName: vi.fn(async () => "my-sandbox"),
      selectResourceProfileForSandbox: vi.fn(async () => null),
      listRegistrySandboxes: () => ({ sandboxes: [] }),
      planRegisteredExtraProviders: vi.fn(() => ({
        extraProviders: [],
        staleExtraProviders: [],
      })),
      resolveSandboxCreateIntent: vi.fn(
        async ({ sandboxName, inferenceProvider, extraProviders, staleExtraProviders }) => ({
          sandboxName,
          inferenceProvider: inferenceProvider ?? null,
          activeMessagingChannels: [],
          messagingProviderRequests: [],
          reusableMessagingProviders: [],
          extraProviders: [...extraProviders],
          staleExtraProviders: [...staleExtraProviders],
          hermesToolGateways: [],
          policy: {
            basePolicyPath: "/repo/policy.yaml",
            activeMessagingChannels: [],
            options: {
              directGpu: false,
              additionalPresets: [],
              policyTier: null,
            },
          },
          gpuCreateArgs: [],
          resourceCreateArgs: [],
          gpuRoutePlan: "none" as const,
          sandboxGpuLogMessage: null,
          disabledChannelNames: [],
          extraPlaceholderKeys: [],
        }),
      ),
      createSandbox: vi.fn(async () => "created-sandbox"),
      finalizeSandboxRouteReservation: vi.fn(() => true),
      revalidateHarnessPackageAuthority: () => ({
        harnessPackage: null,
        harnessPackageMigration: null,
      }),
      updateSandboxRegistry: vi.fn(),
      getSandboxAgentRegistryFields: () => ({ agent: "openclaw" }),
      recordStepComplete: vi.fn(async (_stepName: string, updates: SessionUpdates = {}) =>
        sessionWithUpdates(updates),
      ),
      toSessionUpdates: (updates) => updates as SessionUpdates,
      skippedStepMessage: vi.fn(),
      recordStateSkipped: vi.fn(async () => createSession()),
      recordRepairEvent: vi.fn(async () => createSession()),
      error: vi.fn(),
      exitProcess: ((code: number) => {
        throw new Error(`exit ${code}`);
      }) as (code: number) => never,
      ...overrides.sandboxDeps,
      filterSelectedAgentWebSearchToolGateways:
        overrides.sandboxDeps?.filterSelectedAgentWebSearchToolGateways ??
        ((_agent, _receiptBacked, _provider, gateways) => [...gateways]),
      selectedAgentResumesSandboxPrompts:
        overrides.sandboxDeps?.selectedAgentResumesSandboxPrompts ??
        ((agent, receiptBackedPackage) => !receiptBackedPackage && agent?.name === "openclaw"),
      selectedAgentSupportsWebSearchProvider:
        overrides.sandboxDeps?.selectedAgentSupportsWebSearchProvider ?? (() => true),
      loadSession: overrides.sandboxDeps?.loadSession ?? (() => createSession()),
      compareAndSwapSession:
        overrides.sandboxDeps?.compareAndSwapSession ??
        ((matches, mutator) => {
          const session = createSession();
          if (!matches(session)) return "mismatch";
          mutator(session);
          return "updated";
        }),
      inspectGatewayCredential:
        overrides.sandboxDeps?.inspectGatewayCredential ?? (() => ({ kind: "missing" as const })),
      checkGatewayRouteCompatibility:
        overrides.sandboxDeps?.checkGatewayRouteCompatibility ?? (() => ({ ok: true })),
      withGatewayRouteMutationLock:
        overrides.sandboxDeps?.withGatewayRouteMutationLock ??
        (async <T>(_gatewayName: string, operation: () => Promise<T> | T) => await operation()),
    },
  });
  return { providerInference, sandbox };
}
