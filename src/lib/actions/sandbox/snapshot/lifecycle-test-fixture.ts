// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import { expect } from "vitest";

import type {
  HarnessPackageIdentity,
  HarnessPackageMigration,
} from "../../../agent-runtime/package/identity";
import { fingerprintSandboxRecreateValue } from "../../../onboard/sandbox-recreate-transaction";
import * as f from "../snapshot-restore-test-fixture";

/** Keep conditional fixture setup outside individual test callbacks. */
export function runWhen(condition: boolean, action: () => void): void {
  if (condition) action();
}

export function isSandboxGet(args: readonly string[], sandboxName?: string): boolean {
  return (
    args[0] === "sandbox" &&
    args[1] === "get" &&
    (sandboxName === undefined || args.at(-1) === sandboxName)
  );
}

export function liveSandboxGetResult(sandboxName: string, identity: string) {
  return {
    status: 0,
    output: `Name: ${sandboxName}\nId: ${identity}\nPhase: Ready\n`,
  };
}

export function harnessPackage(
  id: "openclaw" | "hermes" | "langchain-deepagents-code",
  digestCharacter = "d",
): HarnessPackageIdentity {
  return {
    kind: "agent-runtime",
    id,
    packageVersion: "1.2.3",
    contentDigest: digestCharacter.repeat(64),
  };
}

export const OPENCLAW_PACKAGE = harnessPackage("openclaw", "a");
export const HERMES_PACKAGE = harnessPackage("hermes", "b");

export function legacyPackageMigration(
  harnessPackage: HarnessPackageIdentity,
): HarnessPackageMigration {
  return {
    schemaVersion: 1,
    source: "legacy-current-bundle",
    legacyAgent: harnessPackage.id === "openclaw" ? null : harnessPackage.id,
    migratedAt: "2026-08-20T00:00:00.000Z",
  };
}

export function packageManagedSandbox(
  name: string,
  harnessPackage: HarnessPackageIdentity = HERMES_PACKAGE,
): f.SandboxRecord {
  return {
    name,
    agent: harnessPackage.id,
    harnessPackage,
    harnessPackageMigration: legacyPackageMigration(harnessPackage),
    imageTag: `nemoclaw-${name}:test`,
    openshellDriver: "docker",
    provider: "nvidia-nim",
    model: "nvidia/model-a",
  };
}

export function pendingPackageManagedSandbox(
  name: string,
  harnessPackage: HarnessPackageIdentity = HERMES_PACKAGE,
): f.SandboxRecord {
  const source = packageManagedSandbox("alpha", harnessPackage);
  const { harnessPackageMigration: _migration, ...pending } = packageManagedSandbox(
    name,
    harnessPackage,
  );
  return {
    ...pending,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    snapshotSourceRegistryFingerprint: fingerprintSandboxRecreateValue(source),
  };
}

export function packageManagedSnapshot(harnessPackage: HarnessPackageIdentity = HERMES_PACKAGE) {
  return {
    version: 2,
    backupComplete: true,
    backupContentSha256: "d".repeat(64),
    snapshotVersion: 4,
    timestamp: "2026-08-20T00:00:00.000Z",
    backupPath: "/tmp/backup-alpha",
    sandboxName: "alpha",
    agentType: harnessPackage.id,
    agentVersion: "1.2.3",
    expectedVersion: "1.2.3",
    harnessPackage,
    stateDirs: ["workspace"],
    dir: "/sandbox",
  };
}

export function candidateSandbox(name: string): f.SandboxRecord {
  return {
    name,
    agent: "pi",
    imageTag: `nemoclaw-${name}:candidate`,
    openshellDriver: "docker",
    provider: "nvidia-nim",
    model: "nvidia/model-a",
  };
}

export function candidateSnapshot() {
  return {
    version: 2,
    backupComplete: true,
    backupContentSha256: "d".repeat(64),
    snapshotVersion: 4,
    timestamp: "2026-08-20T00:00:00.000Z",
    backupPath: "/tmp/backup-alpha",
    sandboxName: "alpha",
    agentType: "pi",
    agentVersion: "0.1.0",
    expectedVersion: "0.1.0",
    harnessPackage: null,
    stateDirs: ["workspace"],
    dir: "/sandbox",
  };
}

export function packageSnapshotWithCompletionEvidence(
  version: 1 | 2,
  backupComplete: boolean | undefined,
  includeContentEvidence = true,
) {
  const snapshot = packageManagedSnapshot(OPENCLAW_PACKAGE);
  const { backupComplete: _recordedCompletion, ...withoutCompletion } = snapshot;
  const withCompletion =
    backupComplete === undefined
      ? { ...withoutCompletion, version }
      : { ...snapshot, version, backupComplete };
  if (includeContentEvidence) return withCompletion;
  const { backupContentSha256: _recordedContent, ...withoutContentEvidence } = withCompletion;
  return withoutContentEvidence;
}

export function configureCloneGateway(onCreate?: () => void): void {
  let cloneCreated = false;
  f.parseLiveSandboxNamesMock.mockImplementation((output: string) => {
    return new Set(["alpha", "beta"].filter((name) => output.includes(`${name} Ready`)));
  });
  f.captureOpenshellMock.mockImplementation((args) =>
    f.openshellResponses(args, {
      "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
      "sandbox list": {
        status: 0,
        output: cloneCreated ? "alpha Ready\nbeta Ready\n" : "alpha Ready\n",
      },
    }),
  );
  f.streamSandboxCreateMock.mockImplementation(async () => {
    cloneCreated = true;
    onCreate?.();
    return { status: 0, output: "", sawProgress: false, forcedReady: false };
  });
}

export function expectSnapshotStateRestore(sandboxName: string): void {
  expect(f.restoreSandboxStateMock).toHaveBeenCalledWith(
    sandboxName,
    "/tmp/backup-alpha",
    expect.objectContaining({
      authority: expect.objectContaining({ backupPath: "/tmp/backup-alpha" }),
      validateBeforeMutation: expect.any(Function),
    }),
  );
}

export function storePendingClone(
  entries: Map<string, f.SandboxRecord>,
  entry: f.SandboxRecord,
): f.SandboxRecord {
  const pending = { ...entry, pendingRouteReservation: true as const };
  entries.set(entry.name, pending);
  return pending;
}

export function configureCloneRegistry(
  source: f.SandboxRecord,
  entries = new Map<string, f.SandboxRecord>([[source.name, source]]),
): Map<string, f.SandboxRecord> {
  f.getSandboxMock.mockImplementation((name) => entries.get(name ?? "") ?? null);
  f.registerSandboxMock.mockImplementation(
    (entry, _routeReservation, options: { expectedCurrent?: f.SandboxRecord | null } = {}) => {
      const current = entries.get(entry.name) ?? null;
      if (
        Object.prototype.hasOwnProperty.call(options, "expectedCurrent") &&
        !isDeepStrictEqual(current, options.expectedCurrent ?? null)
      ) {
        throw new Error(`registry row '${entry.name}' changed before publication`);
      }
      return storePendingClone(entries, entry);
    },
  );
  f.finalizePendingSandboxRegistrationMock.mockImplementation((expected) => {
    const current = entries.get(expected.name);
    if (!current || !isDeepStrictEqual(current, expected)) return false;
    const { pendingRouteReservation: _pending, ...finalized } = current;
    entries.set(expected.name, finalized);
    return true;
  });
  f.removeSandboxRouteReservationIfCurrentMock.mockImplementation((expected) => {
    const current = entries.get(expected.name);
    if (!current || !isDeepStrictEqual(current, expected)) return false;
    entries.delete(expected.name);
    return true;
  });
  f.removeSandboxIfCurrentMock.mockImplementation((expected) => {
    const current = entries.get(expected.name);
    if (!current || !isDeepStrictEqual(current, expected)) return false;
    entries.delete(expected.name);
    return true;
  });
  return entries;
}
