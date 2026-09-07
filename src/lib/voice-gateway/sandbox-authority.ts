// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HarnessSemanticTurnDeclaration } from "@nvidia/nemoclaw-harness-contract";

import {
  harnessPackageIdentitiesEqual,
  parseHarnessPackageIdentity,
} from "../agent-runtime/package/identity-read";
import type { HarnessPackageIdentity } from "../agent-runtime/package/types";
import {
  readPublishedSandboxAuthority,
  resolveLifecycleEligibleSandboxAgent,
} from "../actions/sandbox/authority/package";
import { resolveGatewayPortFromName, resolveSandboxGatewayName } from "../gateway-runtime-action";

const MAX_ENCODED_AUTHORITY_BYTES = 4 * 1024;
const SAFE_EVIDENCE_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;

/** Receipt and lifecycle identity that bind a gateway process to one sandbox generation. */
export interface SandboxSemanticTurnBinding {
  readonly sandboxName: string;
  readonly packageIdentity: HarnessPackageIdentity;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly lifecycleGeneration: string | null;
  readonly lifecycleLiveIdentityFingerprint: string | null;
}

/** Current semantic-turn capability plus its immutable sandbox binding. */
export interface SandboxSemanticTurnAuthority extends SandboxSemanticTurnBinding {
  readonly declaration: Extract<HarnessSemanticTurnDeclaration, { readonly support: "managed" }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}

function optionalEvidence(value: unknown, fingerprint = false): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("Semantic-turn authority is malformed");
  if (fingerprint ? !/^[0-9a-f]{64}$/u.test(value) : !SAFE_EVIDENCE_PATTERN.test(value)) {
    throw new Error("Semantic-turn authority is malformed");
  }
  return value;
}

/** Resolve semantic-turn authority from the exact package receipt recorded for a sandbox. */
export function resolveSandboxSemanticTurnAuthority(
  sandboxName: string,
): SandboxSemanticTurnAuthority {
  const entry = readPublishedSandboxAuthority(sandboxName);
  if (!entry) throw new Error("Published sandbox registration is unavailable");
  const resolved = resolveLifecycleEligibleSandboxAgent(entry);
  if (!resolved.harnessPackage) {
    throw new Error("Sandbox has no installed harness package authority");
  }
  const declaration = resolved.definition.runtime?.semantic_turn;
  if (!declaration || declaration.support !== "managed") {
    throw new Error(
      declaration?.reason ?? `${resolved.definition.displayName} does not support semantic turns`,
    );
  }
  const gatewayName = resolveSandboxGatewayName(entry);
  const gatewayPort = resolveGatewayPortFromName(gatewayName);
  if (gatewayPort === null) throw new Error("Published sandbox gateway authority is invalid");
  return Object.freeze({
    sandboxName,
    packageIdentity: resolved.harnessPackage,
    declaration,
    gatewayName,
    gatewayPort,
    lifecycleGeneration: entry.lifecycleGeneration ?? null,
    lifecycleLiveIdentityFingerprint: entry.lifecycleLiveIdentityFingerprint ?? null,
  });
}

/** Remove executable details before an authority crosses the launcher process boundary. */
export function semanticTurnBinding(
  authority: SandboxSemanticTurnAuthority,
): SandboxSemanticTurnBinding {
  return Object.freeze({
    sandboxName: authority.sandboxName,
    packageIdentity: authority.packageIdentity,
    gatewayName: authority.gatewayName,
    gatewayPort: authority.gatewayPort,
    lifecycleGeneration: authority.lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: authority.lifecycleLiveIdentityFingerprint,
  });
}

/** Compare every field that identifies one published sandbox generation. */
export function semanticTurnBindingsEqual(
  left: SandboxSemanticTurnBinding,
  right: SandboxSemanticTurnBinding,
): boolean {
  return (
    left.sandboxName === right.sandboxName &&
    harnessPackageIdentitiesEqual(left.packageIdentity, right.packageIdentity) &&
    left.gatewayName === right.gatewayName &&
    left.gatewayPort === right.gatewayPort &&
    left.lifecycleGeneration === right.lifecycleGeneration &&
    left.lifecycleLiveIdentityFingerprint === right.lifecycleLiveIdentityFingerprint
  );
}

/** Serialize one secret-free binding for the fixed launcher argument. */
export function encodeSemanticTurnBinding(binding: SandboxSemanticTurnBinding): string {
  return Buffer.from(JSON.stringify(binding), "utf8").toString("base64url");
}

/** Parse the closed launcher authority schema without trusting child environment input. */
export function parseSemanticTurnBinding(encoded: string): SandboxSemanticTurnBinding {
  if (
    encoded.length === 0 ||
    encoded.length > MAX_ENCODED_AUTHORITY_BYTES ||
    !/^[A-Za-z0-9_-]+$/u.test(encoded)
  ) {
    throw new Error("Semantic-turn authority is malformed");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error("Semantic-turn authority is malformed");
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "gatewayName",
      "gatewayPort",
      "lifecycleGeneration",
      "lifecycleLiveIdentityFingerprint",
      "packageIdentity",
      "sandboxName",
    ]) ||
    typeof value.sandboxName !== "string" ||
    !SAFE_EVIDENCE_PATTERN.test(value.sandboxName) ||
    typeof value.gatewayName !== "string" ||
    typeof value.gatewayPort !== "number" ||
    !Number.isInteger(value.gatewayPort) ||
    resolveGatewayPortFromName(value.gatewayName) !== value.gatewayPort
  ) {
    throw new Error("Semantic-turn authority is malformed");
  }
  const binding = {
    sandboxName: value.sandboxName,
    packageIdentity: parseHarnessPackageIdentity(value.packageIdentity),
    gatewayName: value.gatewayName,
    gatewayPort: value.gatewayPort,
    lifecycleGeneration: optionalEvidence(value.lifecycleGeneration),
    lifecycleLiveIdentityFingerprint: optionalEvidence(
      value.lifecycleLiveIdentityFingerprint,
      true,
    ),
  } satisfies SandboxSemanticTurnBinding;
  const canonical = encodeSemanticTurnBinding(binding);
  if (canonical !== encoded) throw new Error("Semantic-turn authority is malformed");
  return Object.freeze(binding);
}
