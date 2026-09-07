// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { normalizeCredentialValue } from "../../credentials/value";
import type { ModelPromptResult } from "../../inference/model-prompts";
import {
  resolveHarnessProviderAuthCapability,
  resolveHarnessProviderAuthMethod,
} from "../../agent-runtime/provider-auth";
import type { HarnessPackageIdentity } from "../../agent-runtime/package/types";
import type { SetupNimSelectionState } from "../setup-nim-selection";
import {
  selectPackageToolGateways,
  type PackageToolGatewaySelectionDeps,
} from "./tool-gateway-selection";

export interface PackageRemoteProviderConfig {
  readonly label: string;
  readonly providerName: string;
  readonly providerType: string;
  readonly credentialEnv: string;
  readonly endpointUrl: string;
  readonly helpUrl: string | null;
  readonly modelMode: "curated";
  readonly defaultModel: string;
  readonly skipVerify: true;
}

export interface PackageRemoteProviderSelection {
  readonly identity: HarnessPackageIdentity;
  readonly selectedKey: string;
  readonly config: PackageRemoteProviderConfig;
}

export interface PackageProviderAuthSelectionDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly isNonInteractive: () => boolean;
  readonly prompt: (question: string, options?: { secret?: boolean }) => Promise<string>;
  readonly getNavigationChoice: (value?: string) => "back" | "exit" | null;
  readonly exitOnboardFromPrompt: () => never;
  readonly exitProcess: (code: number) => never;
  readonly error: (message: string) => void;
  readonly log: (message?: string) => void;
  readonly note: (message: string) => void;
  readonly validateCredential: (value: string, environmentName: string) => string | null;
  readonly isBackToSelection: (value: unknown) => boolean;
  readonly promptRemoteModel: (
    label: string,
    providerKey: string,
    defaultModel: string,
    validator: null,
    options: {
      readonly otherShowsFullList: true;
      readonly remoteModelOptions: Readonly<Record<string, string[]>>;
      readonly topLevelModelLimit: number;
    },
  ) => Promise<ModelPromptResult>;
}

export interface PackageProviderRuntimeSelectionDeps {
  readonly providerAuth: PackageProviderAuthSelectionDeps;
  readonly toolGateways: PackageToolGatewaySelectionDeps;
  readonly assertMutationAuthority: (operation: string) => void;
  readonly getSandbox: (
    name: string,
  ) => { readonly toolGatewaySelections?: unknown } | null | undefined;
}

/** Resolve the provider configuration declared by an installed harness package. */
export function resolvePackageRemoteProviderSelection(
  identity: HarnessPackageIdentity | null,
  selectedKey: string,
): PackageRemoteProviderSelection | null {
  if (!identity) return null;
  const capability = resolveHarnessProviderAuthCapability(identity);
  if (!capability || capability.selection.key !== selectedKey) return null;
  return {
    identity,
    selectedKey,
    config: {
      label: capability.selection.label,
      providerName: capability.selection.provider_name,
      providerType: capability.selection.provider_type,
      credentialEnv: capability.methods[0]?.credential_env ?? "",
      endpointUrl: capability.selection.endpoint_url,
      helpUrl: capability.selection.help_url,
      modelMode: "curated",
      defaultModel: capability.selection.default_model,
      skipVerify: true,
    },
  };
}

/** Prefer a receipt-declared provider configuration when the package owns the selection. */
export function requirePackageRemoteProviderConfig<T>(
  selection: PackageRemoteProviderSelection | null,
  fallback: T | undefined,
  selectedKey: string,
): PackageRemoteProviderConfig | T {
  const config = selection?.config ?? fallback;
  if (!config) throw new Error(`Missing remote provider config for '${selectedKey}'.`);
  return config;
}

function requestedAuthMethod(names: readonly string[], env: NodeJS.ProcessEnv): string | null {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

function directCredential(environmentName: string, env: NodeJS.ProcessEnv): string | null {
  return (
    // check-direct-credential-env-ignore -- receipt-declared API keys stay in the invoking process only until core registers them with OpenShell.
    normalizeCredentialValue(env[environmentName]) ||
    // check-direct-credential-env-ignore -- compatibility bridge is filtered as a secret value and never treated as a provider selector here.
    normalizeCredentialValue(env.NEMOCLAW_PROVIDER_KEY) ||
    null
  );
}

async function chooseAuthMethod(
  identity: HarnessPackageIdentity,
  deps: PackageProviderAuthSelectionDeps,
) {
  const capability = resolveHarnessProviderAuthCapability(identity);
  if (!capability)
    throw new Error("Installed harness package does not support managed provider authentication");
  const availableCredentialEnvs = capability.methods
    .filter((method) => method.kind === "api-key" && directCredential(method.source_env, deps.env))
    .map((method) => (method.kind === "api-key" ? method.source_env : method.credential_env));
  const requested = requestedAuthMethod(capability.request_environment, deps.env);
  if (deps.isNonInteractive()) {
    const method = resolveHarnessProviderAuthMethod(identity, {
      requestedMethod: requested,
      availableCredentialEnvs,
    });
    deps.note(`  [non-interactive] Provider authentication: ${method.label}`);
    return method;
  }

  const requestedPlan = resolveHarnessProviderAuthMethod(identity, {
    requestedMethod: requested ?? capability.default_method,
    availableCredentialEnvs,
  });
  deps.log("");
  deps.log(`  ${capability.selection.label} authentication:`);
  capability.methods.forEach((method, index) =>
    deps.log(`    ${String(index + 1)}) ${method.label}`),
  );
  deps.log("");
  const defaultIndex = Math.max(
    0,
    capability.methods.findIndex((method) => method.id === requestedPlan.id),
  );
  const choice = await deps.prompt(`  Choose [${String(defaultIndex + 1)}]: `);
  const navigation = deps.getNavigationChoice(choice);
  if (navigation === "back") return null;
  if (navigation === "exit") deps.exitOnboardFromPrompt();
  const index = Number.parseInt(choice || String(defaultIndex + 1), 10) - 1;
  const selected = capability.methods[index] ?? capability.methods[defaultIndex];
  return resolveHarnessProviderAuthMethod(identity, {
    requestedMethod: selected?.id ?? capability.default_method,
    availableCredentialEnvs,
  });
}

/** Apply one receipt-backed provider selection without a harness-name branch in core. */
export async function selectPackageProviderAuth(
  identity: HarnessPackageIdentity,
  selectedKey: string,
  requestedModel: string | null,
  state: SetupNimSelectionState,
  deps: PackageProviderAuthSelectionDeps,
): Promise<"selected" | "retry-selection" | "not-managed"> {
  const capability = resolveHarnessProviderAuthCapability(identity);
  if (!capability || capability.selection.key !== selectedKey) return "not-managed";
  const method = await chooseAuthMethod(identity, deps);
  if (!method) {
    deps.log("  Returning to provider selection.");
    deps.log("");
    return "retry-selection";
  }

  state.provider = capability.selection.provider_name;
  state.endpointUrl = capability.selection.endpoint_url;
  state.credentialEnv = method.credential_env;
  state.providerAuthMethod = method.id;
  state.hermesAuthMethod = null;
  state.preferredInferenceApi = capability.selection.preferred_inference_api;

  if (method.kind === "api-key") {
    let credential = directCredential(method.source_env, deps.env);
    if (!credential && !deps.isNonInteractive()) {
      deps.log("");
      deps.log(`  ${method.prompt_label}`);
      deps.log(`  Create or copy a key from ${capability.selection.help_url}`);
      const input = await deps.prompt(`  ${method.prompt_label}: `, { secret: true });
      const navigation = deps.getNavigationChoice(input);
      if (navigation === "back") return "retry-selection";
      if (navigation === "exit") deps.exitOnboardFromPrompt();
      credential = normalizeCredentialValue(input);
    }
    if (!credential) {
      deps.error(`  ${method.prompt_label} is required in non-interactive mode.`);
      deps.exitProcess(1);
    }
    const validationError = deps.validateCredential(credential, method.source_env);
    if (validationError) {
      deps.error(validationError);
      deps.exitProcess(1);
    }
    deps.env[method.source_env] = credential;
  }

  const defaultModel = requestedModel || capability.selection.default_model;
  state.model = deps.isNonInteractive()
    ? defaultModel
    : await deps.promptRemoteModel(
        capability.selection.label,
        capability.selection.key,
        defaultModel,
        null,
        {
          otherShowsFullList: true,
          remoteModelOptions: { [capability.selection.key]: [...capability.selection.models] },
          topLevelModelLimit: 10,
        },
      );
  if (deps.isBackToSelection(state.model)) {
    deps.log("  Returning to provider selection.");
    deps.log("");
    return "retry-selection";
  }
  state.assertRouteCompatible?.();
  deps.log(`  Using ${capability.selection.label} with model: ${String(state.model)}`);
  return "selected";
}

/** Complete receipt-backed provider authentication and managed-tool selection. */
export async function selectPackageProviderRuntime(
  selection: PackageRemoteProviderSelection,
  requestedModel: string | null,
  recoveredFromSandbox: boolean,
  recoveredModel: string | null,
  sandboxName: string | null,
  state: SetupNimSelectionState,
  deps: PackageProviderRuntimeSelectionDeps,
): Promise<"selected" | "retry-selection"> {
  deps.assertMutationAuthority("stage the package provider credential");
  const result = await selectPackageProviderAuth(
    selection.identity,
    selection.selectedKey,
    requestedModel || (recoveredFromSandbox ? recoveredModel : null),
    state,
    deps.providerAuth,
  );
  if (result === "retry-selection") return result;
  if (result === "not-managed") {
    throw new Error("Receipt-backed provider selection changed during authentication");
  }

  const registeredSandbox = sandboxName ? deps.getSandbox(sandboxName) : null;
  const toolGatewayResult = await selectPackageToolGateways(
    selection.identity,
    state.providerAuthMethod ?? "",
    registeredSandbox?.toolGatewaySelections,
    deps.toolGateways,
  );
  deps.assertMutationAuthority("record package managed-tool selections");
  state.toolGatewaySelections = [...toolGatewayResult.selections];
  state.hermesToolGateways = [];
  return "selected";
}
