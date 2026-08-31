// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { HarnessPackageIdentity } from "../agent-runtime/package/identity";
import { inspectCheckpoint, serializeCheckpoint } from "./onboard-checkpoint";
import { decisionSelected } from "./onboard-checkpoint-decision";
import {
  bindCheckpointHarnessPackageAuthority,
  deriveCheckpointFromSession,
} from "./onboard-checkpoint-migrate";
import type {
  CheckpointSandboxRecreateTransactionV1,
  OnboardCheckpoint,
} from "./onboard-checkpoint-types";
import { createSession } from "./onboard-session";

const AT = "2026-08-28T05:00:00.000Z";
const PACKAGE: HarnessPackageIdentity = {
  kind: "agent-runtime",
  id: "openclaw",
  packageVersion: "1.2.3",
  contentDigest: "a".repeat(64),
};

function legacyTransaction(): CheckpointSandboxRecreateTransactionV1 {
  return {
    version: 1,
    id: "11111111-1111-4111-8111-111111111111",
    revision: 3,
    sandboxName: "alpha",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    sourceRegistryFingerprint: "b".repeat(64),
    sourceLiveIdentityFingerprint: "c".repeat(64),
    sourceWorkload: null,
    targetIntentFingerprint: "d".repeat(64),
    targetGeneration: "22222222-2222-4222-8222-222222222222",
    targetLiveIdentityFingerprint: null,
    phase: "creating",
    startedAt: AT,
    updatedAt: AT,
  };
}

function legacyCheckpoint(): OnboardCheckpoint {
  const session = createSession({
    sessionId: "session-1",
    agent: "openclaw",
    sandboxName: "alpha",
  });
  return {
    ...deriveCheckpointFromSession(session),
    harnessPackage: null,
    sandboxIdentity: decisionSelected({ name: "alpha", agent: "openclaw" }),
    gatewayAuthority: decisionSelected({
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      mode: "nemoclaw-managed",
      source: "standalone",
      endpoint: null,
      stateDir: null,
      supervisor: null,
      requiredCapabilities: [],
    }),
    sandboxRecreate: legacyTransaction(),
  };
}

describe("checkpoint package authority migration", () => {
  it("atomically binds checkpoint and legacy recreate state without changing journal progress", () => {
    const checkpoint = legacyCheckpoint();
    const migrated = bindCheckpointHarnessPackageAuthority(checkpoint, PACKAGE);

    expect(migrated).toMatchObject({
      harnessPackage: PACKAGE,
      sandboxRecreate: {
        ...legacyTransaction(),
        version: 2,
        harnessPackage: PACKAGE,
      },
    });
    expect(checkpoint.harnessPackage).toBeNull();
    expect(checkpoint.sandboxRecreate?.version).toBe(1);
  });

  it("round-trips the resulting v5 checkpoint and v2 transaction as one identity", () => {
    const migrated = bindCheckpointHarnessPackageAuthority(legacyCheckpoint(), PACKAGE);
    expect(migrated).not.toBeNull();

    expect(inspectCheckpoint(serializeCheckpoint(migrated!))).toEqual({
      status: "loaded",
      checkpoint: migrated,
    });
  });

  it("rejects checkpoint or v2 transaction drift instead of replacing it", () => {
    const migrated = bindCheckpointHarnessPackageAuthority(legacyCheckpoint(), PACKAGE)!;
    expect(() =>
      bindCheckpointHarnessPackageAuthority(
        { ...migrated, harnessPackage: { ...PACKAGE, contentDigest: "e".repeat(64) } },
        PACKAGE,
      ),
    ).toThrow("Checkpoint harness package authority");
    expect(() =>
      bindCheckpointHarnessPackageAuthority(
        {
          ...migrated,
          sandboxRecreate: {
            ...migrated.sandboxRecreate!,
            version: 2,
            harnessPackage: { ...PACKAGE, contentDigest: "f".repeat(64) },
          },
        },
        PACKAGE,
      ),
    ).toThrow("Recreate transaction harness package authority");
  });

  it("rejects a serialized v2 transaction whose identity differs from its checkpoint", () => {
    const migrated = bindCheckpointHarnessPackageAuthority(legacyCheckpoint(), PACKAGE)!;
    const serialized = serializeCheckpoint(migrated);
    const transaction = serialized.sandboxRecreate as Record<string, unknown>;
    transaction.harnessPackage = { ...PACKAGE, contentDigest: "f".repeat(64) };

    expect(inspectCheckpoint(serialized)).toEqual({ status: "corrupt" });
  });
});
