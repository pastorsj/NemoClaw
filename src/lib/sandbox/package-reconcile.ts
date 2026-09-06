// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import path from "node:path";

import type { HarnessInferenceConfigPostCommit } from "../agent-runtime/config-module";
import { readManagedImageDeclaration } from "../agent-runtime/managed-image";
import { harnessPackageIdentitiesEqual } from "../agent-runtime/package/identity-validation";
import {
  resolvePinnedHarnessPackage,
  type HarnessPackageStoreOptions,
} from "../agent-runtime/package/store";
import type { HarnessPackageIdentity } from "../agent-runtime/package/types";
import type { SandboxEntry } from "../state/registry";
import { readRegisteredSandboxAuthority } from "../onboard/package/package-authority";
import { executePrivilegedSandboxCommand, resolvePrivilegedSandboxTarget } from "./privileged-exec";

type SandboxReconcileCommand = Extract<
  HarnessInferenceConfigPostCommit["sandboxReconcile"],
  { readonly kind: "command" }
>;

const RECONCILE_OUTPUT_MAX_BYTES = 4 * 1024;
const REQUEST_ID_RE = /^[a-f0-9]{64}$/u;

/** Resolve the numeric execution identity from the exact installed package receipt. */
export function resolvePackageRuntimeIdentity(
  identity: HarnessPackageIdentity,
  options: HarnessPackageStoreOptions = {},
): { readonly uid: number; readonly gid: number } {
  const installed = resolvePinnedHarnessPackage(identity, options);
  const managedImage = readManagedImageDeclaration(installed.packageManifest.manifest);
  if (!managedImage) throw new PackageSandboxReconcileError();
  return Object.freeze({
    uid: managedImage.runtime_identity.uid,
    gid: managedImage.runtime_identity.gid,
  });
}

export interface PackageSandboxReconcileDependencies {
  readonly getSandbox: (sandboxName: string) => SandboxEntry | null;
  readonly randomRequestId: () => string;
  readonly resolveRuntimeIdentity: (identity: HarnessPackageIdentity) => {
    readonly uid: number;
    readonly gid: number;
  };
  readonly resolveTarget: typeof resolvePrivilegedSandboxTarget;
  readonly executeCommand: typeof executePrivilegedSandboxCommand;
}

const defaultDependencies: PackageSandboxReconcileDependencies = {
  getSandbox: readRegisteredSandboxAuthority,
  randomRequestId: () => randomBytes(32).toString("hex"),
  resolveRuntimeIdentity: (identity) => resolvePackageRuntimeIdentity(identity),
  resolveTarget: resolvePrivilegedSandboxTarget,
  executeCommand: executePrivilegedSandboxCommand,
};

export class PackageSandboxReconcileError extends Error {
  override readonly name = "PackageSandboxReconcileError";

  constructor() {
    super("Installed harness package sandbox reconciliation did not converge.");
  }
}

function requireCurrentPackageIdentity(
  sandboxName: string,
  expectedIdentity: HarnessPackageIdentity,
  dependencies: PackageSandboxReconcileDependencies,
): void {
  const currentIdentity = dependencies.getSandbox(sandboxName)?.harnessPackage ?? null;
  if (!currentIdentity || !harnessPackageIdentitiesEqual(expectedIdentity, currentIdentity)) {
    throw new PackageSandboxReconcileError();
  }
}

function requireSafeCommand(command: readonly string[]): void {
  const executable = command[0];
  if (
    command.length < 1 ||
    command.length > 32 ||
    typeof executable !== "string" ||
    !path.posix.isAbsolute(executable) ||
    path.posix.normalize(executable) !== executable ||
    command.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.length < 1 ||
        argument.length > 4096 ||
        /[\u0000\r\n]/u.test(argument),
    )
  ) {
    throw new PackageSandboxReconcileError();
  }
}

function acceptsReconcileReceipt(stdout: Buffer, requestId: string): boolean {
  const source = stdout.toString("utf8");
  const lines = source.split("\n");
  if (lines.length !== 2 || !lines[0] || lines[1] !== "" || lines[0].includes("\r")) return false;
  let value: unknown;
  try {
    value = JSON.parse(lines[0]) as unknown;
  } catch {
    return false;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return (
    keys.length === 2 &&
    keys[0] === "requestId" &&
    keys[1] === "status" &&
    record.status === "converged" &&
    record.requestId === requestId
  );
}

/** Execute one package-declared post-config convergence command against a pinned sandbox. */
export function reconcilePackageSandbox(
  sandboxName: string,
  expectedIdentity: HarnessPackageIdentity,
  declaration: SandboxReconcileCommand,
  dependencies: PackageSandboxReconcileDependencies = defaultDependencies,
): void {
  requireSafeCommand(declaration.command);
  requireCurrentPackageIdentity(sandboxName, expectedIdentity, dependencies);
  const requestId = dependencies.randomRequestId();
  if (!REQUEST_ID_RE.test(requestId)) throw new PackageSandboxReconcileError();
  let executionUser: { readonly uid: number; readonly gid: number };
  try {
    executionUser = dependencies.resolveRuntimeIdentity(expectedIdentity);
  } catch {
    throw new PackageSandboxReconcileError();
  }
  if (
    !Number.isInteger(executionUser.uid) ||
    executionUser.uid < 1 ||
    executionUser.uid > 2_147_483_647 ||
    !Number.isInteger(executionUser.gid) ||
    executionUser.gid < 1 ||
    executionUser.gid > 2_147_483_647
  ) {
    throw new PackageSandboxReconcileError();
  }
  const target = dependencies.resolveTarget(sandboxName);
  let result: ReturnType<typeof executePrivilegedSandboxCommand>;
  try {
    result = dependencies.executeCommand(sandboxName, declaration.command, {
      executionUser,
      expectedProviderId: target.providerId,
      expectedResourceHandle: target.resourceHandle,
      input: `${JSON.stringify({ requestId })}\n`,
      maxOutputBytes: RECONCILE_OUTPUT_MAX_BYTES,
      sanitizeEnvironment: true,
      timeout: declaration.timeoutSeconds * 1000,
    });
  } catch {
    throw new PackageSandboxReconcileError();
  }
  requireCurrentPackageIdentity(sandboxName, expectedIdentity, dependencies);
  if (
    result.status !== 0 ||
    result.signal !== null ||
    result.error ||
    result.stderr.length !== 0 ||
    !acceptsReconcileReceipt(result.stdout, requestId)
  ) {
    throw new PackageSandboxReconcileError();
  }
}
