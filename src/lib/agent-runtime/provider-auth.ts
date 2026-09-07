// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessProviderAuthCapability,
  HarnessProviderAuthMethod,
  HarnessProviderAuthPlanRequest,
  HarnessProviderSelectionDeclaration,
} from "@nvidia/nemoclaw-harness-contract";

import { HARNESS_PROVIDER_AUTH_ADAPTER_CONTRACT } from "./adapter/provider-auth";
import { HarnessAdapterError, loadHarnessAdapter } from "./adapter/loader";
import { readObject, readString } from "./manifest-readers";
import { resolvePinnedHarnessPackage, type HarnessPackageStoreOptions } from "./package/pinned";
import type { HarnessPackageIdentity } from "./package/types";

export class HarnessProviderAuthError extends Error {
  override readonly name = "HarnessProviderAuthError";
}

function readDeclaredCapability(
  identity: HarnessPackageIdentity,
  options: HarnessPackageStoreOptions = {},
): HarnessProviderAuthCapability | null {
  const installed = resolvePinnedHarnessPackage(identity, options);
  if (readString(installed.packageManifest.manifest, "name") !== identity.id) {
    throw new HarnessProviderAuthError(
      "Installed harness package manifest does not match its receipt",
    );
  }
  const value = readObject(installed.packageManifest.manifest, "provider_auth");
  if (!value) return null;
  return value as unknown as HarnessProviderAuthCapability;
}

function readManagedCapability(
  identity: HarnessPackageIdentity,
  options: HarnessPackageStoreOptions = {},
): Extract<HarnessProviderAuthCapability, { readonly support: "managed" }> {
  const value = readDeclaredCapability(identity, options);
  if (value?.support !== "managed" || value.adapter !== "provider-auth") {
    throw new HarnessProviderAuthError(
      "Installed harness package does not support managed provider authentication",
    );
  }
  return value;
}

/** Resolve the provider entry from the exact package object selected by a receipt. */
export function resolveHarnessProviderSelection(
  identity: HarnessPackageIdentity,
  options: HarnessPackageStoreOptions = {},
): HarnessProviderSelectionDeclaration {
  return readManagedCapability(identity, options).selection;
}

/** True when this receipt, rather than a hard-coded harness name, owns the selected provider. */
export function isHarnessManagedProvider(
  identity: HarnessPackageIdentity,
  providerName: string,
  options: HarnessPackageStoreOptions = {},
): boolean {
  const capability = resolveHarnessProviderAuthCapability(identity, options);
  return capability?.selection.provider_name === providerName;
}

/** Resolve and cross-check one secret-free auth choice through the receipt-bound package adapter. */
export function resolveHarnessProviderAuthMethod(
  identity: HarnessPackageIdentity,
  request: HarnessProviderAuthPlanRequest,
  options: HarnessPackageStoreOptions = {},
): HarnessProviderAuthMethod {
  const capability = readManagedCapability(identity, options);
  try {
    const result = loadHarnessAdapter(
      identity,
      HARNESS_PROVIDER_AUTH_ADAPTER_CONTRACT,
      options,
    ).resolve(request);
    if (result.kind !== "managed") throw new HarnessProviderAuthError(result.reason);
    const method = capability.methods.find((candidate) => candidate.id === result.methodId);
    if (!method) {
      throw new HarnessProviderAuthError(
        "Provider-auth adapter selected an undeclared authentication method",
      );
    }
    return method;
  } catch (error) {
    if (error instanceof HarnessProviderAuthError) throw error;
    if (error instanceof HarnessAdapterError) {
      throw new HarnessProviderAuthError(error.message, { cause: error });
    }
    throw error;
  }
}

/** Return the complete receipt-backed declaration for core-owned prompting and validation. */
export function resolveHarnessProviderAuthCapability(
  identity: HarnessPackageIdentity,
  options: HarnessPackageStoreOptions = {},
): Extract<HarnessProviderAuthCapability, { readonly support: "managed" }> | null {
  const capability = readDeclaredCapability(identity, options);
  return capability?.support === "managed" ? capability : null;
}
