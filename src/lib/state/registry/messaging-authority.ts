// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HarnessPackageStoreOptions } from "../../agent-runtime/package/store";
import { createBuiltInChannelManifestRegistry } from "../../messaging/channels/built-ins";
import type { ChannelManifestRegistry } from "../../messaging/manifest/registry";
import { listMessagingChannelsForSandboxAuthority } from "../../messaging/profile-authority";
import { getHydratedMessagingPlanFromEntry } from "../registry-messaging";
import type { SandboxEntry } from "./types";

export interface RegistryMessagingAuthorityHydrationOptions {
  /** Core channel services used to compose each exact package profile. */
  readonly registry?: ChannelManifestRegistry;
  /** Exact immutable package store used by receipt resolution. */
  readonly packageStore?: HarnessPackageStoreOptions;
}

/** Hydrate derived messaging state after resolving each receipt-backed package profile. */
export function hydrateMessagingRegistryEntriesForAuthority(
  entries: readonly SandboxEntry[],
  options: RegistryMessagingAuthorityHydrationOptions = {},
): SandboxEntry[] {
  const manifestRegistry = options.registry ?? createBuiltInChannelManifestRegistry();
  const packageStore = options.packageStore ?? {};
  return entries.map((entry) => {
    if (entry.messaging?.schemaVersion !== 1) return entry;
    const receiptBacked = entry.harnessPackage != null || entry.harnessPackageMigration != null;
    const manifests = receiptBacked
      ? listMessagingChannelsForSandboxAuthority(entry, manifestRegistry, packageStore)
      : undefined;
    const plan = getHydratedMessagingPlanFromEntry(entry, {
      ...(manifests === undefined ? {} : { manifests }),
    });
    if (!plan) {
      throw new Error(
        `Sandbox '${entry.name}' has invalid messaging state at the hook authority boundary`,
      );
    }
    return { ...entry, messaging: { schemaVersion: 1, plan } };
  });
}
