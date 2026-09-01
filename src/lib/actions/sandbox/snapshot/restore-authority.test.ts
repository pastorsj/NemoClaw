// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { loadAgent, type AgentDefinition } from "../../../agent/defs";
import type {
  HarnessPackageIdentity,
  HarnessPackageMigration,
} from "../../../agent-runtime/package/identity";
import {
  MANAGED_IMAGE_REPOSITORIES,
  type ShippedManagedImageAgent,
} from "../../../onboard/managed-image/contract";
import { encodeManagedStartupProfile } from "../../../onboard/managed-startup/profile";
import { fingerprintSandboxLiveIdentity } from "../../../onboard/sandbox-recreate-transaction";
import type {
  RuntimeProviderBundle,
  RuntimeProviderManagedProfileRestoreAuthority,
} from "../../../onboard/runtime-provider/contract";
import type { SandboxEntry, SandboxWorkloadReceipt } from "../../../state/registry/types";
import type {
  RebuildManifest,
  RecreatedSandboxRestoreOptions,
  RestoreResult,
} from "../../../state/sandbox";
import {
  confirmSnapshotRestoreLiveIdentity,
  confirmSnapshotPackageAuthority,
  createManagedRestoreAuthorityDependencies,
  createSnapshotAuthorityDependencies,
  pendingCloneMatchesPackageAuthority,
  prepareSnapshotPackageAuthority,
  restoreRecreatedSandboxStateWithManagedAuthority,
  type SnapshotPackageAuthority,
} from "./restore-authority";

const LIVE_SANDBOX_OUTPUT = "Name: alpha\nId: sandbox-alpha\nPhase: Ready\n";
const LIVE_SANDBOX_FINGERPRINT = fingerprintSandboxLiveIdentity(LIVE_SANDBOX_OUTPUT)!;

function captureMatchingLiveSandbox() {
  return {
    status: 0,
    output: LIVE_SANDBOX_OUTPUT,
    stdout: LIVE_SANDBOX_OUTPUT,
    stderr: "",
  };
}

function packageIdentity(agent: string, digest = "d".repeat(64)): HarnessPackageIdentity {
  return {
    kind: "agent-runtime",
    id: agent,
    packageVersion: "1.2.3",
    contentDigest: digest,
  };
}

function legacyPackageMigration(agent: string): HarnessPackageMigration {
  return {
    schemaVersion: 1,
    source: "legacy-current-bundle",
    legacyAgent: agent === "openclaw" ? null : agent,
    migratedAt: "2026-07-31T00:00:00.000Z",
  };
}

function workload(
  agent: ShippedManagedImageAgent,
): Extract<SandboxWorkloadReceipt, { kind: "managed-image" }> {
  const encodedProfile = encodeManagedStartupProfile(managedStartupE2eProfile(agent));
  return {
    schemaVersion: 1,
    kind: "managed-image",
    reference: `${MANAGED_IMAGE_REPOSITORIES[agent]}@sha256:${"a".repeat(64)}`,
    platform: "linux/amd64",
    release: "v0.0.88",
    sourceRevision: "b".repeat(40),
    sourceCohort: "ghrun-123-1",
    capabilityContractVersion: 1,
    startupProfileContractVersion: 1,
    encodedProfile,
    startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
    credentialProxyReplayRequired: false,
    shared: true,
  };
}

function runtimeSnapshot() {
  return {
    schemaVersion: 1,
    providerId: "mxc",
    providerHandle: "opaque-preflight",
    lifecycleState: "running",
    lifecycleGeneration: "generation-1",
    runtime: {
      schemaVersion: 1,
      providerId: "mxc",
      runtime: { kind: "session", handle: "session-1" },
      acceleration: { kind: "none" },
    },
  } as const;
}

function manifest(agent: ShippedManagedImageAgent): RebuildManifest {
  return {
    version: 2,
    sandboxName: "alpha",
    timestamp: "2026-07-31T00-00-00-000Z",
    agentType: agent,
    agentVersion: null,
    expectedVersion: null,
    stateDirs: [],
    dir: "/sandbox",
    backupPath: "/tmp/alpha",
    blueprintDigest: null,
    workload: workload(agent),
    runtimeSnapshot: runtimeSnapshot(),
    harnessPackage: packageIdentity(agent),
  };
}

function legacyManifest(agent: ShippedManagedImageAgent): RebuildManifest {
  const { harnessPackage: _harnessPackage, ...legacy } = manifest(agent);
  return { ...legacy, version: 1 };
}

function packageRoot(identity: HarnessPackageIdentity): string {
  return `/state/harnesses/objects/${identity.contentDigest}`;
}

function pinnedAgentDefinition(agent: string, identity = packageIdentity(agent)): AgentDefinition {
  const definition = agent === "pi" ? { ...loadAgent("openclaw"), name: "pi" } : loadAgent(agent);
  return Object.freeze({ ...definition, packageRoot: packageRoot(identity) });
}

function repositoryAgentDefinition(packageRootValue: string): AgentDefinition {
  return Object.freeze({
    ...loadAgent("openclaw"),
    name: "nemocua",
    packageRoot: packageRootValue,
    manifestPath: `${packageRootValue}/manifest.yaml`,
  });
}

function packageDependencies(agent: ShippedManagedImageAgent) {
  const identity = packageIdentity(agent);
  return {
    captureOpenshell: vi.fn(captureMatchingLiveSandbox),
    resolvePinnedPackage: vi.fn(() => ({ identity, packageRoot: packageRoot(identity) })),
    resolveAgentDefinition: vi.fn(() => pinnedAgentDefinition(agent, identity)),
  };
}

function sandbox(agent: ShippedManagedImageAgent): SandboxEntry {
  const receipt = workload(agent);
  return {
    name: "alpha",
    agent,
    harnessPackage: packageIdentity(agent),
    openshellDriver: "mxc",
    imageTag: receipt.reference,
    fromDockerfile: null,
    workload: receipt,
    lifecycleLiveIdentityFingerprint: LIVE_SANDBOX_FINGERPRINT,
  };
}

function packageSandbox(
  name: string,
  agent: string,
  harnessPackage: HarnessPackageIdentity,
): SandboxEntry {
  return {
    name,
    agent: agent === "openclaw" ? null : agent,
    harnessPackage,
    lifecycleLiveIdentityFingerprint: LIVE_SANDBOX_FINGERPRINT,
  };
}

describe("snapshot command package authority helpers", () => {
  it("binds the production package resolver to the supplied registry reader", () => {
    const getSandbox = vi.fn(() => null);

    const dependencies = createSnapshotAuthorityDependencies(getSandbox);

    expect(dependencies.getSandbox).toBe(getSandbox);
    expect(dependencies.resolvePinnedPackage).toEqual(expect.any(Function));
    expect(Object.isFrozen(dependencies)).toBe(true);
  });

  it("binds the production OpenShell reader to the supplied registry view", () => {
    const getSandbox = vi.fn(() => null);

    const dependencies = createManagedRestoreAuthorityDependencies(getSandbox);

    expect(dependencies.getSandbox).toBe(getSandbox);
    expect(dependencies.captureOpenshell).toEqual(expect.any(Function));
    expect(Object.isFrozen(dependencies)).toBe(true);
  });

  it("reads the target live identity from its registered gateway", () => {
    const identity = packageIdentity("openclaw");
    const target: SandboxEntry = {
      ...packageSandbox("alpha", "openclaw", identity),
      gatewayName: "nemoclaw-18080",
      gatewayPort: 18080,
    };
    const captureOpenshell = vi.fn(captureMatchingLiveSandbox);

    confirmSnapshotRestoreLiveIdentity(target, captureOpenshell);

    expect(captureOpenshell).toHaveBeenCalledWith(
      ["sandbox", "get", "-g", "nemoclaw-18080", "alpha"],
      expect.objectContaining({ ignoreError: true, includeStreams: true }),
    );
  });

  it("matches only the exact package shape of a pending clone", () => {
    const identity = packageIdentity("openclaw");
    const authority: SnapshotPackageAuthority = Object.freeze({
      schemaVersion: 1,
      kind: "package",
      sourceSandboxName: "alpha",
      targetSandboxName: "beta",
      agentType: "openclaw",
      harnessPackage: identity,
      harnessPackageMigration: null,
      packageRoot: packageRoot(identity),
      targetOwner: null,
    });

    expect(
      pendingCloneMatchesPackageAuthority(
        { name: "beta", agent: null, harnessPackage: identity },
        authority,
      ),
    ).toBe(true);
    expect(
      pendingCloneMatchesPackageAuthority(
        {
          name: "beta",
          agent: null,
          harnessPackage: identity,
          harnessPackageMigration: legacyPackageMigration("openclaw"),
        },
        authority,
      ),
    ).toBe(false);
    expect(
      pendingCloneMatchesPackageAuthority(
        { name: "beta", agent: "hermes", harnessPackage: identity },
        authority,
      ),
    ).toBe(false);
  });
});

function provider(agent: ShippedManagedImageAgent) {
  const preflight = vi.fn((operation: "backup" | "restore", entry: SandboxEntry) => ({
    schemaVersion: 1 as const,
    providerId: "mxc",
    operation,
    sandboxName: entry.name,
    providerHandle: "opaque-preflight",
    lifecycleState: "running" as const,
    lifecycleGeneration: "generation-1",
  }));
  const validateRestore = vi.fn();
  const restore = vi.fn(
    (
      entry: SandboxEntry,
      _preflight: unknown,
      _source: unknown,
      authority: RuntimeProviderManagedProfileRestoreAuthority,
    ) => ({
      schemaVersion: 1 as const,
      providerId: "mxc",
      sandboxName: entry.name,
      providerHandle: "opaque-restore",
      lifecycleState: "running" as const,
      lifecycleGeneration: "generation-1",
      runtime: runtimeSnapshot().runtime,
      managedProfile: authority,
    }),
  );
  const bundle = {
    identity: { contractVersion: 1, id: "mxc", displayName: "MXC" },
    workload: {
      providerId: "mxc",
      supported: true,
      profile: {
        support: null,
        hostArchitectures: [],
        managedImageSelectionPolicy: "prefer-managed",
        legacyDockerfileBuilds: false,
      },
      acceptsReceipt: (receipt: SandboxWorkloadReceipt | undefined) =>
        receipt?.kind === "managed-image" && receipt.reference === workload(agent).reference,
    },
    snapshot: {
      providerId: "mxc",
      supported: true,
      contractVersion: 1,
      capabilities: { backup: true, restore: true, managedProfileRestore: true },
      preflight,
      capture: () => runtimeSnapshot().runtime,
      validateRestore,
      restore,
    },
  } as unknown as RuntimeProviderBundle;
  return { bundle, preflight, validateRestore, restore };
}

describe("managed rebuild restore authority", () => {
  it("revalidates source, target, and retained package authority before mutation", () => {
    const identity = packageIdentity("openclaw");
    const entries: Record<string, SandboxEntry> = {
      alpha: packageSandbox("alpha", "openclaw", identity),
      beta: packageSandbox("beta", "openclaw", identity),
    };
    const getSandbox = vi.fn((name: string) => entries[name] ?? null);
    const resolvePinnedPackage = vi.fn(() => ({
      identity,
      packageRoot: `/state/harnesses/objects/${identity.contentDigest}`,
    }));
    const selectedManifest: RebuildManifest = {
      ...manifest("openclaw"),
      version: 2,
      harnessPackage: identity,
    };

    const authority = prepareSnapshotPackageAuthority(
      {
        manifest: selectedManifest,
        sourceSandboxName: "alpha",
        targetSandboxName: "beta",
        targetState: "registered",
      },
      { getSandbox, resolvePinnedPackage },
    );
    confirmSnapshotPackageAuthority(authority, { getSandbox, resolvePinnedPackage });

    expect(authority).toMatchObject({
      kind: "package",
      harnessPackage: identity,
      packageRoot: `/state/harnesses/objects/${identity.contentDigest}`,
    });
    expect(resolvePinnedPackage).toHaveBeenCalledTimes(2);
    expect(getSandbox.mock.calls).toEqual([["alpha"], ["beta"], ["alpha"], ["beta"]]);
  });

  it("pins a forced destination under its own package authority", () => {
    const sourceIdentity = packageIdentity("hermes");
    const targetIdentity = packageIdentity("openclaw", "e".repeat(64));
    const replacementIdentity = packageIdentity("openclaw", "f".repeat(64));
    const entries: Record<string, SandboxEntry> = {
      alpha: packageSandbox("alpha", "hermes", sourceIdentity),
      beta: packageSandbox("beta", "openclaw", targetIdentity),
    };
    const dependencies = {
      getSandbox: (name: string) => entries[name] ?? null,
      resolvePinnedPackage: vi.fn((identity: HarnessPackageIdentity) => ({
        identity,
        packageRoot: packageRoot(identity),
      })),
    };

    const authority = prepareSnapshotPackageAuthority(
      {
        manifest: { ...manifest("hermes"), version: 2, harnessPackage: sourceIdentity },
        sourceSandboxName: "alpha",
        targetSandboxName: "beta",
        targetState: "registered",
      },
      dependencies,
    );

    expect(authority).toMatchObject({
      agentType: "hermes",
      harnessPackage: sourceIdentity,
      targetOwner: {
        agentType: "openclaw",
        harnessPackage: targetIdentity,
        packageRoot: packageRoot(targetIdentity),
      },
    });
    expect(() => confirmSnapshotPackageAuthority(authority, dependencies)).not.toThrow();

    entries.beta = packageSandbox("beta", "openclaw", replacementIdentity);
    expect(() => confirmSnapshotPackageAuthority(authority, dependencies)).toThrow(
      "snapshot target harness package authority differs",
    );
  });

  it("binds a legacy manifest to a source package with matching migration provenance", () => {
    const identity = packageIdentity("openclaw");
    const source: SandboxEntry = {
      ...packageSandbox("alpha", "openclaw", identity),
      harnessPackageMigration: legacyPackageMigration("openclaw"),
    };
    const resolvePinnedPackage = vi.fn(() => ({
      identity,
      packageRoot: `/state/harnesses/objects/${identity.contentDigest}`,
    }));

    const authority = prepareSnapshotPackageAuthority(
      {
        manifest: legacyManifest("openclaw"),
        sourceSandboxName: "alpha",
        targetSandboxName: "alpha",
        targetState: "registered",
      },
      { getSandbox: () => source, resolvePinnedPackage },
    );

    expect(authority).toMatchObject({
      kind: "legacy",
      harnessPackage: identity,
      packageRoot: `/state/harnesses/objects/${identity.contentDigest}`,
    });
    expect(resolvePinnedPackage).toHaveBeenCalledWith(identity);
  });

  it.each([
    {
      scenario: "missing migration provenance",
      source: packageSandbox("alpha", "openclaw", packageIdentity("openclaw")),
    },
    {
      scenario: "migration provenance for a different standard agent",
      source: {
        ...packageSandbox("alpha", "openclaw", packageIdentity("openclaw")),
        harnessPackageMigration: {
          ...legacyPackageMigration("openclaw"),
          legacyAgent: "hermes",
        },
      },
    },
  ])("rejects a legacy standard snapshot with $scenario", ({ source }) => {
    expect(() =>
      prepareSnapshotPackageAuthority(
        {
          manifest: legacyManifest("openclaw"),
          sourceSandboxName: "alpha",
          targetSandboxName: "alpha",
          targetState: "registered",
        },
        {
          getSandbox: () => source,
          resolvePinnedPackage: vi.fn(() => ({
            identity: packageIdentity("openclaw"),
            packageRoot: packageRoot(packageIdentity("openclaw")),
          })),
        },
      ),
    ).toThrow(/legacy-current-bundle migration provenance/u);
  });

  it("rejects legacy migration provenance that changes after authority capture", () => {
    const identity = packageIdentity("openclaw");
    let source: SandboxEntry = {
      ...packageSandbox("alpha", "openclaw", identity),
      harnessPackageMigration: legacyPackageMigration("openclaw"),
    };
    const dependencies = {
      getSandbox: () => source,
      resolvePinnedPackage: () => ({ identity, packageRoot: packageRoot(identity) }),
    };
    const authority = prepareSnapshotPackageAuthority(
      {
        manifest: legacyManifest("openclaw"),
        sourceSandboxName: "alpha",
        targetSandboxName: "alpha",
        targetState: "registered",
      },
      dependencies,
    );

    source = {
      ...source,
      harnessPackageMigration: {
        ...legacyPackageMigration("openclaw"),
        migratedAt: "2026-08-01T00:00:00.000Z",
      },
    };

    expect(() => confirmSnapshotPackageAuthority(authority, dependencies)).toThrow(
      /legacy-current-bundle migration provenance/u,
    );
  });

  it("rejects a forced standard destination without package authority", () => {
    const sourceIdentity = packageIdentity("hermes");
    const entries: Record<string, SandboxEntry> = {
      alpha: packageSandbox("alpha", "hermes", sourceIdentity),
      beta: { name: "beta", agent: null },
    };

    expect(() =>
      prepareSnapshotPackageAuthority(
        {
          manifest: { ...manifest("hermes"), harnessPackage: sourceIdentity },
          sourceSandboxName: "alpha",
          targetSandboxName: "beta",
          targetState: "registered",
        },
        {
          getSandbox: (name) => entries[name] ?? null,
          resolvePinnedPackage: (identity) => ({
            identity,
            packageRoot: packageRoot(identity),
          }),
        },
      ),
    ).toThrow("snapshot target standard agent has no harness package authority");
  });

  it("keeps null package authority for a forced qualified repository destination", () => {
    const sourceIdentity = packageIdentity("hermes");
    const entries: Record<string, SandboxEntry> = {
      alpha: packageSandbox("alpha", "hermes", sourceIdentity),
      beta: { name: "beta", agent: "nemocua" },
    };

    const authority = prepareSnapshotPackageAuthority(
      {
        manifest: { ...manifest("hermes"), harnessPackage: sourceIdentity },
        sourceSandboxName: "alpha",
        targetSandboxName: "beta",
        targetState: "registered",
      },
      {
        getSandbox: (name) => entries[name] ?? null,
        resolvePinnedPackage: (identity) => ({
          identity,
          packageRoot: packageRoot(identity),
        }),
      },
    );

    expect(authority.targetOwner).toEqual({
      agentType: "nemocua",
      harnessPackage: null,
      packageRoot: null,
    });
  });

  it.each(["source registry", "target registry", "retained object"] as const)(
    "rejects %s drift at the final package authority check",
    (changedAuthority) => {
      const identity = packageIdentity("hermes");
      const changedIdentity = packageIdentity("hermes", "e".repeat(64));
      const entries: Record<string, SandboxEntry> = {
        alpha: packageSandbox("alpha", "hermes", identity),
        beta: packageSandbox("beta", "hermes", identity),
      };
      let packageChanged = false;
      const resolvePinnedPackage = vi.fn(() => {
        return packageChanged
          ? (() => {
              throw new Error("retained object changed");
            })()
          : {
              identity,
              packageRoot: `/state/harnesses/objects/${identity.contentDigest}`,
            };
      });
      const dependencies = {
        getSandbox: (name: string) => entries[name] ?? null,
        resolvePinnedPackage,
      };
      const authority = prepareSnapshotPackageAuthority(
        {
          manifest: { ...manifest("hermes"), version: 2, harnessPackage: identity },
          sourceSandboxName: "alpha",
          targetSandboxName: "beta",
          targetState: "registered",
        },
        dependencies,
      );

      const mutateAuthority = {
        "source registry": () => {
          entries.alpha = packageSandbox("alpha", "hermes", changedIdentity);
        },
        "target registry": () => {
          entries.beta = packageSandbox("beta", "hermes", changedIdentity);
        },
        "retained object": () => {
          packageChanged = true;
        },
      } satisfies Record<typeof changedAuthority, () => void>;
      mutateAuthority[changedAuthority]();

      expect(() => confirmSnapshotPackageAuthority(authority, dependencies)).toThrow(
        changedAuthority === "retained object"
          ? "selected snapshot harness package object is unavailable or changed"
          : "harness package authority differs from the selected snapshot",
      );
      expect(resolvePinnedPackage).toHaveBeenCalledTimes(
        changedAuthority === "retained object" ? 2 : 1,
      );
    },
  );

  it("keeps repository package absence explicit without resolving a standard package", () => {
    const repositoryOwner: SandboxEntry = { name: "cua-source", agent: "nemocua" };
    const getSandbox = vi.fn(() => repositoryOwner);
    const resolvePinnedPackage = vi.fn();
    const candidateManifest: RebuildManifest = {
      ...manifest("openclaw"),
      version: 2,
      sandboxName: "cua-source",
      agentType: "nemocua",
      harnessPackage: null,
    };

    const authority = prepareSnapshotPackageAuthority(
      {
        manifest: candidateManifest,
        sourceSandboxName: "cua-source",
        targetSandboxName: "cua-source",
        targetState: "registered",
      },
      { getSandbox, resolvePinnedPackage: resolvePinnedPackage as never },
    );
    confirmSnapshotPackageAuthority(authority, {
      getSandbox,
      resolvePinnedPackage: resolvePinnedPackage as never,
    });

    expect(authority).toMatchObject({
      kind: "candidate",
      harnessPackage: null,
      packageRoot: null,
    });
    expect(resolvePinnedPackage).not.toHaveBeenCalled();
  });

  it.each([
    {
      scenario: "definition drift",
      resolveCurrent: () => repositoryAgentDefinition("/repository/package-b"),
      expectedError: "repository agent definition changed before restore",
    },
    {
      scenario: "same-root definition substitution",
      resolveCurrent: () =>
        Object.freeze({
          ...repositoryAgentDefinition("/repository/package-a"),
          stateFiles: [{ path: "different.db", strategy: "sqlite_backup" as const }],
        }),
      expectedError: "repository agent definition changed before restore",
    },
    {
      scenario: "qualification gate loss",
      resolveCurrent: () => {
        throw new Error("release candidate is no longer selectable");
      },
      expectedError: "repository agent qualification is unavailable",
    },
  ])(
    "rejects repository harness $scenario at the final mutation fence",
    ({ resolveCurrent, expectedError }) => {
      const repositoryOwner: SandboxEntry = { name: "cua-source", agent: "nemocua" };
      const selectedDefinition = repositoryAgentDefinition("/repository/package-a");
      const resolveAgentDefinition = vi.fn(resolveCurrent);
      const restore = vi.fn(
        (_name: string, _path: string, options: RecreatedSandboxRestoreOptions): RestoreResult => {
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
        },
      );
      const candidateManifest: RebuildManifest = {
        ...manifest("openclaw"),
        sandboxName: "cua-source",
        agentType: "nemocua",
        harnessPackage: null,
        workload: undefined,
        runtimeSnapshot: undefined,
      };

      const result = restoreRecreatedSandboxStateWithManagedAuthority(
        "cua-source",
        candidateManifest,
        { targetAgentType: "nemocua", agentDefinition: selectedDefinition },
        {
          getSandbox: () => repositoryOwner,
          captureOpenshell: captureMatchingLiveSandbox,
          resolvePinnedPackage: vi.fn() as never,
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
        error: expect.stringContaining(expectedError),
      });
      expect(resolveAgentDefinition).toHaveBeenCalledOnce();
      expect(restore).toHaveBeenCalledOnce();
    },
  );

  it("requalifies and exact-compares a legacy-v1 NemoCUA definition at the mutation fence", () => {
    const agent = "nemocua";
    const sourceName = `${agent}-source`;
    const source: SandboxEntry = { name: sourceName, agent };
    const selectedDefinition = repositoryAgentDefinition("/repository/package-a");
    const resolveAgentDefinition = vi.fn(() =>
      Object.freeze({
        ...selectedDefinition,
        stateFiles: [{ path: "different.db", strategy: "sqlite_backup" as const }],
      }),
    );
    const restore = vi.fn(
      (_name: string, _path: string, options: RecreatedSandboxRestoreOptions): RestoreResult => {
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
      },
    );
    const legacyCandidateManifest: RebuildManifest = {
      ...legacyManifest("openclaw"),
      sandboxName: sourceName,
      agentType: agent,
      workload: undefined,
      runtimeSnapshot: undefined,
    };

    const result = restoreRecreatedSandboxStateWithManagedAuthority(
      sourceName,
      legacyCandidateManifest,
      { targetAgentType: agent, agentDefinition: selectedDefinition },
      {
        getSandbox: () => source,
        captureOpenshell: captureMatchingLiveSandbox,
        resolvePinnedPackage: vi.fn() as never,
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
      error: expect.stringContaining("repository agent definition changed before restore"),
    });
    expect(resolveAgentDefinition).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledOnce();
  });

  it("rejects same-root package definition drift at the mutation fence", () => {
    const identity = packageIdentity("openclaw");
    const source = packageSandbox("alpha", "openclaw", identity);
    const selectedDefinition = pinnedAgentDefinition("openclaw", identity);
    const resolveAgentDefinition = vi.fn(() =>
      Object.freeze({
        ...selectedDefinition,
        stateFiles: [{ path: "different.json", strategy: "copy" as const }],
      }),
    );
    const restore = vi.fn(
      (_name: string, _path: string, options: RecreatedSandboxRestoreOptions): RestoreResult => {
        expect(options.agentDefinition).toBe(selectedDefinition);
        expect(resolveAgentDefinition).not.toHaveBeenCalled();
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
      },
    );

    const result = restoreRecreatedSandboxStateWithManagedAuthority(
      source.name,
      {
        ...manifest("openclaw"),
        harnessPackage: identity,
        workload: undefined,
        runtimeSnapshot: undefined,
      },
      { targetAgentType: "openclaw", agentDefinition: selectedDefinition },
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
      error: expect.stringContaining("package agent definition changed before restore"),
    });
    expect(resolveAgentDefinition).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledOnce();
  });

  it("applies the package and content checks to a state-only restore", () => {
    const identity = packageIdentity("openclaw");
    const target = packageSandbox("alpha", "openclaw", identity);
    const resolvePinnedPackage = vi.fn(() => ({
      identity,
      packageRoot: `/state/harnesses/objects/${identity.contentDigest}`,
    }));
    const restore = vi.fn(
      (_name: string, _path: string, options: RecreatedSandboxRestoreOptions): RestoreResult => {
        options.validateBeforeMutation?.();
        return {
          success: true,
          restoredDirs: [],
          failedDirs: [],
          restoredFiles: [],
          failedFiles: [],
        };
      },
    );

    const result = restoreRecreatedSandboxStateWithManagedAuthority(
      "alpha",
      {
        ...manifest("openclaw"),
        version: 2,
        harnessPackage: identity,
        workload: undefined,
        runtimeSnapshot: undefined,
      },
      {
        targetAgentType: "openclaw",
        agentDefinition: pinnedAgentDefinition("openclaw", identity),
      },
      {
        getSandbox: () => target,
        captureOpenshell: captureMatchingLiveSandbox,
        resolvePinnedPackage,
        resolveAgentDefinition: () => pinnedAgentDefinition("openclaw", identity),
        captureContentAuthority: () => ({
          schemaVersion: 1,
          backupPath: "/tmp/alpha",
          contentSha256: "f".repeat(64),
        }),
        restore,
      },
    );

    expect(result.success).toBe(true);
    expect(resolvePinnedPackage).toHaveBeenCalledTimes(3);
    expect(restore).toHaveBeenCalledWith(
      "alpha",
      "/tmp/alpha",
      expect.objectContaining({
        authority: expect.objectContaining({ contentSha256: "f".repeat(64) }),
        validateBeforeMutation: expect.any(Function),
      }),
    );
  });

  it("rejects a same-name live sandbox swap before filesystem mutation", () => {
    const identity = packageIdentity("openclaw");
    const target: SandboxEntry = {
      ...packageSandbox("alpha", "openclaw", identity),
      gatewayName: "nemoclaw-18080",
      gatewayPort: 18080,
    };
    const replacementOutput = "Name: alpha\nId: sandbox-replacement\nPhase: Ready\n";
    const captureOpenshell = vi.fn(() => ({
      status: 0,
      output: replacementOutput,
      stdout: replacementOutput,
      stderr: "",
    }));
    let filesystemMutations = 0;
    const restore = vi.fn(
      (_name: string, _path: string, options: RecreatedSandboxRestoreOptions): RestoreResult => {
        try {
          options.validateBeforeMutation?.();
          filesystemMutations += 1;
          return {
            success: true,
            restoredDirs: ["workspace"],
            failedDirs: [],
            restoredFiles: [],
            failedFiles: [],
          };
        } catch (error) {
          return {
            success: false,
            restoredDirs: [],
            failedDirs: ["workspace"],
            restoredFiles: [],
            failedFiles: [],
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    );

    const result = restoreRecreatedSandboxStateWithManagedAuthority(
      "alpha",
      {
        ...manifest("openclaw"),
        workload: undefined,
        runtimeSnapshot: undefined,
      },
      {
        targetAgentType: "openclaw",
        agentDefinition: pinnedAgentDefinition("openclaw", identity),
      },
      {
        getSandbox: () => target,
        captureOpenshell,
        resolvePinnedPackage: () => ({ identity, packageRoot: packageRoot(identity) }),
        resolveAgentDefinition: () => pinnedAgentDefinition("openclaw", identity),
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
      error: expect.stringContaining("live identity changed before restore"),
    });
    expect(filesystemMutations).toBe(0);
    expect(captureOpenshell).toHaveBeenCalledWith(
      ["sandbox", "get", "-g", "nemoclaw-18080", "alpha"],
      expect.any(Object),
    );
  });

  it("rejects state-only restore before mutation when the target row changes", () => {
    const identity = packageIdentity("openclaw");
    let target: SandboxEntry = packageSandbox("alpha", "openclaw", identity);
    const restore = vi.fn(
      (_name: string, _path: string, options: RecreatedSandboxRestoreOptions): RestoreResult => {
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
      },
    );

    const result = restoreRecreatedSandboxStateWithManagedAuthority(
      "alpha",
      {
        ...manifest("openclaw"),
        workload: undefined,
        runtimeSnapshot: undefined,
      },
      {
        targetAgentType: "openclaw",
        agentDefinition: pinnedAgentDefinition("openclaw", identity),
      },
      {
        getSandbox: () => target,
        captureOpenshell: captureMatchingLiveSandbox,
        resolvePinnedPackage: () => ({ identity, packageRoot: packageRoot(identity) }),
        resolveAgentDefinition: () => pinnedAgentDefinition("openclaw", identity),
        captureContentAuthority: () => {
          target = { ...target, dashboardPort: 19999 };
          return {
            schemaVersion: 1,
            backupPath: "/tmp/alpha",
            contentSha256: "f".repeat(64),
          };
        },
        restore,
      },
    );

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("target 'alpha' changed before restore"),
    });
    expect(restore).toHaveBeenCalledOnce();
  });

  it("reports state-only target-row drift during filesystem restore", () => {
    const identity = packageIdentity("openclaw");
    let target: SandboxEntry = packageSandbox("alpha", "openclaw", identity);
    const restore = vi.fn(
      (_name: string, _path: string, options: RecreatedSandboxRestoreOptions): RestoreResult => {
        options.validateBeforeMutation?.();
        target = { ...target, dashboardPort: 19999 };
        return {
          success: true,
          restoredDirs: [],
          failedDirs: [],
          restoredFiles: [],
          failedFiles: [],
        };
      },
    );

    const result = restoreRecreatedSandboxStateWithManagedAuthority(
      "alpha",
      {
        ...manifest("openclaw"),
        workload: undefined,
        runtimeSnapshot: undefined,
      },
      {
        targetAgentType: "openclaw",
        agentDefinition: pinnedAgentDefinition("openclaw", identity),
      },
      {
        getSandbox: () => target,
        captureOpenshell: captureMatchingLiveSandbox,
        resolvePinnedPackage: () => ({ identity, packageRoot: packageRoot(identity) }),
        resolveAgentDefinition: () => pinnedAgentDefinition("openclaw", identity),
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
      error: expect.stringContaining("target 'alpha' changed during restore"),
    });
  });

  it.each(["openclaw", "hermes", "langchain-deepagents-code"] as const)(
    "revalidates %s content and provider authority at the mutation edge",
    (agent) => {
      const target = sandbox(agent);
      const runtimeProvider = provider(agent);
      const packageAuthority = packageDependencies(agent);
      const restore = vi.fn(
        (_name: string, _path: string, options: RecreatedSandboxRestoreOptions): RestoreResult => {
          options.validateBeforeMutation?.();
          return {
            success: true,
            restoredDirs: ["workspace"],
            failedDirs: [],
            restoredFiles: [],
            failedFiles: [],
          };
        },
      );

      const result = restoreRecreatedSandboxStateWithManagedAuthority(
        "alpha",
        manifest(agent),
        { targetAgentType: agent, agentDefinition: pinnedAgentDefinition(agent) },
        {
          ...packageAuthority,
          getSandbox: () => target,
          requireProvider: () => runtimeProvider.bundle,
          captureContentAuthority: () => ({
            schemaVersion: 1,
            backupPath: "/tmp/alpha",
            contentSha256: "c".repeat(64),
          }),
          restore,
        },
      );

      expect(result.success).toBe(true);
      expect(restore).toHaveBeenCalledWith(
        "alpha",
        "/tmp/alpha",
        expect.objectContaining({
          authority: expect.objectContaining({ contentSha256: "c".repeat(64) }),
          validateBeforeMutation: expect.any(Function),
        }),
      );
      expect(runtimeProvider.preflight).toHaveBeenCalledTimes(2);
      expect(runtimeProvider.validateRestore).toHaveBeenCalledTimes(2);
      expect(runtimeProvider.restore).toHaveBeenCalledOnce();
    },
  );

  it("does not apply provider restore after the target row changes during filesystem restore", () => {
    let target = sandbox("openclaw");
    const runtimeProvider = provider("openclaw");
    const packageAuthority = packageDependencies("openclaw");
    const restore = vi.fn(
      (_name: string, _path: string, options: RecreatedSandboxRestoreOptions): RestoreResult => {
        options.validateBeforeMutation?.();
        target = { ...target, dashboardPort: 19999 };
        return {
          success: true,
          restoredDirs: ["workspace"],
          failedDirs: [],
          restoredFiles: [],
          failedFiles: [],
        };
      },
    );

    const result = restoreRecreatedSandboxStateWithManagedAuthority(
      "alpha",
      manifest("openclaw"),
      { targetAgentType: "openclaw", agentDefinition: pinnedAgentDefinition("openclaw") },
      {
        ...packageAuthority,
        getSandbox: () => target,
        requireProvider: () => runtimeProvider.bundle,
        captureContentAuthority: () => ({
          schemaVersion: 1,
          backupPath: "/tmp/alpha",
          contentSha256: "c".repeat(64),
        }),
        restore,
      },
    );

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("target 'alpha' changed during restore"),
    });
    expect(runtimeProvider.restore).not.toHaveBeenCalled();
  });

  it("does not apply provider restore after a same-name live sandbox replaces the target", () => {
    const target = sandbox("openclaw");
    const runtimeProvider = provider("openclaw");
    const packageAuthority = packageDependencies("openclaw");
    const replacementOutput = "Name: alpha\nId: sandbox-replacement\nPhase: Ready\n";
    const captureOpenshell = vi
      .fn()
      .mockImplementationOnce(captureMatchingLiveSandbox)
      .mockReturnValue({
        status: 0,
        output: replacementOutput,
        stdout: replacementOutput,
        stderr: "",
      });
    const restore = vi.fn(
      (_name: string, _path: string, options: RecreatedSandboxRestoreOptions): RestoreResult => {
        options.validateBeforeMutation?.();
        return {
          success: true,
          restoredDirs: ["workspace"],
          failedDirs: [],
          restoredFiles: [],
          failedFiles: [],
        };
      },
    );

    const result = restoreRecreatedSandboxStateWithManagedAuthority(
      "alpha",
      manifest("openclaw"),
      { targetAgentType: "openclaw", agentDefinition: pinnedAgentDefinition("openclaw") },
      {
        ...packageAuthority,
        captureOpenshell,
        getSandbox: () => target,
        requireProvider: () => runtimeProvider.bundle,
        captureContentAuthority: () => ({
          schemaVersion: 1,
          backupPath: "/tmp/alpha",
          contentSha256: "c".repeat(64),
        }),
        restore,
      },
    );

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("live identity changed before restore"),
    });
    expect(captureOpenshell).toHaveBeenCalledTimes(2);
    expect(runtimeProvider.restore).not.toHaveBeenCalled();
  });

  it("applies current package ownership and content authority to a legacy state-only restore", () => {
    const identity = packageIdentity("openclaw");
    const target: SandboxEntry = {
      ...packageSandbox("alpha", "openclaw", identity),
      harnessPackageMigration: legacyPackageMigration("openclaw"),
    };
    const resolvePinnedPackage = vi.fn(() => ({
      identity,
      packageRoot: packageRoot(identity),
    }));
    const captureContentAuthority = vi.fn(() => ({
      schemaVersion: 1 as const,
      backupPath: "/tmp/alpha",
      contentSha256: "a".repeat(64),
    }));
    const requireProvider = vi.fn();
    const restore = vi.fn(
      (_name: string, _path: string, options: RecreatedSandboxRestoreOptions): RestoreResult => {
        options.validateBeforeMutation?.();
        return {
          success: true,
          restoredDirs: [],
          failedDirs: [],
          restoredFiles: [],
          failedFiles: [],
        };
      },
    );

    const result = restoreRecreatedSandboxStateWithManagedAuthority(
      "alpha",
      { ...legacyManifest("openclaw"), workload: undefined, runtimeSnapshot: undefined },
      {
        targetAgentType: "openclaw",
        agentDefinition: pinnedAgentDefinition("openclaw", identity),
      },
      {
        getSandbox: () => target,
        captureOpenshell: captureMatchingLiveSandbox,
        resolvePinnedPackage,
        resolveAgentDefinition: () => pinnedAgentDefinition("openclaw", identity),
        requireProvider: requireProvider as never,
        captureContentAuthority,
        restore,
      },
    );

    expect(result.success).toBe(true);
    expect(resolvePinnedPackage).toHaveBeenCalledTimes(3);
    expect(captureContentAuthority).toHaveBeenCalledOnce();
    expect(requireProvider).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledWith(
      "alpha",
      "/tmp/alpha",
      expect.objectContaining({
        agentDefinition: expect.objectContaining({ packageRoot: packageRoot(identity) }),
        authority: expect.objectContaining({ contentSha256: "a".repeat(64) }),
        validateBeforeMutation: expect.any(Function),
      }),
    );
  });

  it("rejects a managed manifest without provider runtime authority", () => {
    const target = sandbox("hermes");
    const packageAuthority = packageDependencies("hermes");
    const restore = vi.fn();
    const result = restoreRecreatedSandboxStateWithManagedAuthority(
      "alpha",
      { ...manifest("hermes"), runtimeSnapshot: undefined },
      { targetAgentType: "hermes", agentDefinition: pinnedAgentDefinition("hermes") },
      {
        ...packageAuthority,
        getSandbox: () => target,
        requireProvider: vi.fn() as never,
        captureContentAuthority: vi.fn(),
        restore,
      },
    );

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("missing provider runtime authority"),
    });
    expect(restore).not.toHaveBeenCalled();
  });
});
