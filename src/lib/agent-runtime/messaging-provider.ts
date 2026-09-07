// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import type { HarnessMessagingCredentialProvider } from "@nvidia/nemoclaw-harness-contract";
import YAML from "yaml";

type ParsedMessagingCredentialProvider = Readonly<{
  profileId: string;
  credentialEnv: string;
  refresh?: Readonly<{
    strategy: "google_service_account_jwt";
    scopes: readonly string[];
    secretMaterialKeys: readonly string[];
  }>;
}>;

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null;
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
}

const GOOGLE_SERVICE_ACCOUNT_MATERIAL_CONTRACT = Object.freeze([
  Object.freeze({ name: "client_email", required: true, secret: false }),
  Object.freeze({ name: "private_key", required: true, secret: true }),
  Object.freeze({ name: "scope", required: false, secret: false }),
]);

function hasCanonicalGoogleServiceAccountMaterial(material: readonly unknown[]): boolean {
  const flags = material
    .flatMap((entry) => {
      const item = record(entry);
      return typeof item?.name === "string" &&
        typeof item.required === "boolean" &&
        typeof item.secret === "boolean"
        ? [{ name: item.name, required: item.required, secret: item.secret }]
        : [];
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  return (
    flags.length === material.length &&
    isDeepStrictEqual(flags, GOOGLE_SERVICE_ACCOUNT_MATERIAL_CONTRACT)
  );
}

/** Parse only the finite OpenShell fields that NemoClaw's messaging executor consumes. */
export function parseMessagingCredentialProviderProfile(
  source: string,
): ParsedMessagingCredentialProvider | null {
  let value: unknown;
  try {
    const document = YAML.parseDocument(source, { uniqueKeys: true });
    if (document.errors.length > 0) return null;
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    return null;
  }
  const profile = record(value);
  const credentials = Array.isArray(profile?.credentials) ? profile.credentials : null;
  const credential = credentials?.length === 1 ? record(credentials[0]) : null;
  const envVars = stringList(credential?.env_vars);
  const profileId = profile?.id;
  if (
    typeof profileId !== "string" ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(profileId) ||
    !envVars ||
    envVars.length !== 1 ||
    !/^[A-Z_][A-Z0-9_]*$/u.test(envVars[0] ?? "")
  ) {
    return null;
  }

  const refresh = record(credential?.refresh);
  if (!refresh) {
    if (
      !Array.isArray(profile?.endpoints) ||
      profile.endpoints.length !== 0 ||
      !Array.isArray(profile.binaries) ||
      profile.binaries.length !== 0 ||
      profile.inference_capable !== false
    ) {
      return null;
    }
    return Object.freeze({ profileId, credentialEnv: envVars[0]! });
  }

  if (refresh.strategy !== "google_service_account_jwt") return null;
  const scopes = stringList(refresh.scopes);
  const material = Array.isArray(refresh.material) ? refresh.material : null;
  if (
    !scopes ||
    scopes.length === 0 ||
    !material ||
    !hasCanonicalGoogleServiceAccountMaterial(material)
  )
    return null;
  const secretMaterialKeys = material.flatMap((entry) => {
    const item = record(entry);
    return item?.secret === true && typeof item.name === "string" ? [item.name] : [];
  });
  if (secretMaterialKeys.length === 0) return null;
  return Object.freeze({
    profileId,
    credentialEnv: envVars[0]!,
    refresh: Object.freeze({
      strategy: refresh.strategy,
      scopes: Object.freeze([...scopes]),
      secretMaterialKeys: Object.freeze(secretMaterialKeys),
    }),
  });
}

/** Prove that executable package data and its checked-in OpenShell profile agree exactly. */
export function assertMessagingCredentialProviderProfileMatches(
  declaration: HarnessMessagingCredentialProvider,
  source: string,
): void {
  const parsed = parseMessagingCredentialProviderProfile(source);
  const declared = {
    profileId: declaration.profileId,
    credentialEnv: declaration.credentialEnv,
    ...(declaration.refresh ? { refresh: declaration.refresh } : {}),
  };
  if (!parsed || !isDeepStrictEqual(parsed, declared)) {
    throw new Error("Messaging credential provider declaration does not match its profile asset");
  }
}
