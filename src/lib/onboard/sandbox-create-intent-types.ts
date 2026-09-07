// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxHostMount } from "../state/registry/types";
import type { AgentDefinition } from "../agent/defs";
import type { HarnessSandboxTmpfsMountDeclaration } from "../agent-runtime/manifest-types";
import type { MessagingChannelConfig } from "../messaging-channel-config";
import type { DockerGpuRoutePlan } from "./docker-gpu-route";
import type { InitialSandboxPolicy } from "./initial-policy";
import type { ManagedStateVolumeMount } from "./managed-workload/managed-state-volumes";
import type {
  MessagingProviderMutationReceipt,
  MessagingTokenDef,
} from "./messaging-prep";
import type { MessagingChannel } from "./messaging-state";
import type { SandboxGpuCreateConfig } from "./sandbox-gpu-create";

type PrepareInitialSandboxCreatePolicy =
  typeof import("./initial-policy").prepareInitialSandboxCreatePolicy;

export type SandboxCreateMessagingProviderRequest = {
  readonly name: string;
  readonly envKey: string;
  readonly providerType: string;
  /** Exact single credential, or an explicitly declared namespaced family. */
  readonly credentialShape: "family" | "only";
  /** Credential keys the typed provider declaration requires to be present. */
  readonly credentialKeys: readonly string[];
  readonly credentialConfigured: boolean;
  readonly channel: string | null;
};

export type SandboxCreatePolicyRequest = {
  readonly basePolicyPath: string;
  readonly activeMessagingChannels: readonly string[];
  readonly options: {
    readonly directGpu: boolean;
    readonly hostGpuAvailable?: boolean;
    readonly additionalPresets: readonly string[];
    readonly hostLocalInferenceRouteOnly?: true;
    readonly agentName?: string | null;
    readonly observabilityEnabled?: boolean;
    readonly policyTier: string | null;
  };
};

/**
 * Serializable intent for the create-time sandbox contributions. When built
 * through `materializeSandboxCreatePlan`, messaging credential values are
 * represented only by their logical environment-key bindings and presence.
 *
 * This is deliberately separate from the execution plan, which contains
 * temporary paths and cleanup callbacks. Its serializable shape is for
 * internal inspection and testing only; it is not a persistence,
 * machine-event, or public API contract.
 */
export type SandboxCreateIntent = {
  readonly sandboxName: string;
  readonly inferenceProvider: string | null;
  readonly activeMessagingChannels: readonly string[];
  readonly messagingProviderRequests: readonly SandboxCreateMessagingProviderRequest[];
  readonly reusableMessagingProviders: readonly string[];
  readonly extraProviders: readonly string[];
  readonly staleExtraProviders: readonly string[];
  /** Receipt-backed package managed-tool IDs. */
  readonly toolGatewaySelections?: readonly string[];
  /** No-receipt Hermes compatibility selections. */
  readonly hermesToolGateways: readonly string[];
  readonly policy: SandboxCreatePolicyRequest;
  readonly sandboxGpuDevice?: string | null;
  readonly gpuCreateArgs: readonly string[];
  readonly resourceCreateArgs: readonly string[];
  readonly hostMounts?: readonly SandboxHostMount[];
  readonly sandboxDriverMounts?: readonly HarnessSandboxTmpfsMountDeclaration[];
  readonly gpuRoutePlan: DockerGpuRoutePlan;
  readonly sandboxGpuLogMessage: string | null;
  readonly disabledChannelNames: readonly string[];
  readonly extraPlaceholderKeys: readonly string[];
};

export type ResolveSandboxCreateIntentInput = {
  basePolicyPath: string;
  sandboxName: string;
  inferenceProvider?: string | null;
  hostLocalInferenceRouteOnly?: boolean;
  channels: readonly MessagingChannel[];
  enabledChannels: string[] | null;
  disabledChannelNames: ReadonlySet<string>;
  messagingProviderRequests: readonly SandboxCreateMessagingProviderRequest[];
  primaryMessagingCredentialEnvKeys: readonly string[];
  reusableMessagingChannels: readonly string[];
  reusableMessagingProviders: readonly string[];
  extraProviders?: readonly string[];
  staleExtraProviders?: readonly string[];
  toolGatewaySelections?: readonly string[];
  hermesToolGateways: readonly string[];
  sandboxGpuConfig: SandboxGpuCreateConfig;
  gpuCreateArgs: readonly string[];
  resourceCreateArgs?: readonly string[];
  hostMounts?: readonly SandboxHostMount[];
  sandboxDriverMounts?: readonly HarnessSandboxTmpfsMountDeclaration[];
  gpuRoutePlan: DockerGpuRoutePlan;
  sandboxGpuLogMessage: string | null;
  extraPlaceholderKeys?: readonly string[];
  agentName?: string | null;
  observabilityEnabled?: boolean;
  policyTier?: string | null;
};

export type MaterializeSandboxCreatePlanInput = {
  intent: SandboxCreateIntent;
  /** Exact receipt-pinned definition used only for package-owned policy assets. */
  packageAgentDefinition?: AgentDefinition;
  /** Policy bytes prepared before a destructive recreate boundary. */
  preparedPolicy?: {
    readonly initialSandboxPolicy: InitialSandboxPolicy;
    readonly compatibilityPolicyPath: string | null;
  };
  fromRef: string;
  managedStateMounts?: readonly ManagedStateVolumeMount[];
  /** Opaque provider-owned OpenShell driver-config key for the managed state mount. */
  managedStateMountDriverId?: string | null;
  policylessCreate?: boolean;
  /** Keep provider mutations and attachments behind the exact post-create identity gate. */
  deferSandboxEffectsUntilIdentityVerification?: boolean;
  /** A verified create resume must rebuild its plan without replaying provider mutations. */
  skipProviderEffects?: boolean;
  messagingTokenDefs: MessagingTokenDef[];
  recordMessagingProviderMutationReceipt?(receipt: MessagingProviderMutationReceipt): void;
  /** Non-secret config captured in the messaging plan that owns exact policy endpoints. */
  messagingConfig?: MessagingChannelConfig | null;
  runProviderPreDeleteCleanup(revalidateSandboxIdentity?: (operation: string) => void): void;
  upsertMessagingProviders(
    tokenDefs: MessagingTokenDef[],
    options: {
      replaceExisting: true;
      allowedSandboxes: readonly [string];
      requireExactBindings: boolean;
      requireOwnedExistingProvider?: boolean;
      recordMutationReceipt?(receipt: MessagingProviderMutationReceipt): void;
      revalidateSandboxIdentity?(operation: string): void;
    },
  ): string[];
  getHermesToolGatewayProviderName(sandboxName: string): string;
  discloseInitialSandboxPolicy?(policy: InitialSandboxPolicy): void;
  prepareInitialSandboxCreatePolicy?: PrepareInitialSandboxCreatePolicy;
};
