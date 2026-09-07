// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  harnessPackageIdentitiesEqual,
  parseHarnessPackageIdentity,
} from "../../agent-runtime/package/identity-read";
import type { HarnessPackageIdentity } from "../../agent-runtime/package/types";

const PROVIDER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const CREDENTIAL_ENV = /^[A-Z_][A-Z0-9_]{0,127}$/u;

export interface SandboxProviderBrokerOwnership {
  readonly schemaVersion: 1;
  readonly harnessPackage: HarnessPackageIdentity;
  readonly providerName: string;
  readonly providerType: "generic";
  readonly credentialEnv: string;
}

/** Parse the complete non-secret ownership needed to tear down one package broker. */
export function parseSandboxProviderBrokerOwnership(
  value: unknown,
  expectedPackage?: HarnessPackageIdentity,
): SandboxProviderBrokerOwnership {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Sandbox provider-broker ownership is invalid.");
  }
  const record = value as Record<string, unknown>;
  const harnessPackage = parseHarnessPackageIdentity(record.harnessPackage);
  if (expectedPackage && !harnessPackageIdentitiesEqual(harnessPackage, expectedPackage)) {
    throw new Error("Sandbox provider-broker ownership does not match its package receipt.");
  }
  if (
    record.schemaVersion !== 1 ||
    record.providerType !== "generic" ||
    typeof record.providerName !== "string" ||
    !PROVIDER_NAME.test(record.providerName) ||
    typeof record.credentialEnv !== "string" ||
    !CREDENTIAL_ENV.test(record.credentialEnv)
  ) {
    throw new Error("Sandbox provider-broker ownership fields are invalid.");
  }
  return Object.freeze({
    schemaVersion: 1,
    harnessPackage: Object.freeze({ ...harnessPackage }),
    providerName: record.providerName,
    providerType: "generic",
    credentialEnv: record.credentialEnv,
  });
}
