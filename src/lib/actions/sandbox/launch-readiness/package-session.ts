// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";

import type { HarnessSessionQualificationDeclaration } from "@nvidia/nemoclaw-harness-contract";

import {
  executePrivilegedSandboxCommand,
  resolvePrivilegedSandboxTarget,
} from "../../../sandbox/privileged-exec";
import type { LaunchReadinessPackageSessionQualification } from "../../../state/launch-readiness-lease";
import { getSandbox } from "../../../state/registry/read";
import type { SandboxEntry } from "../../../state/registry/types";

const QUALIFIED_MARKER = "__NEMOCLAW_SESSION_QUALIFIED__=";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_OUTPUT_BYTES = 16 * 1024;

export class PackageSessionQualificationError extends Error {
  constructor() {
    super("Package session qualification is unavailable.");
    this.name = "PackageSessionQualificationError";
  }
}

interface PackageSessionQualificationDeps {
  readonly createNonce: () => string;
  readonly executeCommand: typeof executePrivilegedSandboxCommand;
  readonly getSandbox: (sandboxName: string) => SandboxEntry | null | undefined;
  readonly resolveTarget: typeof resolvePrivilegedSandboxTarget;
}

const DEFAULT_DEPS: PackageSessionQualificationDeps = {
  createNonce: () => randomBytes(32).toString("hex"),
  executeCommand: executePrivilegedSandboxCommand,
  getSandbox,
  resolveTarget: resolvePrivilegedSandboxTarget,
};

function hasCurrentPackageAuthority(
  entry: SandboxEntry | null | undefined,
  packageId: string,
): boolean {
  return (
    entry?.harnessPackage?.id === packageId && (entry.agent == null || entry.agent === packageId)
  );
}

function parseQualification(
  stdout: Buffer,
  nonce: string,
  packageId: string,
): LaunchReadinessPackageSessionQualification {
  const lines = stdout.toString("utf8").trimEnd().split(/\r?\n/u);
  const prefix = `${QUALIFIED_MARKER}${nonce}:`;
  const records = lines.filter((line) => line.startsWith(QUALIFIED_MARKER));
  const stateSha256 = lines.at(-1)?.startsWith(prefix) ? lines.at(-1)?.slice(prefix.length) : null;
  if (records.length !== 1 || !stateSha256 || !SHA256_PATTERN.test(stateSha256)) {
    throw new PackageSessionQualificationError();
  }
  return Object.freeze({ schemaVersion: 1, kind: "package-session", packageId, stateSha256 });
}

/** Observe one receipt-pinned package session through its fixed, bounded command. */
export function observePackageSessionQualification(
  sandboxName: string,
  packageId: string,
  declaration: HarnessSessionQualificationDeclaration,
  executionUser: { readonly uid: number; readonly gid: number },
  deps: PackageSessionQualificationDeps = DEFAULT_DEPS,
): LaunchReadinessPackageSessionQualification {
  const before = deps.getSandbox(sandboxName);
  if (!hasCurrentPackageAuthority(before, packageId)) {
    throw new PackageSessionQualificationError();
  }
  const target = deps.resolveTarget(sandboxName);
  const nonce = deps.createNonce();
  if (!SHA256_PATTERN.test(nonce)) throw new PackageSessionQualificationError();
  const result = deps.executeCommand(sandboxName, [...declaration.command, nonce], {
    executionUser,
    expectedResourceHandle: target.resourceHandle,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    sanitizeEnvironment: true,
    timeout: declaration.timeout_seconds * 1_000,
  });
  if (result.status !== 0 || result.signal !== null || result.error) {
    throw new PackageSessionQualificationError();
  }
  const qualification = parseQualification(result.stdout, nonce, packageId);
  const after = deps.getSandbox(sandboxName);
  const currentTarget = deps.resolveTarget(sandboxName);
  if (
    !hasCurrentPackageAuthority(after, packageId) ||
    currentTarget.resourceHandle !== target.resourceHandle
  ) {
    throw new PackageSessionQualificationError();
  }
  return qualification;
}
