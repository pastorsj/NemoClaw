// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type { HarnessStartupSettings } from "@nvidia/nemoclaw-harness-contract";

import type { HarnessPackageIdentity } from "../../agent-runtime/package/types";
import {
  loadHarnessStartupProfileAdapterHostModule,
  type HarnessStartupProfileAdapterHostModule,
} from "../../agent-runtime/startup-module";
import { validateManagedStartupCorporateCaTransport } from "./application";
import {
  encodeManagedStartupDurableProfile,
  type ManagedStartupJsonObject,
  type ManagedStartupPackageProfile,
  type ManagedStartupProfile,
  validateManagedStartupPackageProfile,
} from "./profile";
import type { ValidatedManagedStartupProfileTransport } from "./profile-builder";
import {
  buildManagedStartupPackagePreparationInput,
  type ManagedStartupPackagePreparationSource,
} from "./package-input";

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
  readonly desiredState: HarnessStartupSettings;
  readonly packageConfig: ManagedStartupJsonObject;
  readonly corporateCaB64?: string;
  readonly credentialProxyReplayRequired: boolean;
  readonly dashboardRemoteBindPrepared: boolean;
}

export type BuildInitialManagedStartupPackageProfileInput = Omit<
  BuildManagedStartupPackageProfileInput,
  "packageConfig"
>;

export interface PrepareInitialManagedStartupPackageProfileInput {
  readonly harnessPackage: HarnessPackageIdentity;
  readonly source: ManagedStartupPackagePreparationSource;
}

export class ManagedStartupPackageProfileError extends Error {
  override readonly name = "ManagedStartupPackageProfileError";
}

export type LoadHarnessStartupProfileAdapter = (
  identity: HarnessPackageIdentity,
) => HarnessStartupProfileAdapterHostModule;

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
    desiredState: input.desiredState,
    packageConfig: input.packageConfig,
    corporateCa: input.desiredState.corporateCa,
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

/**
 * Ask the exact receipt-pinned package to construct its opaque startup config,
 * then bind that config to core-owned normalized intent in one durable envelope.
 */
export function buildInitialManagedStartupPackageProfile(
  input: BuildInitialManagedStartupPackageProfileInput,
  loadAdapter: LoadHarnessStartupProfileAdapter = loadHarnessStartupProfileAdapterHostModule,
): BuiltManagedStartupPackageProfile {
  const result = loadAdapter(input.harnessPackage).buildInitialStartupProfile({
    packageId: input.harnessPackage.id,
    harnessPackage: input.harnessPackage,
    desiredState: input.desiredState,
  });
  if (result.kind === "unsupported") {
    throw new ManagedStartupPackageProfileError(
      `Harness package '${input.harnessPackage.id}' does not support managed startup profiles: ${result.reason}`,
    );
  }
  return buildManagedStartupPackageProfile({
    ...input,
    packageConfig: result.packageConfig as ManagedStartupJsonObject,
  });
}

/** Ask the exact package to normalize raw operator input before it creates opaque durable state. */
export function prepareInitialManagedStartupPackageProfile(
  input: PrepareInitialManagedStartupPackageProfileInput,
  loadAdapter: LoadHarnessStartupProfileAdapter = loadHarnessStartupProfileAdapterHostModule,
): BuiltManagedStartupPackageProfile {
  const adapter = loadAdapter(input.harnessPackage);
  const preparedInput = buildManagedStartupPackagePreparationInput(
    input.source,
    adapter.startupProfileEnvironment,
  );
  const result = adapter.prepareStartupProfile({
    packageId: input.harnessPackage.id,
    harnessPackage: input.harnessPackage,
    phase: "initial",
    input: preparedInput.input,
    previousDesiredState: null,
  });
  if (result.kind === "unsupported") {
    throw new ManagedStartupPackageProfileError(
      `Harness package '${input.harnessPackage.id}' does not support startup profile preparation: ${result.reason}`,
    );
  }
  return buildInitialManagedStartupPackageProfile(
    {
      harnessPackage: input.harnessPackage,
      desiredState: result.desiredState,
      ...(preparedInput.corporateCaB64 === undefined
        ? {}
        : { corporateCaB64: preparedInput.corporateCaB64 }),
      credentialProxyReplayRequired: result.credentialProxyReplayRequired,
      dashboardRemoteBindPrepared: result.dashboardRemoteBindPrepared,
    },
    () => adapter,
  );
}
