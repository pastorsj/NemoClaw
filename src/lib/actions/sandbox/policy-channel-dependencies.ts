// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { inspectOpenShellSandboxIdentityFingerprint } from "../../adapters/openshell/sandbox-identity-cli";
import { createCliOpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter-cli";
import { parseCliOpenShellProviderAttachmentNames } from "../../adapters/openshell/provider-attachment-cli";
import { runOpenshell } from "../../adapters/openshell/runtime";
import { namedOpenShellGateway } from "../../adapters/openshell/sandbox-observer";
import {
  getCredential as getStoredCredential,
  normalizeCredentialValue as normalizeStoredCredentialValue,
  prompt as promptForCredential,
} from "../../credentials/store";
import {
  isMessagingProviderBindingConflict as isTypedMessagingProviderBindingConflict,
  isMessagingProviderMutationFailure as isTypedMessagingProviderMutationFailure,
} from "../../messaging/applier/openshell-provider";
import { buildMessagingProviderApplication } from "../../messaging/applier/provider-application";
import { MessagingSetupApplier } from "../../messaging/applier/setup-applier";
import type { SandboxMessagingPlan } from "../../messaging/manifest";
import {
  inspectGatewayCredentialFamilyProviderBinding,
  inspectGatewayCredentialOnlyProviderBinding,
  readGatewayProviderMetadata,
  type GatewayCredentialFamilyProviderBinding,
  type GatewayCredentialOnlyProviderInspection,
} from "../../onboard/gateway-provider-metadata";
import type {
  MessagingProviderMutationReceipt,
  MessagingTokenDef,
} from "../../onboard/messaging-prep";

export type MessagingProviderAttachment = Readonly<{
  name: string;
  providerId: string;
  credentialKeys: readonly string[];
}>;

export { listLegacyChannelStatePaths } from "../../messaging/legacy-profile";
export { legacyMessagingPolicyWarningAgent } from "./policy-channel-legacy";

type MessagingProviderUpsertOptions = {
  replaceExisting?: boolean;
  bestEffort?: boolean;
  requireExactBindings?: boolean;
  requireOwnedExistingProvider?: boolean;
  requireExistingProvider?: boolean;
  deferCreatedProviderCleanup?: boolean;
  allowedSandboxes?: readonly string[];
  gatewayName?: string;
  revalidateSandboxIdentity?: (operation: string) => void;
  recordMutationReceipt?: (receipt: MessagingProviderMutationReceipt) => void;
  alreadyAttachedProviderNames?: readonly string[];
};

type RebuildModule = typeof import("./rebuild");
type CredentialStoreModule = typeof import("../../credentials/store");
type PrivilegedExecModule = typeof import("../../sandbox/privileged-exec");
type SetupInferenceModule = typeof import("../../onboard/setup-inference");
type SandboxProviderCleanupModule = typeof import("../../onboard/sandbox-provider-cleanup");
type PolicyModule = typeof import("../../policy");
type GooglechatWebhookLifecycleModule =
  typeof import("../../messaging/channels/googlechat/tunnel/lifecycle");
type GooglechatTunnelRuntimeDeps =
  import("../../messaging/channels/googlechat/hooks/tunnel-runtime").GooglechatTunnelRuntimeDeps;
type GooglechatTunnelServices = Pick<
  typeof import("../../tunnel/services"),
  "getTunnelUrl" | "readCloudflaredState" | "resolveServicePidDir" | "startAll" | "stopCloudflared"
>;
type GooglechatWebhookProxy = Pick<
  typeof import("../../messaging/channels/googlechat/tunnel/proxy"),
  "readGooglechatWebhookProxyState" | "startGooglechatWebhookProxy" | "stopGooglechatWebhookProxy"
>;

function gatewayRunner(gatewayName: string): typeof runOpenshell {
  const { createGatewayScopedOpenshellRunner } =
    require("../../onboard/setup-inference") as SetupInferenceModule;
  return createGatewayScopedOpenshellRunner(runOpenshell, gatewayName);
}

/**
 * Injectable, late-bound boundary around provider registration and rebuild
 * orchestration. Focused tests replace these methods with `vi.spyOn` without
 * using `createRequire` or mutating the CommonJS cache. This boundary can be
 * removed when those graphs can be imported without eagerly loading unrelated
 * onboarding and rebuild modules at policy-channel import time.
 */
export const policyChannelDependencies = {
  /** Keep interactive credential I/O behind the channel workflow's injectable boundary. */
  prompt(
    ...args: Parameters<CredentialStoreModule["prompt"]>
  ): ReturnType<CredentialStoreModule["prompt"]> {
    return promptForCredential(...args);
  },
  getCredential(
    ...args: Parameters<CredentialStoreModule["getCredential"]>
  ): ReturnType<CredentialStoreModule["getCredential"]> {
    return getStoredCredential(...args);
  },
  normalizeCredentialValue(
    ...args: Parameters<CredentialStoreModule["normalizeCredentialValue"]>
  ): ReturnType<CredentialStoreModule["normalizeCredentialValue"]> {
    return normalizeStoredCredentialValue(...args);
  },
  /** Run an OpenShell command through the same replaceable workflow boundary. */
  runOpenshell(...args: Parameters<typeof runOpenshell>): ReturnType<typeof runOpenshell> {
    return runOpenshell(...args);
  },
  /** Use stopped Docker cleanup only after both in-sandbox cleanup attempts fail. */
  clearStoppedSandboxStateRoots(
    sandboxName: string,
    paths: readonly string[],
  ): ReturnType<PrivilegedExecModule["clearStoppedSandboxStateRoots"]> {
    const cleanup = require("../../sandbox/privileged-exec") as PrivilegedExecModule;
    return cleanup.clearStoppedSandboxStateRoots(sandboxName, paths);
  },
  deleteMessagingProviderWithRecovery(
    providerName: string,
    sandboxName: string,
    gatewayName: string,
  ): ReturnType<SandboxProviderCleanupModule["deleteProviderWithRecovery"]> {
    const cleanup =
      require("../../onboard/sandbox-provider-cleanup") as SandboxProviderCleanupModule;
    return cleanup.deleteProviderWithRecovery(providerName, {
      allowedSandboxes: [sandboxName],
      runOpenshell: gatewayRunner(gatewayName),
    });
  },
  revalidateChannelProviderPolicy(sandboxName: string, gatewayName: string): void {
    const policy = require("../../policy") as PolicyModule;
    const operation = `change messaging providers for sandbox '${sandboxName}'`;
    const context = policy.inspectPolicyMutationContext(sandboxName, operation, gatewayName);
    policy.recheckPolicyMutationContext(sandboxName, operation, context);
  },
  inspectMessagingProviderAttachmentTarget(sandboxName: string, gatewayName: string): string {
    return inspectOpenShellSandboxIdentityFingerprint({
      sandboxName,
      gatewayName,
    });
  },
  runGatewayOpenshell(
    gatewayName: string,
    args: Parameters<typeof runOpenshell>[0],
    options?: Parameters<typeof runOpenshell>[1],
  ): ReturnType<typeof runOpenshell> {
    return gatewayRunner(gatewayName)(args, options);
  },
  inspectMessagingProviderBinding(
    binding: GatewayCredentialFamilyProviderBinding & {
      readonly credentialShape: "family" | "only";
    },
    gatewayName: string,
  ): GatewayCredentialOnlyProviderInspection {
    return binding.credentialShape === "family"
      ? inspectGatewayCredentialFamilyProviderBinding(binding, gatewayRunner(gatewayName))
      : inspectGatewayCredentialOnlyProviderBinding(binding, gatewayRunner(gatewayName));
  },
  inspectMessagingProviderMetadata(providerName: string, gatewayName: string) {
    return readGatewayProviderMetadata(providerName, gatewayRunner(gatewayName));
  },
  inspectMessagingProviderAttachments(
    sandboxName: string,
    gatewayName: string,
  ): readonly MessagingProviderAttachment[] | null {
    const run = gatewayRunner(gatewayName);
    let result: ReturnType<typeof runOpenshell>;
    try {
      result = run(["sandbox", "provider", "list", sandboxName], {
        ignoreError: true,
        maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5_000,
      });
    } catch {
      return null;
    }
    if (result.status !== 0) return null;
    const names = parseCliOpenShellProviderAttachmentNames(
      `${result.stdout || ""}\n${result.stderr || ""}`,
    );
    if (!names) return null;
    const attachments: MessagingProviderAttachment[] = [];
    for (const name of names) {
      const metadata = readGatewayProviderMetadata(name, run);
      if (!metadata?.id) return null;
      attachments.push({
        name,
        providerId: metadata.id,
        credentialKeys: metadata.credentialKeys,
      });
    }
    return attachments;
  },
  isMessagingProviderBindingConflict(error: unknown): error is Error & {
    readonly mutatedProviderNames: readonly string[];
    readonly createdProviderNames?: readonly string[];
    readonly providerIds?: Readonly<Record<string, string>>;
    readonly replacedProviderNames?: readonly string[];
    readonly attachedProviderNames?: readonly string[];
  } {
    return isTypedMessagingProviderBindingConflict(error);
  },
  isMessagingProviderMutationFailure(error: unknown): error is Error & {
    readonly mutatedProviderNames: readonly string[];
    readonly createdProviderNames: readonly string[];
    readonly providerIds: Readonly<Record<string, string>>;
    readonly replacedProviderNames?: readonly string[];
    readonly attachedProviderNames?: readonly string[];
  } {
    return isTypedMessagingProviderMutationFailure(error);
  },
  async upsertMessagingProviders(
    tokenDefs: MessagingTokenDef[],
    gatewayName: string,
    options?: MessagingProviderUpsertOptions,
    context?: {
      readonly plan: SandboxMessagingPlan;
      readonly channelName: string;
      readonly sandboxName: string;
      readonly revalidateSandboxIdentity: (operation: string) => void;
    },
  ): Promise<string[]> {
    if (!context) throw new Error("Messaging provider application context is missing.");
    const application = buildMessagingProviderApplication({
      tokenDefs,
      getCredential: getStoredCredential,
      env: process.env,
      normalizeCredentialValue: (value) =>
        normalizeStoredCredentialValue(value as string | undefined),
      channelIdForCredential: () => context.channelName,
    });
    const result = await MessagingSetupApplier.applyCredentialsAtOpenShell(context.plan, {
      providerAdapter: createCliOpenShellProviderAdapter({ run: runOpenshell }),
      target: namedOpenShellGateway(gatewayName),
      definitions: application.definitions,
      refreshes: application.refreshes,
      replaceExisting: options?.replaceExisting,
      allowedSandboxes: options?.allowedSandboxes ?? [context.sandboxName],
      attachToSandbox: context.sandboxName,
      alreadyAttachedProviderNames: options?.alreadyAttachedProviderNames,
      requireCompleteBindings: true,
      requireStableProviderIdentity: options?.requireOwnedExistingProvider,
      revalidateSandboxIdentity: context.revalidateSandboxIdentity,
      log: (message) => console.error(`  ${message}`),
    });
    options?.recordMutationReceipt?.({
      providerNames: result.providerNames,
      mutatedProviderNames: result.mutatedProviderNames,
      createdProviderNames: result.createdProviderNames,
      providerIds: result.providerIds,
    });
    return [...result.providerNames];
  },
  cleanupMessagingProviders(
    providerNames: readonly string[],
    sandboxName: string,
    gatewayName: string,
    revalidateSandboxIdentity: (operation: string) => void,
    options: {
      readonly expectedProviderIds?: Readonly<Record<string, string>>;
      readonly detachOnlyProviderNames?: readonly string[];
    } = {},
  ) {
    return MessagingSetupApplier.cleanupProvidersAtOpenShell(providerNames, {
      providerAdapter: createCliOpenShellProviderAdapter({ run: runOpenshell }),
      target: namedOpenShellGateway(gatewayName),
      allowedSandboxes: [sandboxName],
      expectedProviderIds: options.expectedProviderIds,
      detachOnlyProviderNames: options.detachOnlyProviderNames,
      revalidateSandboxIdentity,
    });
  },
  rebuildSandbox(
    sandboxName: Parameters<RebuildModule["rebuildSandbox"]>[0],
    args: Parameters<RebuildModule["rebuildSandbox"]>[1],
  ): ReturnType<RebuildModule["rebuildSandbox"]> {
    const rebuild = require("./rebuild") as RebuildModule;
    return rebuild.rebuildSandbox(sandboxName, args);
  },
  stopGooglechatWebhookTunnel(sandboxName: string): void {
    const lifecycle =
      require("../../messaging/channels/googlechat/tunnel/lifecycle") as GooglechatWebhookLifecycleModule;
    const services = require("../../tunnel/services") as GooglechatTunnelServices;
    const webhookProxy =
      require("../../messaging/channels/googlechat/tunnel/proxy") as GooglechatWebhookProxy;
    lifecycle.stopGooglechatWebhookTunnel(sandboxName, { services, webhookProxy });
  },
  googlechatTunnelRuntime(sandboxName: string): GooglechatTunnelRuntimeDeps {
    return {
      sandboxName,
      loadServices: () => require("../../tunnel/services") as GooglechatTunnelServices,
      loadWebhookProxy: () =>
        require("../../messaging/channels/googlechat/tunnel/proxy") as GooglechatWebhookProxy,
      prompt: (question) => {
        const store =
          require("../../credentials/store") as typeof import("../../credentials/store");
        return store.prompt(question);
      },
    };
  },
};
