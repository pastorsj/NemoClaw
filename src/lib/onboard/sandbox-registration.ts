// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { isCandidateAgent } from "../agent/candidate";
import type { AgentDefinition } from "../agent/defs";
import type { HarnessPackageAuthority, HarnessPackageIdentity } from "../harness/package-types";
import * as harnessPackageStore from "../harness/package-store";
import type {
  InferenceEndpointSource,
  InferenceSelection,
  InferenceSelectionInput,
} from "../inference/selection";
import {
  inferenceSelectionRegistryFields,
  normalizeInferenceSelection,
} from "../inference/selection";
import { type WebSearchConfig, webSearchProviderForConfig } from "../inference/web-search";
import * as onboardSession from "../state/onboard-session";
import type { OpenClawImagePluginInstall } from "../state/openclaw-plugin-restore";
import type {
  BaselineExclusionEntry,
  SandboxEntry,
  SandboxMcpState,
  SandboxMessagingState,
} from "../state/registry";
import * as registry from "../state/registry";
import {
  cloneSandboxHostLocalInferenceProvenance,
  cloneSandboxHostLocalInferenceReceipt,
  requireSandboxHostLocalInferenceProvenance,
} from "../state/registry/host-local-inference";
import {
  normalizeRoutePackageAuthority,
  type QualifiedSandboxInferenceRouteReservation,
} from "../state/registry/route-reservation";
import { cloneSandboxWorkloadReceipt } from "../state/registry/workload";
import { DEFAULT_TOOL_DISCLOSURE, type ToolDisclosure } from "../tool-disclosure";
import type { DcodeAutoApprovalMode } from "./dcode-auto-approval";
import { cloneSandboxHostMounts } from "../state/registry/host-mount";
import { resolveOnboardHermesApiPort } from "./hermes-api-port";
import { isManagedImageAgent, MANAGED_IMAGE_REPOSITORIES } from "./managed-image/contract";
import {
  getHermesDashboardRegistryFields,
  type HermesDashboardOnboardState,
} from "./hermes-dashboard";
import {
  CURRENT_RUNTIME_PROVIDER_BUNDLES,
  RuntimeProviderBundleRegistry,
  RuntimeProviderSelectionError,
  requireRuntimeProviderBundleForSandbox,
  requireRuntimeProviderMutationAuthority,
} from "./runtime-provider/access";
import {
  getRequestedSandboxAgentName,
  getSandboxAgentRegistryFields,
  normalizeSandboxAgentName,
} from "./sandbox-agent";
import {
  classifyPortableLifecycleReceipt,
  portableLifecycleReceiptMatchesGeneration,
} from "./experimental/portable-runtime-receipt-readiness";

export type CreatedSandboxRuntimeFields = Pick<
  SandboxEntry,
  | "gpuEnabled"
  | "hostGpuDetected"
  | "sandboxGpuEnabled"
  | "sandboxGpuMode"
  | "sandboxGpuDevice"
  | "sandboxGpuProof"
  | "openshellDriver"
  | "openshellVersion"
>;

export interface CreatedSandboxRegistryEntryInput {
  sandboxName: string;
  inferenceSelection: InferenceSelection;
  runtimeFields: CreatedSandboxRuntimeFields;
  agent: AgentDefinition | null | undefined;
  agentVersionKnown: boolean;
  imageTag: string | null;
  workload?: SandboxEntry["workload"];
  hostLocalInferenceReceipt?: SandboxEntry["hostLocalInferenceReceipt"];
  hostLocalInferenceProvenance?: SandboxEntry["hostLocalInferenceProvenance"];
  openclawImagePluginInstalls?: readonly OpenClawImagePluginInstall[];
  appliedPolicies: string[];
  toolDisclosure?: ToolDisclosure;
  observabilityEnabled?: boolean;
  dcodeAutoApprovalMode?: DcodeAutoApprovalMode;
  policyTier?: SandboxEntry["policyTier"];
  baselineExclusions?: readonly BaselineExclusionEntry[];
  webSearchEnabled?: boolean;
  webSearchProvider?: SandboxEntry["webSearchProvider"];
  fromDockerfile?: string | null;
  hermesAuthMethod?: "oauth" | "api_key" | null;
  plannedMessagingState: SandboxMessagingState | undefined;
  /**
   * Durable MCP rebuild manifest carried across an already-absent sandbox.
   * The caller must only supply state captured from the same sandbox name.
   */
  preservedMcpState?: SandboxMcpState;
  hermesToolGateways: string[];
  hermesDashboardState: HermesDashboardOnboardState;
  /** Host port this sandbox exposes its OpenAI-compatible API on. */
  hermesApiPort?: number | null;
  /** True only when schema-5 receipt authority owns this Hermes registration. */
  hermesPortableLifecycle?: boolean;
  dashboardPort: number;
  dashboardRemoteBindPrepared?: boolean;
  lifecycleGeneration?: string;
  lifecycleLiveIdentityFingerprint?: string;
  gatewayName: string;
  gatewayPort: number;
  policyAuthority?: SandboxEntry["policyAuthority"];
  policyCreationReceipt?: SandboxEntry["policyCreationReceipt"];
  hostMounts?: readonly import("../state/registry/types").SandboxHostMount[];
}

export interface CreatedSandboxRegistrationInput extends CreatedSandboxRegistryEntryInput {
  portableLifecycle?: boolean;
  reservationSessionId?: string;
  environment?: NodeJS.ProcessEnv;
  classifyPortableLifecycleReceipt?: typeof classifyPortableLifecycleReceipt;
  inferenceRouteReservation?: QualifiedSandboxInferenceRouteReservation;
  verifiedCreate?: NonNullable<
    NonNullable<Parameters<typeof registry.registerSandbox>[2]>["verifiedCreate"]
  >;
  registerSandbox?(
    entry: SandboxEntry,
    routeReservation?: QualifiedSandboxInferenceRouteReservation,
    options?: Parameters<typeof registry.registerSandbox>[2],
  ): SandboxEntry | void;
  runtimeProviders?: RuntimeProviderBundleRegistry;
}

function registrationAuthorityError(detail: string): Error {
  return new Error(`Cannot publish sandbox registration: ${detail}`);
}

function requireMatchingPackageIdentity(
  detail: string,
  expected: HarnessPackageIdentity,
  actual: unknown,
): void {
  if (!isDeepStrictEqual(expected, actual)) {
    throw registrationAuthorityError(detail);
  }
}

function requireAbsentPackageAuthority(
  detail: string,
  value: Pick<SandboxEntry, "harnessPackage" | "harnessPackageMigration">,
): void {
  if (
    Object.prototype.hasOwnProperty.call(value, "harnessPackage") ||
    Object.prototype.hasOwnProperty.call(value, "harnessPackageMigration")
  ) {
    throw registrationAuthorityError(detail);
  }
}

/** Prove every final package owner again immediately before registry publication. */
function assertFinalHarnessPackageAuthority(
  input: CreatedSandboxRegistrationInput,
  requestedEntry: SandboxEntry,
): HarnessPackageAuthority | null {
  const verifiedCreate = input.verifiedCreate;
  if (!verifiedCreate) return null;

  const routeAuthority = normalizeRoutePackageAuthority(verifiedCreate.reservation.authority);
  const session = onboardSession.loadSession();
  if (
    !session ||
    session.sessionId !== verifiedCreate.reservation.authority.sessionId ||
    session.sandboxName !== input.sandboxName
  ) {
    throw registrationAuthorityError("the owning onboarding Session changed");
  }
  if (!session.checkpoint || session.checkpoint.sessionId !== session.sessionId) {
    throw registrationAuthorityError("the owning onboarding checkpoint is unavailable");
  }

  const currentEntry = registry.getSandbox(input.sandboxName);
  if (!currentEntry) {
    throw registrationAuthorityError("the created-sandbox registry row is unavailable");
  }
  const recreate = session.checkpoint.sandboxRecreate;
  const requestedAgentId = getRequestedSandboxAgentName(input.agent);
  if (normalizeSandboxAgentName(session.agent) !== requestedAgentId) {
    throw registrationAuthorityError("the owning Session agent changed");
  }

  if (routeAuthority.harnessPackage === null) {
    if (requestedAgentId !== "nemocua" && !isCandidateAgent(requestedAgentId)) {
      throw registrationAuthorityError(
        `standard agent '${requestedAgentId}' has no exact harness package authority`,
      );
    }
    if (
      session.harnessPackage !== null ||
      session.harnessPackageMigration !== null ||
      session.checkpoint.harnessPackage !== null ||
      (recreate !== null && (recreate.version !== 2 || recreate.harnessPackage !== null)) ||
      Object.prototype.hasOwnProperty.call(verifiedCreate.checkpoint, "harnessPackage")
    ) {
      throw registrationAuthorityError("qualified-agent package absence changed");
    }
    requireAbsentPackageAuthority(
      "the route reservation fabricated candidate package authority",
      verifiedCreate.reservation.entry,
    );
    requireAbsentPackageAuthority(
      "the created-sandbox row fabricated candidate package authority",
      currentEntry,
    );
    requireAbsentPackageAuthority(
      "the requested final row fabricated candidate package authority",
      requestedEntry,
    );
    return routeAuthority;
  }

  const expected = routeAuthority.harnessPackage;
  if (requestedAgentId !== expected.id) {
    throw registrationAuthorityError("the requested agent differs from its harness package");
  }
  requireMatchingPackageIdentity(
    "the Session harness package changed",
    expected,
    session.harnessPackage,
  );
  requireMatchingPackageIdentity(
    "the checkpoint harness package changed",
    expected,
    session.checkpoint.harnessPackage,
  );
  if (recreate !== null) {
    if (recreate.version !== 2) {
      throw registrationAuthorityError("the recreate transaction requires package migration");
    }
    requireMatchingPackageIdentity(
      "the recreate transaction harness package changed",
      expected,
      recreate.harnessPackage,
    );
  }
  requireMatchingPackageIdentity(
    "the route reservation harness package changed",
    expected,
    verifiedCreate.reservation.entry.harnessPackage,
  );
  requireMatchingPackageIdentity(
    "the verified policy checkpoint harness package changed",
    expected,
    verifiedCreate.checkpoint.harnessPackage,
  );
  requireMatchingPackageIdentity(
    "the created-sandbox row harness package changed",
    expected,
    currentEntry.harnessPackage,
  );
  requireMatchingPackageIdentity(
    "the requested final row harness package changed",
    expected,
    requestedEntry.harnessPackage,
  );
  if (
    !isDeepStrictEqual(routeAuthority.harnessPackageMigration, session.harnessPackageMigration) ||
    !isDeepStrictEqual(
      session.harnessPackageMigration,
      currentEntry.harnessPackageMigration ?? null,
    ) ||
    !isDeepStrictEqual(
      session.harnessPackageMigration,
      requestedEntry.harnessPackageMigration ?? null,
    )
  ) {
    throw registrationAuthorityError("the owning harness package migration provenance changed");
  }

  const pinned = harnessPackageStore.resolvePinnedHarnessPackage(expected);
  requireMatchingPackageIdentity(
    "the immutable harness package object changed",
    expected,
    pinned.identity,
  );
  return routeAuthority;
}

export function creationFidelity(
  webSearchConfig: WebSearchConfig | null,
  fromDockerfile: string | null,
  hermesAuthMethod: "oauth" | "api_key" | null,
  dashboardRemoteBindPrepared?: boolean,
  baselineExclusions?: readonly BaselineExclusionEntry[],
): Pick<
  SandboxEntry,
  | "webSearchEnabled"
  | "webSearchProvider"
  | "fromDockerfile"
  | "hermesAuthMethod"
  | "dashboardRemoteBindPrepared"
  | "baselineExclusions"
> {
  return {
    webSearchEnabled: webSearchConfig?.fetchEnabled === true,
    webSearchProvider: webSearchConfig ? webSearchProviderForConfig(webSearchConfig) : null,
    fromDockerfile,
    hermesAuthMethod,
    dashboardRemoteBindPrepared: dashboardRemoteBindPrepared === true,
    baselineExclusions: baselineExclusions?.map((exclusion) => ({ ...exclusion })),
  };
}

/** Snapshot complete exclusion records before a destructive create removes registry state. */
export function baselineExclusionsForCreate(sandboxName: string): BaselineExclusionEntry[] {
  const transition = registry.getBaselineExclusionTransition(sandboxName);
  if (transition) {
    const key = transition.exclusion.key;
    throw new Error(
      `Baseline policy ${transition.operation} for '${key}' needs repair before sandbox creation. Re-run 'policy ${transition.operation} ${key}' first.`,
    );
  }
  return registry.getBaselineExclusions(sandboxName).map((exclusion) => ({ ...exclusion }));
}

/**
 * Re-read exclusion intent at the destructive create edge and prove it still
 * matches the already-resolved policy plan. The sandbox mutation lock is the
 * caller's serialization boundary; this comparison catches stale plans and
 * any direct registry writer that bypassed that lock.
 */
export function assertBaselineExclusionsMatchCreateIntent(
  sandboxName: string,
  planned: readonly BaselineExclusionEntry[],
): BaselineExclusionEntry[] {
  const current = baselineExclusionsForCreate(sandboxName);
  if (!isDeepStrictEqual(current, [...planned])) {
    throw new Error(
      `Baseline policy exclusions for '${sandboxName}' changed while sandbox creation was being prepared. Retry so the replacement policy uses current registry intent.`,
    );
  }
  return current;
}

export function selection(
  sandboxName: string,
  provider: string,
  model: string,
  preferredInferenceApi: string | null,
  endpointSource: InferenceEndpointSource | null,
): InferenceSelection {
  const session = onboardSession.loadSession();
  const sessionMatches =
    session?.sandboxName === sandboxName &&
    session.provider === provider &&
    session.model === model;
  return inferenceSelectionRegistryFields({
    provider,
    model,
    endpointUrl: sessionMatches ? (session.endpointUrl ?? null) : null,
    endpointSource: sessionMatches ? endpointSource : null,
    credentialEnv: sessionMatches ? (session.credentialEnv ?? null) : null,
    preferredInferenceApi,
    compatibleEndpointReasoning: sessionMatches
      ? (session.compatibleEndpointReasoning ?? null)
      : null,
    compatibleEndpointReasoningEffort: sessionMatches
      ? (session.compatibleEndpointReasoningEffort ?? null)
      : null,
    nimContainer: sessionMatches ? (session.nimContainer ?? null) : null,
  });
}

/** Normalize the exact provider-phase route carried into sandbox creation. */
export function sandboxCreateInferenceSelection(
  input: InferenceSelectionInput,
): InferenceSelection {
  return normalizeInferenceSelection(input);
}

export function buildCreatedSandboxRegistryEntry(
  input: CreatedSandboxRegistryEntryInput,
): SandboxEntry {
  const session = onboardSession.loadSession();
  const servingProfileProvenance =
    session?.sandboxName === input.sandboxName
      ? (session.servingProfileProvenance ?? undefined)
      : undefined;
  const messagingState =
    input.plannedMessagingState?.plan.sandboxName === input.sandboxName
      ? input.plannedMessagingState
      : undefined;
  const workload = cloneSandboxWorkloadReceipt(input.workload);
  if (input.workload !== undefined && workload === undefined) {
    throw new RuntimeProviderSelectionError(
      "Sandbox workload ownership receipt failed closed validation.",
    );
  }
  const hostLocalInferenceReceipt = cloneSandboxHostLocalInferenceReceipt(
    input.hostLocalInferenceReceipt,
  );
  if (input.hostLocalInferenceReceipt !== undefined && hostLocalInferenceReceipt === undefined) {
    throw new RuntimeProviderSelectionError(
      "Sandbox host-local inference receipt failed closed validation.",
    );
  }
  const hostLocalInferenceProvenance = cloneSandboxHostLocalInferenceProvenance(
    input.hostLocalInferenceProvenance,
  );
  if (
    input.hostLocalInferenceProvenance !== undefined &&
    (!hostLocalInferenceProvenance || typeof hostLocalInferenceReceipt !== "string")
  ) {
    throw new RuntimeProviderSelectionError(
      "Sandbox host-local inference provenance failed closed validation.",
    );
  }
  if (hostLocalInferenceProvenance && typeof hostLocalInferenceReceipt === "string") {
    requireSandboxHostLocalInferenceProvenance(
      hostLocalInferenceProvenance,
      hostLocalInferenceReceipt,
    );
  }
  const agentFields = getSandboxAgentRegistryFields(input.agent, input.agentVersionKnown);
  if (workload?.kind === "managed-image") {
    const requestedAgent = getRequestedSandboxAgentName(input.agent);
    if (
      !isManagedImageAgent(requestedAgent) ||
      !workload.reference.startsWith(`${MANAGED_IMAGE_REPOSITORIES[requestedAgent]}@sha256:`)
    ) {
      throw new RuntimeProviderSelectionError(
        "Sandbox agent identity does not match its managed workload receipt.",
      );
    }
    agentFields.agent = requestedAgent;
  }

  return {
    name: input.sandboxName,
    servingProfileProvenance,
    ...inferenceSelectionRegistryFields(input.inferenceSelection),
    ...input.runtimeFields,
    ...agentFields,
    imageTag: input.imageTag,
    workload,
    ...(hostLocalInferenceReceipt !== undefined ? { hostLocalInferenceReceipt } : {}),
    ...(hostLocalInferenceProvenance ? { hostLocalInferenceProvenance } : {}),
    ...(input.openclawImagePluginInstalls !== undefined
      ? {
          openclawImagePluginInstalls: input.openclawImagePluginInstalls.map((install) => ({
            ...install,
            ...(install.loadPaths !== undefined ? { loadPaths: [...install.loadPaths] } : {}),
          })),
        }
      : {}),
    policies: input.appliedPolicies,
    ...(input.policyAuthority !== undefined ? { policyAuthority: input.policyAuthority } : {}),
    ...(input.policyCreationReceipt !== undefined
      ? { policyCreationReceipt: input.policyCreationReceipt }
      : {}),
    baselineExclusions: input.baselineExclusions?.map((exclusion) => ({ ...exclusion })),
    toolDisclosure: input.toolDisclosure ?? DEFAULT_TOOL_DISCLOSURE,
    observabilityEnabled: input.observabilityEnabled === true,
    ...(input.dcodeAutoApprovalMode !== undefined
      ? { dcodeAutoApprovalMode: input.dcodeAutoApprovalMode }
      : {}),
    ...(input.policyTier !== undefined ? { policyTier: input.policyTier } : {}),
    webSearchEnabled: input.webSearchEnabled === true,
    webSearchProvider:
      input.webSearchEnabled === true ? (input.webSearchProvider ?? "brave") : null,
    fromDockerfile: input.fromDockerfile ?? null,
    hermesAuthMethod: input.hermesAuthMethod ?? null,
    messaging: messagingState,
    mcp: input.preservedMcpState,
    hermesToolGateways:
      input.hermesToolGateways.length > 0 ? [...input.hermesToolGateways] : undefined,
    ...getHermesDashboardRegistryFields(input.hermesDashboardState),
    hermesApiPort:
      input.agent?.name === "hermes"
        ? input.hermesPortableLifecycle === true
          ? undefined
          : (input.hermesApiPort ??
            resolveOnboardHermesApiPort(input.sandboxName, {
              // Registration follows a successful create/recreate that applied this environment.
              allowRegisteredOverride: true,
            }))
        : undefined,
    dashboardPort: input.dashboardPort,
    dashboardRemoteBindPrepared: input.dashboardRemoteBindPrepared === true,
    lifecycleGeneration: input.lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: input.lifecycleLiveIdentityFingerprint,
    gatewayName: input.gatewayName,
    gatewayPort: input.gatewayPort,
    ...(input.hostMounts && input.hostMounts.length > 0
      ? { hostMounts: cloneSandboxHostMounts(input.hostMounts) }
      : {}),
  };
}

/** Load the immutable choices needed by command-level resume validation. */
export function loadOnboardCommandResumeSession(): {
  servingProfileProvenance: onboardSession.Session["servingProfileProvenance"];
  vllmGpuDevice: onboardSession.Session["vllmGpuDevice"];
} | null {
  const session = onboardSession.loadSession();
  return session
    ? {
        servingProfileProvenance: session.servingProfileProvenance,
        vllmGpuDevice: session.vllmGpuDevice,
      }
    : null;
}

export function registerCreatedSandbox(input: CreatedSandboxRegistrationInput): SandboxEntry {
  const pending = input.inferenceRouteReservation?.entry ?? registry.getSandbox(input.sandboxName);
  const pendingRoute =
    input.reservationSessionId && pending
      ? registry.normalizeSandboxInferenceRouteSelection(normalizeInferenceSelection(pending))
      : null;
  const pendingHostLocalInferenceReceipt =
    input.hostLocalInferenceReceipt !== undefined
      ? input.hostLocalInferenceReceipt
      : pending?.hostLocalInferenceReceipt;
  const pendingHostLocalInferenceProvenance =
    input.hostLocalInferenceProvenance !== undefined
      ? input.hostLocalInferenceProvenance
      : pending?.hostLocalInferenceProvenance;
  const entry = buildCreatedSandboxRegistryEntry({
    ...input,
    inferenceSelection: pendingRoute
      ? { ...input.inferenceSelection, ...pendingRoute }
      : input.inferenceSelection,
    ...(pendingHostLocalInferenceReceipt === undefined
      ? {}
      : { hostLocalInferenceReceipt: pendingHostLocalInferenceReceipt }),
    ...(pendingHostLocalInferenceProvenance === undefined
      ? {}
      : { hostLocalInferenceProvenance: pendingHostLocalInferenceProvenance }),
  });
  const reservedPackageAuthority = input.inferenceRouteReservation?.authority;
  if (reservedPackageAuthority?.harnessPackage) {
    entry.harnessPackage = reservedPackageAuthority.harnessPackage;
    if (reservedPackageAuthority.harnessPackageMigration) {
      entry.harnessPackageMigration = reservedPackageAuthority.harnessPackageMigration;
    }
  }
  if (input.portableLifecycle === true) {
    if (getRequestedSandboxAgentName(input.agent) !== "openclaw") {
      throw new RuntimeProviderSelectionError(
        "Portable lifecycle registration requires the OpenClaw agent.",
      );
    }
    const receipt = (input.classifyPortableLifecycleReceipt ?? classifyPortableLifecycleReceipt)(
      input.sandboxName,
      { env: input.environment ?? process.env },
    );
    if (!portableLifecycleReceiptMatchesGeneration(receipt, input.lifecycleGeneration)) {
      throw new RuntimeProviderSelectionError(
        "Portable OpenClaw registration requires a current lifecycle receipt that matches the registry generation.",
      );
    }
    entry.agent = null;
  }
  const provider = requireRuntimeProviderBundleForSandbox(
    entry,
    input.runtimeProviders ?? CURRENT_RUNTIME_PROVIDER_BUNDLES,
  );
  requireRuntimeProviderMutationAuthority(provider, "registration");
  if (!provider.workload.acceptsReceipt(entry.workload)) {
    throw new RuntimeProviderSelectionError(
      `Runtime provider '${provider.identity.id}' does not accept the registered workload receipt.`,
    );
  }
  const finalPackageAuthority = assertFinalHarnessPackageAuthority(input, entry);
  const writeRegistry = input.registerSandbox ?? registry.registerSandbox;
  const pendingOptions =
    input.reservationSessionId && !input.verifiedCreate
      ? {
          pending: true as const,
          reservationSessionId: input.reservationSessionId,
        }
      : undefined;
  const registrationOptions = input.verifiedCreate
    ? {
        verifiedCreate: input.verifiedCreate,
        ...(finalPackageAuthority ? { finalPackageAuthority } : {}),
      }
    : pendingOptions;
  const registered =
    input.inferenceRouteReservation || registrationOptions
      ? writeRegistry(entry, input.inferenceRouteReservation, registrationOptions)
      : writeRegistry(entry);
  return registered ?? entry;
}
