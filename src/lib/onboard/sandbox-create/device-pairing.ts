// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";

import type { HarnessDevicePairingSettlementDeclaration } from "@nvidia/nemoclaw-harness-contract";

import {
  executePrivilegedSandboxCommand,
  resolvePrivilegedSandboxTarget,
} from "../../sandbox/privileged-exec";
import { readRegisteredSandboxAuthority } from "../package/package-authority";
import { withSandboxMutationLock } from "../../state/mutation-lock";
import { withGatewayRouteMutationLock } from "../../inference/gateway-route-mutation-lock";
import type { RuntimeProviderPrivilegedSandboxCommandResult } from "../runtime-provider/contract";

const SETTLED_MARKER = "__NEMOCLAW_DEVICE_PAIRING_SETTLED__=";
const MAX_OUTPUT_BYTES = 16 * 1024;

type PairingSandboxAuthority = {
  readonly agent?: string | null;
  readonly gatewayName?: string | null;
  readonly harnessPackage?: { readonly id: string } | null;
};

export type PackageDevicePairingSettlementResult =
  | { readonly kind: "settled" }
  | {
      readonly kind: "incomplete";
      readonly reason:
        | "package-authority-invalid"
        | "pairing-lock-unavailable"
        | "pairing-command-failed"
        | "pairing-command-invalid-response";
    };

interface PackageDevicePairingSettlementDeps {
  readonly getSandbox: (sandboxName: string) => PairingSandboxAuthority | null | undefined;
  readonly createNonce: () => string;
  readonly resolveTarget: typeof resolvePrivilegedSandboxTarget;
  readonly executeCommand: typeof executePrivilegedSandboxCommand;
  readonly withSandboxLock: <T>(sandboxName: string, operation: () => Promise<T> | T) => Promise<T>;
  readonly withGatewayLock: <T>(gatewayName: string, operation: () => Promise<T> | T) => Promise<T>;
}

const DEFAULT_SETTLEMENT_DEPS: PackageDevicePairingSettlementDeps = {
  getSandbox: readRegisteredSandboxAuthority,
  createNonce: () => randomBytes(32).toString("hex"),
  resolveTarget: resolvePrivilegedSandboxTarget,
  executeCommand: executePrivilegedSandboxCommand,
  withSandboxLock: (sandboxName, operation) => withSandboxMutationLock(sandboxName, operation),
  withGatewayLock: (gatewayName, operation) => withGatewayRouteMutationLock(gatewayName, operation),
};

function commandSettled(
  result: RuntimeProviderPrivilegedSandboxCommandResult,
  nonce: string,
): boolean {
  if (result.status !== 0 || result.signal !== null || result.error) return false;
  const lines = result.stdout.toString("utf8").trimEnd().split(/\r?\n/u);
  const expected = `${SETTLED_MARKER}${nonce}`;
  return lines.at(-1) === expected && lines.filter((line) => line === expected).length === 1;
}

/** Execute one receipt-authorized package pairing command under core-owned locks and limits. */
export async function settlePackageDevicePairing(
  sandboxName: string,
  packageId: string,
  declaration: HarnessDevicePairingSettlementDeclaration,
  executionUser: { readonly uid: number; readonly gid: number },
  deps: PackageDevicePairingSettlementDeps = DEFAULT_SETTLEMENT_DEPS,
): Promise<PackageDevicePairingSettlementResult> {
  let sandboxLockEntered = false;
  try {
    return await deps.withSandboxLock(sandboxName, async () => {
      sandboxLockEntered = true;
      const sandbox = deps.getSandbox(sandboxName);
      if (
        !sandbox ||
        sandbox.harnessPackage?.id !== packageId ||
        (sandbox.agent != null && sandbox.agent !== packageId) ||
        typeof sandbox.gatewayName !== "string" ||
        sandbox.gatewayName.trim() === ""
      ) {
        return { kind: "incomplete", reason: "package-authority-invalid" };
      }
      const target = deps.resolveTarget(sandboxName);
      let gatewayLockEntered = false;
      try {
        return await deps.withGatewayLock(sandbox.gatewayName, () => {
          gatewayLockEntered = true;
          const current = deps.getSandbox(sandboxName);
          if (
            !current ||
            current.harnessPackage?.id !== packageId ||
            current.gatewayName !== sandbox.gatewayName
          ) {
            return { kind: "incomplete", reason: "package-authority-invalid" } as const;
          }
          const nonce = deps.createNonce();
          if (!/^[0-9a-f]{64}$/u.test(nonce)) {
            return { kind: "incomplete", reason: "pairing-command-invalid-response" } as const;
          }
          const result = deps.executeCommand(sandboxName, [...declaration.command, nonce], {
            sanitizeEnvironment: true,
            executionUser,
            expectedResourceHandle: target.resourceHandle,
            timeout: declaration.timeout_seconds * 1000,
            maxOutputBytes: MAX_OUTPUT_BYTES,
          });
          if (result.status !== 0 || result.signal !== null || result.error) {
            return { kind: "incomplete", reason: "pairing-command-failed" } as const;
          }
          return commandSettled(result, nonce)
            ? ({ kind: "settled" } as const)
            : ({ kind: "incomplete", reason: "pairing-command-invalid-response" } as const);
        });
      } catch (error) {
        if (gatewayLockEntered) throw error;
        return { kind: "incomplete", reason: "pairing-lock-unavailable" };
      }
    });
  } catch (error) {
    if (sandboxLockEntered) throw error;
    return { kind: "incomplete", reason: "pairing-lock-unavailable" };
  }
}

/** Format a package-neutral onboarding error for one declared pairing operation. */
export function packageDevicePairingIncompleteMessage(
  displayName: string,
  sandboxName: string,
  reason: Extract<PackageDevicePairingSettlementResult, { kind: "incomplete" }>["reason"],
): string {
  const causes: Record<typeof reason, string> = {
    "package-authority-invalid": "its installed package authority changed or is invalid",
    "pairing-lock-unavailable": "NemoClaw could not acquire the pairing settlement locks",
    "pairing-command-failed": "its package pairing command did not complete successfully",
    "pairing-command-invalid-response":
      "its package pairing command did not return the required completion record",
  };
  return `${displayName} onboarding for '${sandboxName}' is incomplete because ${causes[reason]}. Resume or rerun onboarding.`;
}
