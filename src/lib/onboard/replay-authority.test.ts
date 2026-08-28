// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { HarnessPackageIdentity, HarnessPackageMigration } from "../harness/package-identity";
import { deriveCheckpointFromSession } from "../state/onboard-checkpoint-migrate";
import type {
  CheckpointSandboxRecreateTransactionV2,
  OnboardCheckpoint,
} from "../state/onboard-checkpoint-types";
import { createSession } from "../state/onboard-session";
import type { SandboxEntry } from "../state/registry/types";
import { assertCheckpointPackageAuthorityChain } from "./checkpoint-replay";

const PACKAGE: HarnessPackageIdentity = {
  kind: "agent-runtime",
  id: "hermes",
  packageVersion: "2.0.0",
  contractVersion: 1,
  contentDigest: "a".repeat(64),
};
const MIGRATION: HarnessPackageMigration = {
  schemaVersion: 1,
  source: "legacy-current-bundle",
  legacyAgent: "hermes",
  migratedAt: "2026-08-28T05:00:00.000Z",
};

function packageCheckpoint(): OnboardCheckpoint {
  const session = createSession({
    agent: "hermes",
    harnessPackage: PACKAGE,
    harnessPackageMigration: MIGRATION,
  });
  return {
    ...deriveCheckpointFromSession(session),
    sandboxRecreate: {
      version: 2,
      harnessPackage: PACKAGE,
      id: "11111111-1111-4111-8111-111111111111",
      revision: 0,
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      sourceRegistryFingerprint: "b".repeat(64),
      sourceLiveIdentityFingerprint: null,
      sourceWorkload: null,
      targetIntentFingerprint: "c".repeat(64),
      targetGeneration: "22222222-2222-4222-8222-222222222222",
      targetLiveIdentityFingerprint: null,
      phase: "deleted",
      startedAt: "2026-08-28T05:00:00.000Z",
      updatedAt: "2026-08-28T05:00:00.000Z",
    },
  };
}

function owner(checkpoint: OnboardCheckpoint = packageCheckpoint()) {
  return {
    checkpoint,
    machine: { state: "sandbox" as const },
    harnessPackage: PACKAGE,
    harnessPackageMigration: MIGRATION,
  };
}

function registryEntry(overrides: Partial<SandboxEntry> = {}): SandboxEntry {
  return {
    name: "alpha",
    agent: "hermes",
    harnessPackage: PACKAGE,
    harnessPackageMigration: MIGRATION,
    ...overrides,
  };
}

describe("checkpoint replay package authority", () => {
  it("accepts one exact Session, checkpoint, transaction, and registry chain", () => {
    expect(() => assertCheckpointPackageAuthorityChain(owner(), registryEntry())).not.toThrow();
  });

  it("rejects checkpoint and recreate drift before replay", () => {
    expect(() =>
      assertCheckpointPackageAuthorityChain(
        owner({ ...packageCheckpoint(), harnessPackage: null }),
        registryEntry(),
      ),
    ).toThrow("Checkpoint package authority");

    const checkpoint = packageCheckpoint();
    expect(() =>
      assertCheckpointPackageAuthorityChain(
        owner({
          ...checkpoint,
          sandboxRecreate: {
            ...checkpoint.sandboxRecreate!,
            version: 2,
            harnessPackage: { ...PACKAGE, contentDigest: "d".repeat(64) },
          },
        }),
        registryEntry(),
      ),
    ).toThrow("Recreate transaction package authority");
  });

  it("rejects legacy recreate state until the explicit pre-effect migration runs", () => {
    const checkpoint = packageCheckpoint();
    expect(checkpoint.sandboxRecreate?.version).toBe(2);
    const { harnessPackage: _harnessPackage, ...legacy } =
      checkpoint.sandboxRecreate as CheckpointSandboxRecreateTransactionV2;
    expect(() =>
      assertCheckpointPackageAuthorityChain(
        owner({ ...checkpoint, sandboxRecreate: { ...legacy, version: 1 } }),
        registryEntry(),
      ),
    ).toThrow("requires package authority migration");
  });

  it("rejects owning registry identity or migration-audit drift", () => {
    expect(() =>
      assertCheckpointPackageAuthorityChain(
        owner(),
        registryEntry({ harnessPackage: { ...PACKAGE, contentDigest: "e".repeat(64) } }),
      ),
    ).toThrow("Registry package authority");
    expect(() =>
      assertCheckpointPackageAuthorityChain(
        owner(),
        registryEntry({
          harnessPackageMigration: { ...MIGRATION, migratedAt: "2026-08-28T06:00:00.000Z" },
        }),
      ),
    ).toThrow("Registry package authority");
  });

  it("keeps qualified candidate absence explicit", () => {
    const session = createSession({ agent: "nemocua" });
    const checkpoint = deriveCheckpointFromSession(session);
    expect(() =>
      assertCheckpointPackageAuthorityChain(
        {
          checkpoint,
          machine: session.machine,
          harnessPackage: null,
          harnessPackageMigration: null,
        },
        { name: "candidate", agent: "nemocua" },
      ),
    ).not.toThrow();
  });
});
