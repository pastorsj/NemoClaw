// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HarnessWebSearchProviderBinding } from "./manifest.js";

function objectRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

/**
 * Prove that a web-search verification recipe stays inside the credential and
 * endpoint boundary of its package-owned OpenShell provider profile.
 */
export function assertHarnessWebSearchProviderProfile(
  binding: HarnessWebSearchProviderBinding,
  profileType: string,
  profileDocument: unknown,
): void {
  const profile = objectRecord(profileDocument);
  if (profile?.id !== binding.profile_type || profileType !== binding.profile_type) {
    throw new Error("Web-search declaration does not match its provider profile identity");
  }
  const credential = Array.isArray(profile.credentials)
    ? profile.credentials
        .map(objectRecord)
        .find(
          (entry) =>
            entry !== null &&
            Array.isArray(entry.env_vars) &&
            entry.env_vars.includes(binding.credential_env),
        )
    : null;
  if (!credential) {
    throw new Error("Web-search credential environment is not declared by its provider profile");
  }

  const requestUrl = new URL(binding.egress_verification.url);
  const endpoint = Array.isArray(profile.endpoints)
    ? profile.endpoints
        .map(objectRecord)
        .find(
          (entry) =>
            entry?.host === requestUrl.hostname &&
            (entry.port === 443 || entry.port === undefined) &&
            requestUrl.port === "",
        )
    : null;
  if (!endpoint) {
    throw new Error("Web-search verification host is not declared by its provider profile");
  }
  const binaries = Array.isArray(profile.binaries) ? profile.binaries : [];
  if (!binaries.includes("/usr/bin/curl")) {
    throw new Error("Web-search provider profile does not authorize the core verification command");
  }

  const placement = binding.egress_verification.credential;
  if (placement.kind === "header") {
    const expectedAuthStyle = placement.prefix === "bearer" ? "bearer" : "header";
    if (
      typeof credential.header_name !== "string" ||
      credential.header_name.toLowerCase() !== placement.name.toLowerCase() ||
      credential.auth_style !== expectedAuthStyle
    ) {
      throw new Error("Web-search header verification does not match its provider profile");
    }
  } else if (endpoint.request_body_credential_rewrite !== true) {
    throw new Error("Web-search body verification is not authorized by its provider profile");
  }
}
