// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WebSearchConfig } from "../inference/web-search";
import type { CheckpointProviderBinding } from "../state/onboard-checkpoint-types";
import type { Session } from "../state/onboard-session";
import type { StagedCredentialProviderReceipt } from "../state/onboard-session";
import * as gatewayProviderMetadata from "./gateway-provider-metadata";
import * as messagingBridgeProvider from "./messaging-bridge-provider";
import {
  hasConfiguredMessagingCredential,
  type MessagingProviderMutationReceipt,
  type MessagingTokenDef,
} from "./messaging-prep";
import type { OpenshellCliHelpers } from "./openshell-cli";
import { createGatewayScopedOpenshellRunner } from "./setup-inference";

const providers = require("./providers");

export interface StageSandboxCredentialProvidersInput<Agent> {
  sandboxName: string;
  enabledChannels: readonly string[];
  webSearchConfig: WebSearchConfig | null;
  agent: Agent;
  requiredBindings: readonly CheckpointProviderBinding[];
  replaceExisting?: boolean;
  receiptBackedPackage?: boolean;
  revalidateSandboxIdentity?(operation: string): void;
}

export interface MessagingProviderRegistrationOptions {
  replaceExisting?: boolean;
  bestEffort?: boolean;
  allowedSandboxes?: readonly string[];
  requireExactBindings?: boolean;
  requireOwnedExistingProvider?: boolean;
  requireExistingProvider?: boolean;
  deferCreatedProviderCleanup?: boolean;
  revalidateSandboxIdentity?(operation: string): void;
  recordMutationReceipt?(receipt: MessagingProviderMutationReceipt): void;
}

type PreparedCredentialProviders = {
  messagingTokenDefs: MessagingTokenDef[];
};

type PrepareCredentialProviders<Agent> = (
  input: StageSandboxCredentialProvidersInput<Agent>,
) => Promise<PreparedCredentialProviders>;

export interface CredentialProviderRegistrationDeps {
  root: string;
  runOpenshell: OpenshellCliHelpers["runOpenshell"];
  getGatewayName(): string;
  getCredential(name: string): string | null;
  updateSession(mutator: (session: Session) => Session | void): Session;
  loadSession?(): Session | null;
  stagedLegacyValues: ReadonlyMap<string, string>;
  migratedLegacyKeys: Set<string>;
  persistMigratedLegacyKeys(): void;
}

function recordMigratedLegacyMessagingCredentials(
  tokenDefs: readonly MessagingTokenDef[],
  registeredProviderNames: readonly string[],
  deps: CredentialProviderRegistrationDeps,
  revalidateSandboxIdentity?: (operation: string) => void,
): void {
  const registeredProviders = new Set(registeredProviderNames);
  const migrations: Array<{ envKey: string; migrated: boolean }> = [];
  for (const def of tokenDefs) {
    if (!registeredProviders.has(def.name) || !def.token || !def.envKey) continue;
    const stagedValue = deps.stagedLegacyValues.get(def.envKey);
    if (stagedValue === undefined) continue;
    migrations.push({ envKey: def.envKey, migrated: def.token === stagedValue });
  }
  if (migrations.length === 0) return;
  revalidateSandboxIdentity?.("record migrated messaging provider credentials");
  for (const migration of migrations) {
    if (migration.migrated) deps.migratedLegacyKeys.add(migration.envKey);
    else deps.migratedLegacyKeys.delete(migration.envKey);
  }
  deps.persistMigratedLegacyKeys();
}

function setStagedCredentialProviderReceipts(
  names: readonly string[],
  staged: boolean,
  deps: CredentialProviderRegistrationDeps,
): void {
  if (names.length === 0) return;
  deps.updateSession((current) => {
    const providerNames = new Set(current.stagedCredentialProviders);
    for (const name of names) {
      if (staged) providerNames.add(name);
      else providerNames.delete(name);
    }
    current.stagedCredentialProviders = [...providerNames];
    return current;
  });
}

const BINDING_PLAN_ERROR = "Credential provider plan does not match the required bindings.";
const EXISTING_BINDING_ERROR =
  "An existing credential provider does not match the required binding.";
const MISSING_BINDING_ERROR =
  "A required credential provider is missing and no credential is available to recreate it.";

function isCanonicalBinding(binding: CheckpointProviderBinding): boolean {
  return [binding.name, binding.type, binding.credentialEnv].every(
    (field) => typeof field === "string" && field.length > 0 && field.trim() === field,
  );
}

function validatePlannedCredentialProviderBindings(
  tokenDefs: readonly MessagingTokenDef[],
  requiredBindings: readonly CheckpointProviderBinding[],
  hasPreparedCredential: (tokenDef: MessagingTokenDef) => boolean,
): ReadonlyMap<string, CheckpointProviderBinding> {
  const requiredByName = new Map<string, CheckpointProviderBinding>();
  for (const binding of requiredBindings) {
    if (!isCanonicalBinding(binding) || requiredByName.has(binding.name)) {
      throw new Error(BINDING_PLAN_ERROR);
    }
    requiredByName.set(binding.name, binding);
  }

  const plannedByName = new Map<string, CheckpointProviderBinding>();
  for (const tokenDef of tokenDefs) {
    const binding = {
      name: tokenDef.name,
      type: tokenDef.providerType || "generic",
      credentialEnv: tokenDef.envKey,
    };
    const required = requiredByName.get(binding.name);
    if (!required && !hasPreparedCredential(tokenDef)) continue;
    if (
      !isCanonicalBinding(binding) ||
      plannedByName.has(binding.name) ||
      !required ||
      binding.type !== required.type ||
      binding.credentialEnv !== required.credentialEnv
    ) {
      throw new Error(BINDING_PLAN_ERROR);
    }
    plannedByName.set(binding.name, binding);
  }
  return plannedByName;
}

export function createCredentialProviderRegistration(deps: CredentialProviderRegistrationDeps) {
  const gatewayRunner = (gatewayName = deps.getGatewayName()) =>
    createGatewayScopedOpenshellRunner(deps.runOpenshell, gatewayName);
  function upsertProvider(
    name: string,
    type: string,
    credentialEnv: string,
    baseUrl: string | null,
    env: NodeJS.ProcessEnv = {},
    gatewayName = deps.getGatewayName(),
    options: MessagingProviderRegistrationOptions = {},
  ) {
    const result = providers.upsertProvider(
      name,
      type,
      credentialEnv,
      baseUrl,
      env,
      gatewayRunner(gatewayName),
      options,
    );
    if (result.ok && credentialEnv) {
      const stagedValue = deps.stagedLegacyValues.get(credentialEnv);
      if (stagedValue !== undefined) {
        options.revalidateSandboxIdentity?.(
          `record migrated credential for provider ${JSON.stringify(name)}`,
        );
        const upsertedValue = env[credentialEnv] ?? deps.getCredential(credentialEnv);
        if (upsertedValue === stagedValue) {
          deps.migratedLegacyKeys.add(credentialEnv);
        } else {
          deps.migratedLegacyKeys.delete(credentialEnv);
        }
        deps.persistMigratedLegacyKeys();
      }
    }
    return result;
  }

  function upsertMessagingProvidersAtGateway(
    tokenDefs: MessagingTokenDef[],
    options: MessagingProviderRegistrationOptions,
    gatewayName: string,
    runOpenshell: OpenshellCliHelpers["runOpenshell"] = gatewayRunner(gatewayName),
  ): string[] {
    const upserted = providers.upsertMessagingProviders(tokenDefs, runOpenshell, {
      ...options,
      gatewayName,
    }) as string[];
    recordMigratedLegacyMessagingCredentials(
      tokenDefs,
      upserted,
      deps,
      options.revalidateSandboxIdentity,
    );
    return upserted;
  }

  function upsertMessagingProviders(
    tokenDefs: MessagingTokenDef[],
    options: MessagingProviderRegistrationOptions = {},
  ): string[] {
    const gatewayName = deps.getGatewayName();
    return upsertMessagingProvidersAtGateway(tokenDefs, options, gatewayName);
  }

  function credentialBindingMatchesGateway(
    binding: CheckpointProviderBinding,
    runOpenshell: OpenshellCliHelpers["runOpenshell"],
    messagingProviderProfile?: messagingBridgeProvider.MessagingBridgeProfile,
  ): boolean {
    return (
      inspectGatewayCredentialBinding(binding, runOpenshell, messagingProviderProfile).kind ===
      "exact"
    );
  }

  function inspectGatewayCredentialBinding(
    binding: CheckpointProviderBinding,
    runOpenshell: OpenshellCliHelpers["runOpenshell"],
    messagingProviderProfile?: messagingBridgeProvider.MessagingBridgeProfile,
  ): gatewayProviderMetadata.GatewayCredentialOnlyProviderInspection {
    const profileMatches = messagingBridgeProvider.matchesRegisteredMessagingBridgeProfile(
      binding.type,
      {
        root: deps.root,
        runOpenshell,
        ...(messagingProviderProfile ? { profiles: [messagingProviderProfile] } : {}),
      },
    );
    if (profileMatches === false) return { kind: "indeterminate" };
    const expected = {
      name: binding.name,
      type: binding.type,
      credentialKey: binding.credentialEnv,
    };
    return messagingProviderProfile?.strategy
      ? gatewayProviderMetadata.inspectGatewayCredentialFamilyProviderBinding(
          expected,
          runOpenshell,
        )
      : gatewayProviderMetadata.inspectGatewayCredentialOnlyProviderBinding(expected, runOpenshell);
  }

  function inspectGatewayCredential(
    name: string,
    type: string,
    credentialEnv: string,
    messagingProviderProfile?: messagingBridgeProvider.MessagingBridgeProfile,
  ): gatewayProviderMetadata.GatewayCredentialOnlyProviderInspection {
    return inspectGatewayCredentialBinding(
      { name, type, credentialEnv },
      gatewayRunner(),
      messagingProviderProfile,
    );
  }

  function providerMatchesGatewayCredential(
    name: string,
    type: string,
    credentialEnv: string,
    messagingProviderProfile?: messagingBridgeProvider.MessagingBridgeProfile,
  ): boolean {
    return credentialBindingMatchesGateway(
      { name, type, credentialEnv },
      gatewayRunner(),
      messagingProviderProfile,
    );
  }

  function preflightRequiredCredentialProviderBindings(
    requiredBindings: readonly CheckpointProviderBinding[],
    plannedTokenDefs: ReadonlyMap<string, MessagingTokenDef>,
    runOpenshell: OpenshellCliHelpers["runOpenshell"],
    replaceExisting: boolean,
    requireOwnedExistingProvider: boolean,
    stagedReceipts: ReadonlyMap<string, StagedCredentialProviderReceipt>,
  ): void {
    for (const binding of requiredBindings) {
      const tokenDef = plannedTokenDefs.get(binding.name);
      if (!providers.providerExistsInGateway(binding.name, runOpenshell)) {
        if (!tokenDef || !hasConfiguredMessagingCredential(tokenDef)) {
          throw new Error(MISSING_BINDING_ERROR);
        }
        continue;
      }
      const matches = credentialBindingMatchesGateway(
        binding,
        runOpenshell,
        tokenDef?.messagingProviderProfile,
      );
      if (requireOwnedExistingProvider) {
        const receipt = stagedReceipts.get(binding.name);
        const metadata = gatewayProviderMetadata.readGatewayProviderMetadata(
          binding.name,
          runOpenshell,
        );
        if (!receipt || !metadata?.id || metadata.id !== receipt.providerId) {
          throw new Error(EXISTING_BINDING_ERROR);
        }
        if (replaceExisting && receipt.createdByNemoClaw !== true) {
          throw new Error(EXISTING_BINDING_ERROR);
        }
      }
      if (matches) continue;
      if (!replaceExisting || !tokenDef || !hasConfiguredMessagingCredential(tokenDef)) {
        throw new Error(EXISTING_BINDING_ERROR);
      }
    }
  }

  async function stageSandboxCredentialProviders<Agent>(
    input: StageSandboxCredentialProvidersInput<Agent>,
    prepareCredentialProviders: PrepareCredentialProviders<Agent>,
  ): Promise<readonly CheckpointProviderBinding[]> {
    const messaging = await prepareCredentialProviders(input);
    const stagedReceipts = new Map(
      (deps.loadSession?.()?.stagedCredentialProviderReceipts ?? []).map((receipt) => [
        receipt.providerName,
        receipt,
      ]),
    );
    const preparedTokenDefs = messaging.messagingTokenDefs.map((tokenDef) => {
      const receipt = stagedReceipts.get(tokenDef.name);
      return receipt
        ? {
            ...tokenDef,
            expectedProviderId: receipt.providerId,
            allowProviderReplacement: receipt.createdByNemoClaw,
          }
        : tokenDef;
    });
    input.revalidateSandboxIdentity?.("stage sandbox credential providers after planning");
    const plannedBindings = validatePlannedCredentialProviderBindings(
      preparedTokenDefs,
      input.requiredBindings,
      hasConfiguredMessagingCredential,
    );
    const plannedTokenDefs = new Map(
      preparedTokenDefs.map((tokenDef) => [tokenDef.name, tokenDef]),
    );
    const tokenDefs = preparedTokenDefs.filter(hasConfiguredMessagingCredential);
    const gatewayName = deps.getGatewayName();
    const runOpenshell = gatewayRunner(gatewayName);
    preflightRequiredCredentialProviderBindings(
      input.requiredBindings,
      plannedTokenDefs,
      runOpenshell,
      input.replaceExisting === true,
      input.receiptBackedPackage === true,
      stagedReceipts,
    );
    input.revalidateSandboxIdentity?.("clear staged credential provider receipts");
    setStagedCredentialProviderReceipts(
      tokenDefs.map((tokenDef) => tokenDef.name),
      false,
      deps,
    );
    let mutationReceipt: MessagingProviderMutationReceipt | undefined;
    const registered = upsertMessagingProvidersAtGateway(
      tokenDefs,
      {
        replaceExisting: input.replaceExisting === true,
        allowedSandboxes:
          input.receiptBackedPackage === true || input.replaceExisting === true
            ? [input.sandboxName]
            : undefined,
        requireExactBindings: true,
        requireOwnedExistingProvider: input.receiptBackedPackage === true,
        recordMutationReceipt: (receipt) => {
          mutationReceipt = receipt;
        },
        revalidateSandboxIdentity: input.revalidateSandboxIdentity,
      },
      gatewayName,
      runOpenshell,
    );
    const createdProviderNames = new Set(mutationReceipt?.createdProviderNames ?? []);
    const recordedReceipts = registered.map((providerName) => {
      const metadata = gatewayProviderMetadata.readGatewayProviderMetadata(
        providerName,
        runOpenshell,
      );
      if (!metadata?.id) {
        throw new Error(`OpenShell did not return a stable identity for '${providerName}'.`);
      }
      const prior = stagedReceipts.get(providerName);
      if (prior && prior.providerId !== metadata.id && !input.replaceExisting) {
        throw new Error(EXISTING_BINDING_ERROR);
      }
      return {
        providerName,
        providerId: metadata.id,
        createdByNemoClaw:
          prior?.createdByNemoClaw === true || createdProviderNames.has(providerName),
      } satisfies StagedCredentialProviderReceipt;
    });
    if (recordedReceipts.length > 0) {
      input.revalidateSandboxIdentity?.("record staged credential provider receipts");
      deps.updateSession((current) => {
        const next = new Map(
          (current.stagedCredentialProviderReceipts ?? []).map((receipt) => [
            receipt.providerName,
            receipt,
          ]),
        );
        for (const receipt of recordedReceipts) next.set(receipt.providerName, receipt);
        current.stagedCredentialProviderReceipts = [...next.values()];
        return current;
      });
    }
    setStagedCredentialProviderReceipts(registered, true, deps);
    return registered.map((name) => {
      const binding = plannedBindings.get(name);
      if (!binding) throw new Error(BINDING_PLAN_ERROR);
      return binding;
    });
  }

  return {
    inspectGatewayCredential,
    providerMatchesGatewayCredential,
    stageSandboxCredentialProviders,
    upsertProvider,
    upsertMessagingProviders,
  };
}
