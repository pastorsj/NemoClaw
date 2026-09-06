// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type LegacyMessagingEntry = {
  readonly agent?: string | null;
  readonly harnessPackage?: unknown;
  readonly harnessPackageMigration?: unknown;
  readonly hermesToolGateways?: readonly string[];
};

function hasPackageAuthority(entry: LegacyMessagingEntry | null): boolean {
  return entry?.harnessPackage != null || entry?.harnessPackageMigration != null;
}

/** Historical no-receipt OpenClaw policy behavior; package plans own current behavior. */
export function legacyUsesTeamsOutlookSharedLogin(entry: LegacyMessagingEntry | null): boolean {
  return !hasPackageAuthority(entry) && entry?.agent !== "hermes";
}

/** Historical no-receipt Hermes diagnostic behavior; package plans own current behavior. */
export function legacyShowsDegradedGatewayLog(entry: LegacyMessagingEntry | null): boolean {
  return !hasPackageAuthority(entry) && entry?.agent === "hermes";
}

/** Historical no-receipt Hermes managed-tool broker ownership. */
export function legacyHasManagedToolGateways(entry: LegacyMessagingEntry | null): boolean {
  return (
    !hasPackageAuthority(entry) &&
    entry?.agent === "hermes" &&
    Array.isArray(entry.hermesToolGateways) &&
    entry.hermesToolGateways.length > 0
  );
}

/** Historical no-receipt OpenClaw npm baseline overlap behavior. */
export function legacyUsesNpmPolicyCompatibility(entry: LegacyMessagingEntry | null): boolean {
  return !hasPackageAuthority(entry) && (!entry?.agent || entry.agent === "openclaw");
}
