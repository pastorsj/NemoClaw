// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { loadAgent } from "../../../agent/defs";
import type {
  HarnessPackageIdentity,
  HarnessPackageMigration,
} from "../../../agent-runtime/package/identity";
import { fingerprintSandboxLiveIdentity } from "../../../onboard/sandbox-recreate-transaction";
import type { SandboxEntry } from "../../../state/registry/types";
import type {
  RebuildManifest,
  RecreatedSandboxRestoreOptions,
  RestoreResult,
} from "../../../state/sandbox";
import {
  confirmSnapshotPackageAuthority,
  prepareSnapshotPackageAuthority,
  restoreRecreatedSandboxStateWithManagedAuthority,
} from "./restore-authority";

const LIVE_SANDBOX_OUTPUT = "Name: alpha\nId: sandbox-alpha\nPhase: Ready\n";
const LIVE_SANDBOX_FINGERPRINT = fingerprintSandboxLiveIdentity(LIVE_SANDBOX_OUTPUT)!;

function packageIdentity(digest = "d".repeat(64)): HarnessPackageIdentity {
  return {
    kind: "agent-runtime",
    id: "pi",
    packageVersion: "1.2.3",
    contentDigest: digest,
  };
}

function packageRoot(identity: HarnessPackageIdentity): string {
  return `/state/harnesses/objects/${identity.contentDigest}`;
}

function legacyPackageMigration(agent: string): HarnessPackageMigration {
  return {
    schemaVersion: 1,
    source: "legacy-current-bundle",
    legacyAgent: agent,
    migratedAt: "2026-07-31T00:00:00.000Z",
  };
}

function legacyPiManifest(): RebuildManifest {
  return {
    version: 2,
    sandboxName: "alpha",
    timestamp: "2026-07-31T00-00-00-000Z",
    agentType: "pi",
    agentVersion: null,
    expectedVersion: null,
    harnessPackage: null,
    stateDirs: [],
    dir: "/sandbox",
    backupPath: "/tmp/alpha",
    blueprintDigest: null,
  };
}

function packageSandbox(
  identity: HarnessPackageIdentity,
  migration: HarnessPackageMigration | undefined,
): SandboxEntry {
  return {
    name: "alpha",
    agent: "pi",
    harnessPackage: identity,
    ...(migration === undefined ? {} : { harnessPackageMigration: migration }),
    lifecycleLiveIdentityFingerprint: LIVE_SANDBOX_FINGERPRINT,
  };
}

function captureMatchingLiveSandbox() {
  return {
    status: 0,
    output: LIVE_SANDBOX_OUTPUT,
    stdout: LIVE_SANDBOX_OUTPUT,
    stderr: "",
  };
}

function restoreWithValidation(
  _name: string,
  _path: string,
  options: RecreatedSandboxRestoreOptions,
): RestoreResult {
  try {
    options.validateBeforeMutation?.();
    return {
      success: true,
      restoredDirs: [],
      failedDirs: [],
      restoredFiles: [],
      failedFiles: [],
    };
  } catch (error) {
    return {
      success: false,
      restoredDirs: [],
      failedDirs: ["manifest"],
      restoredFiles: [],
      failedFiles: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

describe("Pi snapshot package authority", () => {
  it("binds a legacy schema-v2 null manifest to its migrated installed package", () => {
    const identity = packageIdentity();
    const source = packageSandbox(identity, legacyPackageMigration("pi"));
    const resolvePinnedPackage = vi.fn(() => ({
      identity,
      packageRoot: packageRoot(identity),
    }));
    const dependencies = { getSandbox: () => source, resolvePinnedPackage };

    const authority = prepareSnapshotPackageAuthority(
      {
        manifest: legacyPiManifest(),
        sourceSandboxName: "alpha",
        targetSandboxName: "alpha",
        targetState: "registered",
      },
      dependencies,
    );
    confirmSnapshotPackageAuthority(authority, dependencies);

    expect(authority).toMatchObject({
      kind: "legacy",
      agentType: "pi",
      harnessPackage: identity,
      harnessPackageMigration: legacyPackageMigration("pi"),
      packageRoot: packageRoot(identity),
    });
    expect(resolvePinnedPackage).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["missing migration provenance", undefined],
    [
      "malformed migration provenance",
      {
        ...legacyPackageMigration("pi"),
        source: "unknown",
      } as unknown as HarnessPackageMigration,
    ],
    ["migration provenance for another agent", legacyPackageMigration("hermes")],
  ] as const)("rejects a legacy schema-v2 null manifest with %s", (_scenario, migration) => {
    const identity = packageIdentity();
    const source = packageSandbox(identity, migration);

    expect(() =>
      prepareSnapshotPackageAuthority(
        {
          manifest: legacyPiManifest(),
          sourceSandboxName: "alpha",
          targetSandboxName: "alpha",
          targetState: "registered",
        },
        {
          getSandbox: () => source,
          resolvePinnedPackage: () => ({ identity, packageRoot: packageRoot(identity) }),
        },
      ),
    ).toThrow(/legacy-current-bundle migration provenance/u);
  });

  it("rejects a legacy schema-v2 null manifest when its installed package changes", () => {
    const identity = packageIdentity();
    const installedIdentity = packageIdentity("e".repeat(64));
    const source = packageSandbox(identity, legacyPackageMigration("pi"));

    expect(() =>
      prepareSnapshotPackageAuthority(
        {
          manifest: legacyPiManifest(),
          sourceSandboxName: "alpha",
          targetSandboxName: "alpha",
          targetState: "registered",
        },
        {
          getSandbox: () => source,
          resolvePinnedPackage: () => ({
            identity: installedIdentity,
            packageRoot: packageRoot(installedIdentity),
          }),
        },
      ),
    ).toThrow("selected snapshot harness package object is unavailable or changed");
  });

  it("rejects qualification loss at the restore mutation fence", () => {
    const identity = packageIdentity();
    const source = packageSandbox(identity, undefined);
    const selectedDefinition = Object.freeze({
      ...loadAgent("openclaw"),
      name: "pi",
      packageRoot: packageRoot(identity),
    });
    const resolveAgentDefinition = vi.fn(() => {
      throw new Error("Pi candidate qualification changed before restore");
    });
    const restore = vi.fn(restoreWithValidation);

    const result = restoreRecreatedSandboxStateWithManagedAuthority(
      source.name,
      { ...legacyPiManifest(), harnessPackage: identity },
      { targetAgentType: "pi", agentDefinition: selectedDefinition },
      {
        getSandbox: () => source,
        captureOpenshell: captureMatchingLiveSandbox,
        resolvePinnedPackage: () => ({ identity, packageRoot: packageRoot(identity) }),
        resolveAgentDefinition,
        captureContentAuthority: () => ({
          schemaVersion: 1,
          backupPath: "/tmp/alpha",
          contentSha256: "f".repeat(64),
        }),
        restore,
      },
    );

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("Pi candidate qualification changed before restore"),
    });
    expect(resolveAgentDefinition).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledOnce();
  });
});
