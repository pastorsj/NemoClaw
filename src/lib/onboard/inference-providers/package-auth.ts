// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessProviderAuthMethod,
  HarnessProviderSelectionDeclaration,
} from "@nvidia/nemoclaw-harness-contract";

import {
  describeHarnessProviderBroker,
  inspectHarnessProviderBroker,
  runHarnessProviderBrokerController,
} from "../../agent-runtime/provider-broker";
import { harnessPackageIdentitiesEqual } from "../../agent-runtime/package/identity-read";
import type { HarnessPackageIdentity } from "../../agent-runtime/package/types";
import {
  parseSandboxProviderBrokerOwnership,
  type SandboxProviderBrokerOwnership,
} from "../../state/registry/provider-broker";
import {
  inspectGatewayCredentialOnlyProviderBinding,
  inspectGatewayProviderBinding,
  type GatewayCredentialOnlyProviderInspection,
} from "../gateway-provider-metadata";
import { deleteProviderWithRecovery } from "../sandbox-provider-cleanup";
import { assertEndpointResolvesPublic } from "../../inference/endpoint-ssrf-preflight";
import * as oauth from "../../oauth-device-code";
import type { CommonDeps, LookupFn, SetupInferenceResult } from "./types";

export interface PackageProviderAuthDeps extends CommonDeps {
  readonly providerExistsInGateway: (name: string) => boolean;
  readonly lookup?: LookupFn;
  readonly redact: (input: string) => string;
  readonly compactText: (input: string) => string;
  readonly revalidateSandboxIdentity?: (operation: string) => void;
  readonly oauth?: Pick<typeof oauth, "runDeviceCodeFlow" | "mintAgentKeyWithAccessToken">;
  readonly describeProviderBroker?: typeof describeHarnessProviderBroker;
  readonly inspectProviderBroker?: typeof inspectHarnessProviderBroker;
  readonly runProviderBrokerController?: typeof runHarnessProviderBrokerController;
}

function credentialValue(method: HarnessProviderAuthMethod): string | null {
  if (method.kind !== "api-key") return null;
  const direct = process.env[method.source_env]?.trim();
  // check-direct-credential-env-ignore -- this compatibility bridge is consumed only for immediate OpenShell registration and is never persisted.
  const bridge = process.env.NEMOCLAW_PROVIDER_KEY?.trim();
  return direct || bridge || null;
}

async function validateEndpoint(
  endpointUrl: string,
  lookup: LookupFn | undefined,
): Promise<string> {
  try {
    const validated = await assertEndpointResolvesPublic(endpointUrl, lookup);
    if (!validated.ok) throw new Error(validated.reason || "endpoint is not safe to use");
    return endpointUrl;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Inference endpoint URL points to a private or internal address, or could not be resolved: ${message}`,
    );
  }
}

function providerStoreFailure(
  deps: Pick<PackageProviderAuthDeps, "compactText" | "redact" | "runOpenshell">,
): string | null {
  const result = deps.runOpenshell(["provider", "list"], {
    ignoreError: true,
    suppressOutput: true,
    timeout: 10_000,
  });
  if (result.status === 0) return null;
  return (
    deps.compactText(
      deps.redact(`${String(result.stderr ?? "")} ${String(result.stdout ?? "")}`),
    ) ||
    "OpenShell provider storage is unreachable; the gateway may be stopped or refusing connections."
  );
}

function providerInspectionRunner(deps: PackageProviderAuthDeps) {
  return (args: string[], options?: Record<string, unknown>) => {
    const result = deps.runOpenshell(args, options);
    return {
      status: result.status,
      stdout:
        typeof result.stdout === "string" || Buffer.isBuffer(result.stdout) ? result.stdout : null,
      stderr:
        typeof result.stderr === "string" || Buffer.isBuffer(result.stderr) ? result.stderr : null,
    };
  };
}

function readProviderBrokerOwnership(
  identity: HarnessPackageIdentity,
  sandboxName: string,
  expectedProviderName: string,
  deps: PackageProviderAuthDeps,
): SandboxProviderBrokerOwnership | null {
  const getSandbox = deps.registry.getSandbox;
  if (!getSandbox) {
    throw new Error("Provider-broker setup cannot inspect its durable sandbox receipt");
  }
  const sandbox = getSandbox(sandboxName);
  if (!sandbox) return null;
  if (!sandbox.harnessPackage || !harnessPackageIdentitiesEqual(sandbox.harnessPackage, identity)) {
    throw new Error("Provider-broker setup does not own the recorded sandbox package receipt");
  }
  if (!sandbox.providerBroker) return null;
  const ownership = parseSandboxProviderBrokerOwnership(sandbox.providerBroker, identity);
  if (ownership.providerName !== expectedProviderName) {
    throw new Error("Provider-broker ownership does not match its package-declared provider");
  }
  return ownership;
}

function requireExactRecordedProvider(
  ownership: SandboxProviderBrokerOwnership,
  deps: PackageProviderAuthDeps,
): void {
  const inspection = inspectGatewayCredentialOnlyProviderBinding(
    {
      name: ownership.providerName,
      type: ownership.providerType,
      credentialKey: ownership.credentialEnv,
    },
    providerInspectionRunner(deps),
  );
  if (inspection.kind === "exact") return;
  if (inspection.kind === "indeterminate") {
    throw new Error("Recorded provider-broker metadata could not be inspected exactly");
  }
  if (inspection.kind === "missing") {
    throw new Error("Recorded provider-broker provider disappeared during reuse qualification");
  }
  throw new Error("Recorded provider-broker metadata does not match its durable ownership receipt");
}

function reusableProviderBrokerIsReady(
  identity: HarnessPackageIdentity,
  sandboxName: string,
  deps: PackageProviderAuthDeps,
): boolean {
  const describeProviderBroker = deps.describeProviderBroker ?? describeHarnessProviderBroker;
  const expectedProviderName = describeProviderBroker(identity, sandboxName);
  const ownership = readProviderBrokerOwnership(identity, sandboxName, expectedProviderName, deps);
  if (!deps.providerExistsInGateway(expectedProviderName)) return false;
  if (!ownership) {
    throw new Error(
      "An existing provider-broker provider has no matching durable package ownership receipt",
    );
  }
  requireExactRecordedProvider(ownership, deps);
  const inspectProviderBroker = deps.inspectProviderBroker ?? inspectHarnessProviderBroker;
  const inspection = inspectProviderBroker(identity, sandboxName);
  if (inspection.providerName !== expectedProviderName) {
    throw new Error("Provider-broker inspection changed its package-declared provider name");
  }
  return inspection.brokerReady && inspection.sandboxRegistered;
}

function upsertCredential(
  selection: HarnessProviderSelectionDeclaration,
  method: HarnessProviderAuthMethod,
  endpointUrl: string,
  value: string,
  providerKnownExact: boolean,
  deps: PackageProviderAuthDeps,
): void {
  deps.revalidateSandboxIdentity?.("register the package inference provider credential");
  const result = deps.upsertProvider(
    selection.provider_name,
    selection.provider_type,
    method.credential_env,
    endpointUrl,
    { [method.credential_env]: value },
    {
      knownExists: providerKnownExact,
      requireExactBinding: providerKnownExact,
      ...(deps.revalidateSandboxIdentity
        ? { revalidateSandboxIdentity: deps.revalidateSandboxIdentity }
        : {}),
    },
  );
  if (!result.ok) {
    throw new Error(result.message || `failed to upsert provider '${selection.provider_name}'`);
  }
}

function inspectPackageProviderBinding(
  selection: HarnessProviderSelectionDeclaration,
  method: HarnessProviderAuthMethod,
  deps: PackageProviderAuthDeps,
): GatewayCredentialOnlyProviderInspection {
  const expected = {
    name: selection.provider_name,
    type: selection.provider_type,
    credentialKey: method.credential_env,
  };
  if (selection.provider_type === "openai" || selection.provider_type === "anthropic") {
    return inspectGatewayProviderBinding(
      {
        ...expected,
        configKey: selection.provider_type === "openai" ? "OPENAI_BASE_URL" : "ANTHROPIC_BASE_URL",
      },
      deps.runOpenshell,
    );
  }
  return inspectGatewayCredentialOnlyProviderBinding(expected, deps.runOpenshell);
}

function registerProviderBroker(
  identity: HarnessPackageIdentity,
  sandboxName: string,
  refreshToken: string,
  deps: PackageProviderAuthDeps,
): void {
  const describeProviderBroker = deps.describeProviderBroker ?? describeHarnessProviderBroker;
  const runProviderBrokerController =
    deps.runProviderBrokerController ?? runHarnessProviderBrokerController;
  const expectedProviderName = describeProviderBroker(identity, sandboxName);
  const expectedBinding = {
    name: expectedProviderName,
    type: "generic",
    credentialKey: "",
  };
  const recordedOwnership = readProviderBrokerOwnership(
    identity,
    sandboxName,
    expectedProviderName,
    deps,
  );
  const providerExistedBefore = deps.providerExistsInGateway(expectedProviderName);
  if (providerExistedBefore) {
    if (!recordedOwnership) {
      throw new Error(
        "An existing provider-broker provider has no matching durable package ownership receipt",
      );
    }
    requireExactRecordedProvider(recordedOwnership, deps);
  }
  let controllerAttempted = false;
  let providerCreated = false;
  let durableOwnershipRecorded = recordedOwnership !== null;
  try {
    deps.revalidateSandboxIdentity?.("register the package provider-broker credential");
    controllerAttempted = true;
    const registration = runProviderBrokerController(identity, {
      operation: "register-refresh-provider",
      sandboxName,
      refreshToken,
    });
    if (!registration.ok || !registration.credentialEnv || !registration.credentialValue) {
      throw new Error("Harness provider-broker registration did not return a credential binding");
    }
    if (registration.providerName !== expectedProviderName) {
      throw new Error("Harness provider-broker registration changed its declared provider name");
    }
    expectedBinding.credentialKey = registration.credentialEnv;
    if (
      recordedOwnership &&
      (recordedOwnership.providerName !== registration.providerName ||
        recordedOwnership.credentialEnv !== registration.credentialEnv)
    ) {
      throw new Error("Provider-broker registration changed its durable provider binding");
    }
    if (!providerExistedBefore) {
      const lateInspection = inspectGatewayCredentialOnlyProviderBinding(
        expectedBinding,
        providerInspectionRunner(deps),
      );
      if (lateInspection.kind !== "missing") {
        throw new Error(
          lateInspection.kind === "indeterminate"
            ? "Provider-broker provider absence could not be proven before registration"
            : "Provider-broker provider ownership changed before registration",
        );
      }
    }
    const providerResult = deps.upsertProvider(
      registration.providerName,
      "generic",
      registration.credentialEnv,
      null,
      { [registration.credentialEnv]: registration.credentialValue },
      providerExistedBefore ? { knownExists: true, requireExactBinding: true } : undefined,
    );
    if (!providerResult.ok) {
      throw new Error(
        providerResult.message || `failed to upsert provider '${registration.providerName}'`,
      );
    }
    providerCreated = !providerExistedBefore;
    if (!recordedOwnership) {
      deps.revalidateSandboxIdentity?.("record the package provider-broker ownership");
      const recorded = deps.registry.updateSandbox(sandboxName, {
        providerBroker: parseSandboxProviderBrokerOwnership(
          {
            schemaVersion: 1,
            harnessPackage: identity,
            providerName: registration.providerName,
            providerType: "generic",
            credentialEnv: registration.credentialEnv,
          },
          identity,
        ),
      });
      if (recorded !== true) {
        throw new Error("Provider-broker durable ownership could not be recorded");
      }
      durableOwnershipRecorded = true;
    }
  } catch (error) {
    if (!durableOwnershipRecorded) {
      let compensationFailed = false;
      if (providerCreated) {
        const cleanupRunOpenshell = providerInspectionRunner(deps);
        const inspection = inspectGatewayCredentialOnlyProviderBinding(
          expectedBinding,
          cleanupRunOpenshell,
        );
        if (inspection.kind === "exact") {
          const deleted = deleteProviderWithRecovery(expectedProviderName, {
            runOpenshell: cleanupRunOpenshell,
            allowedSandboxes: [sandboxName],
          });
          compensationFailed ||= !deleted.ok;
        } else if (inspection.kind !== "missing") {
          compensationFailed = true;
        }
      }
      if (controllerAttempted) {
        try {
          runProviderBrokerController(identity, {
            operation: "teardown-broker",
            sandboxName,
          });
        } catch {
          compensationFailed = true;
        }
      }
      if (compensationFailed) {
        throw new Error("Provider-broker setup failed and compensating cleanup was incomplete");
      }
    }
    throw error;
  }
  deps.revalidateSandboxIdentity?.("start the package provider-broker");
  const ensured = runProviderBrokerController(identity, {
    operation: "ensure-broker",
    sandboxName,
    refreshToken,
  });
  if (!ensured.ok || ensured.providerName !== expectedProviderName) {
    throw new Error("Harness provider-broker startup did not confirm its declared provider");
  }
}

async function prepareCredential(
  args: {
    readonly identity: HarnessPackageIdentity;
    readonly sandboxName: string;
    readonly selection: HarnessProviderSelectionDeclaration;
    readonly method: HarnessProviderAuthMethod;
    readonly endpointUrl: string;
    readonly providerKnownExact: boolean;
    readonly toolGatewaySelections: readonly string[];
  },
  deps: PackageProviderAuthDeps,
): Promise<void> {
  if (args.method.kind === "api-key") {
    const key = credentialValue(args.method);
    if (!key) throw new Error(`${args.method.label} is not available on the host`);
    upsertCredential(
      args.selection,
      args.method,
      args.endpointUrl,
      key,
      args.providerKnownExact,
      deps,
    );
    return;
  }

  if (deps.isNonInteractive()) {
    throw new Error(`${args.method.label} requires interactive browser authorization`);
  }
  const oauthEngine = deps.oauth ?? oauth;
  const tokens = await oauthEngine.runDeviceCodeFlow({
    portalBaseUrl: args.method.device_code.portal_base_url,
    clientId: args.method.device_code.client_id,
    scope: args.method.device_code.scope,
    providerLabel: args.selection.label,
  });
  const minted = await oauthEngine.mintAgentKeyWithAccessToken(tokens.access_token, {
    portalBaseUrl: args.method.device_code.portal_base_url,
    minTtlSeconds: args.method.device_code.minimum_credential_ttl_seconds,
  });
  const endpointUrl = await validateEndpoint(
    minted.inference_base_url || args.endpointUrl,
    deps.lookup,
  );
  upsertCredential(
    args.selection,
    args.method,
    endpointUrl,
    minted.api_key,
    args.providerKnownExact,
    deps,
  );
  if (args.toolGatewaySelections.length > 0) {
    registerProviderBroker(args.identity, args.sandboxName, tokens.refresh_token, deps);
  }
}

/** Configure a receipt-selected provider while NemoClaw retains all secret and route mutations. */
export async function setupPackageProviderInference(
  args: {
    readonly identity: HarnessPackageIdentity;
    readonly sandboxName: string | null;
    readonly model: string;
    readonly provider: string;
    readonly endpointUrl: string | null;
    readonly credentialEnv: string | null;
    readonly selection: HarnessProviderSelectionDeclaration;
    readonly method: HarnessProviderAuthMethod;
    readonly toolGatewaySelections: readonly string[];
  },
  deps: PackageProviderAuthDeps,
): Promise<SetupInferenceResult> {
  if (!args.sandboxName) throw new Error("Package provider authentication requires a sandbox name");
  if (
    args.provider !== args.selection.provider_name ||
    args.credentialEnv !== args.method.credential_env
  ) {
    throw new Error("Receipt-backed provider authentication drifted from its package declaration");
  }
  const endpointUrl = await validateEndpoint(
    args.endpointUrl || args.selection.endpoint_url,
    deps.lookup,
  );
  const providerStoreError = providerStoreFailure(deps);
  if (providerStoreError) {
    deps.error("  ✗ OpenShell provider storage is unreachable.");
    deps.error(`    ${providerStoreError}`);
    deps.error("    Restart or recreate the OpenShell gateway, then rerun onboarding.");
    if (deps.isNonInteractive()) return deps.exitProcess(1);
    return { retry: "selection" };
  }

  const providerInspection = inspectPackageProviderBinding(args.selection, args.method, deps);
  if (providerInspection.kind === "collision" || providerInspection.kind === "indeterminate") {
    deps.error(
      providerInspection.kind === "collision"
        ? `  Existing provider '${args.provider}' does not match the receipt-declared type, credential, and endpoint configuration binding.`
        : `  OpenShell could not prove the binding of existing provider '${args.provider}'.`,
    );
    deps.error("  No provider credential or inference route was changed.");
    if (deps.isNonInteractive()) return deps.exitProcess(1);
    return { retry: "selection" };
  }

  let brokerProviderReady = args.toolGatewaySelections.length === 0;
  if (!brokerProviderReady) {
    try {
      brokerProviderReady = reusableProviderBrokerIsReady(args.identity, args.sandboxName, deps);
    } catch (error) {
      deps.error(
        `  ✗ Failed to qualify ${args.selection.label} provider-broker reuse: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      if (deps.isNonInteractive()) return deps.exitProcess(1);
      return { retry: "selection" };
    }
  }
  const shouldPrepareCredential =
    providerInspection.kind === "missing" ||
    !brokerProviderReady ||
    credentialValue(args.method) !== null ||
    (args.method.kind === "oauth-device-code" && !deps.isNonInteractive());
  if (shouldPrepareCredential) {
    try {
      await prepareCredential(
        {
          identity: args.identity,
          sandboxName: args.sandboxName,
          selection: args.selection,
          method: args.method,
          endpointUrl,
          providerKnownExact: providerInspection.kind === "exact",
          toolGatewaySelections: args.toolGatewaySelections,
        },
        deps,
      );
    } catch (error) {
      deps.error(
        `  ✗ Failed to prepare ${args.selection.label} credentials: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      if (deps.isNonInteractive()) return deps.exitProcess(1);
      return { retry: "selection" };
    }
  }

  deps.revalidateSandboxIdentity?.("apply the package inference provider route");
  const applyResult = deps.runOpenshell(
    ["inference", "set", "--no-verify", "--provider", args.provider, "--model", args.model],
    { ignoreError: true },
  );
  if (applyResult.status !== 0) {
    const message =
      deps.compactText(
        deps.redact(`${String(applyResult.stderr ?? "")} ${String(applyResult.stdout ?? "")}`),
      ) || `Failed to configure inference provider '${args.provider}'.`;
    deps.error(`  ${message}`);
    if (deps.isNonInteractive()) return deps.exitProcess(applyResult.status || 1);
    return { retry: "selection" };
  }

  deps.verifyInferenceRoute(args.provider, args.model);
  await deps.verifyOnboardInferenceSmoke({
    provider: args.provider,
    model: args.model,
    endpointUrl,
    credentialEnv: args.credentialEnv,
  });
  deps.registry.updateSandbox(args.sandboxName, {
    provider: args.provider,
    model: args.model,
  });
  deps.log(`  ✓ Inference route set: ${args.provider} / ${args.model}`);
  return { ok: true };
}
