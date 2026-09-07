// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessToolGatewayCapability,
  HarnessToolGatewayDeclaration,
} from "@nvidia/nemoclaw-harness-contract";

import { readObject, readString } from "./manifest-readers";
import { resolvePinnedHarnessPackage, type HarnessPackageStoreOptions } from "./package/pinned";
import type { HarnessPackageIdentity } from "./package/types";

export class HarnessToolGatewayError extends Error {
  override readonly name = "HarnessToolGatewayError";
}

function readDeclaredCapability(
  identity: HarnessPackageIdentity,
  options: HarnessPackageStoreOptions = {},
): HarnessToolGatewayCapability | null {
  const installed = resolvePinnedHarnessPackage(identity, options);
  if (readString(installed.packageManifest.manifest, "name") !== identity.id) {
    throw new HarnessToolGatewayError(
      "Installed harness package manifest does not match its receipt",
    );
  }
  const value = readObject(installed.packageManifest.manifest, "tool_gateways");
  return value ? (value as unknown as HarnessToolGatewayCapability) : null;
}

/** Read managed-tool data from the exact package object selected by a receipt. */
export function resolveHarnessToolGatewayCapability(
  identity: HarnessPackageIdentity,
  options: HarnessPackageStoreOptions = {},
): Extract<HarnessToolGatewayCapability, { readonly support: "managed" }> | null {
  const capability = readDeclaredCapability(identity, options);
  return capability?.support === "managed" ? capability : null;
}

function gatewayNameMap(
  capability: Extract<HarnessToolGatewayCapability, { readonly support: "managed" }>,
): ReadonlyMap<string, HarnessToolGatewayDeclaration> {
  const entries = capability.gateways.flatMap((gateway) => [
    [gateway.id, gateway] as const,
    ...gateway.aliases.map((alias) => [alias, gateway] as const),
  ]);
  return new Map(entries);
}

/** Parse one receipt-declared environment request without knowing the harness vocabulary. */
export function parseHarnessToolGatewayRequest(
  capability: Extract<HarnessToolGatewayCapability, { readonly support: "managed" }>,
  env: NodeJS.ProcessEnv,
): string[] | null {
  const raw = capability.request_environment
    .map((name) => env[name]?.trim() ?? "")
    .find((value) => value.length > 0);
  if (!raw) return null;
  const byName = gatewayNameMap(capability);
  const selected: string[] = [];
  for (const input of raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)) {
    const gateway = byName.get(input);
    if (!gateway) {
      throw new HarnessToolGatewayError(
        `Unknown managed tool gateway '${input}'. Valid values: ${capability.gateways.map(({ id }) => id).join(", ")}`,
      );
    }
    if (!selected.includes(gateway.id)) selected.push(gateway.id);
  }
  return selected;
}

/** Keep only declared gateway IDs, in declaration order, when reading durable state. */
export function normalizeHarnessToolGatewaySelections(
  capability: Extract<HarnessToolGatewayCapability, { readonly support: "managed" }>,
  value: unknown,
): string[] {
  if (!Array.isArray(value)) return [];
  const requested = new Set(value.filter((entry): entry is string => typeof entry === "string"));
  return capability.gateways.filter(({ id }) => requested.has(id)).map(({ id }) => id);
}

/** Return the package labels for a generic configuration summary. */
export function formatHarnessToolGatewaySelections(
  capability: Extract<HarnessToolGatewayCapability, { readonly support: "managed" }> | null,
  selections: readonly string[] | null | undefined,
): string {
  if (!capability || !selections || selections.length === 0) return "none";
  const labels = new Map(capability.gateways.map((gateway) => [gateway.id, gateway.label]));
  return selections.map((id) => labels.get(id) ?? id).join(", ");
}

/** Resolve the package-owned policy presets required by selected gateways. */
export function resolveHarnessToolGatewayPolicyPresets(
  capability: Extract<HarnessToolGatewayCapability, { readonly support: "managed" }> | null,
  selections: readonly string[] | null | undefined,
): string[] {
  if (!capability || !selections) return [];
  const selected = new Set(selections);
  return [
    ...new Set(
      capability.gateways
        .filter(({ id }) => selected.has(id))
        .flatMap(({ policy_presets: presets }) => presets),
    ),
  ];
}

/** Return gateways usable by one package-declared authentication method. */
export function compatibleHarnessToolGateways(
  capability: Extract<HarnessToolGatewayCapability, { readonly support: "managed" }>,
  authenticationMethod: string,
): readonly HarnessToolGatewayDeclaration[] {
  return capability.gateways.filter(({ authentication_methods: methods }) =>
    methods.includes(authenticationMethod),
  );
}
