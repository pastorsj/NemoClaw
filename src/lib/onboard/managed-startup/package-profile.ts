// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type { HarnessStartupSettings } from "@nvidia/nemoclaw-harness-contract";

import type { HarnessPackageIdentity } from "../../agent-runtime/package/types";
import { validateManagedStartupCorporateCaTransport } from "./application";
import {
  encodeManagedStartupDurableProfile,
  type ManagedStartupJsonObject,
  type ManagedStartupPackageProfile,
  type ManagedStartupProfile,
  validateManagedStartupPackageProfile,
} from "./profile";
import type { ValidatedManagedStartupProfileTransport } from "./profile-builder";

export interface BuiltManagedStartupPackageProfile {
  readonly profile: ManagedStartupPackageProfile;
  readonly encodedProfile: ValidatedManagedStartupProfileTransport;
  readonly startupProfileSha256: string;
  readonly corporateCaB64?: string;
  readonly credentialProxyReplayRequired: boolean;
  readonly dashboardRemoteBindPrepared: boolean;
}

export interface BuildManagedStartupPackageProfileInput {
  readonly harnessPackage: HarnessPackageIdentity;
  readonly settings: HarnessStartupSettings;
  readonly corporateCaB64?: string;
  readonly credentialProxyReplayRequired: boolean;
  readonly dashboardRemoteBindPrepared: boolean;
}

/** Project the existing finite startup semantics into the public package request shape. */
export function managedStartupSettingsFromProfile(
  profile: ManagedStartupProfile,
): HarnessStartupSettings {
  return {
    configuration: profile.agentConfig,
    inference: profile.inference,
    proxy: profile.proxy,
    dashboard: profile.dashboard,
    tools: profile.tools,
    messaging: profile.messaging,
    tuning: profile.tuning,
    corporateCa: profile.corporateCa,
  };
}

/**
 * Build the durable, receipt-backed envelope consumed by a package startup
 * adapter. Core validates identity, JSON bounds, credentials, CA material, and
 * transport integrity without interpreting the package's native config.
 */
export function buildManagedStartupPackageProfile(
  input: BuildManagedStartupPackageProfileInput,
): BuiltManagedStartupPackageProfile {
  const profile = validateManagedStartupPackageProfile({
    schemaVersion: 1,
    profileKind: "package",
    agent: input.harnessPackage.id,
    harnessPackage: input.harnessPackage,
    packageConfig: { settings: input.settings } as unknown as ManagedStartupJsonObject,
    corporateCa: input.settings.corporateCa,
  });
  validateManagedStartupCorporateCaTransport(input.corporateCaB64, profile);
  const encodedProfile = encodeManagedStartupDurableProfile(
    profile,
  ) as ValidatedManagedStartupProfileTransport;
  const startupProfileSha256 = createHash("sha256").update(encodedProfile, "utf8").digest("hex");
  return Object.freeze({
    profile,
    encodedProfile,
    startupProfileSha256,
    credentialProxyReplayRequired: input.credentialProxyReplayRequired,
    dashboardRemoteBindPrepared: input.dashboardRemoteBindPrepared,
    ...(input.corporateCaB64 === undefined ? {} : { corporateCaB64: input.corporateCaB64 }),
  });
}
