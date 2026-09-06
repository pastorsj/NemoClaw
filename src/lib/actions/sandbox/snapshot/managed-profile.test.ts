// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { HarnessStartupSettings } from "@nvidia/nemoclaw-harness-contract";
import { afterEach, describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import type { HarnessPackageIdentity } from "../../../agent-runtime/package/identity";
import type { ResolvedSandboxAgent } from "../../../onboard/sandbox-agent";
import {
  MANAGED_IMAGE_REPOSITORIES,
  type ShippedManagedImageAgent,
} from "../../../onboard/managed-image/contract";
import {
  encodeManagedStartupDurableProfile,
  encodeManagedStartupProfile,
  fingerprintManagedStartupDurableProfile,
  fingerprintManagedStartupProfile,
} from "../../../onboard/managed-startup/profile";
import { managedWorkloadAuthorityDependencies } from "../../../onboard/workload/authority";
import type { RuntimeProviderBundle } from "../../../onboard/runtime-provider/contract";
import type { SandboxEntry, SandboxWorkloadReceipt } from "../../../state/registry/types";
import {
  inspectManagedSnapshotCloneSupport,
  prepareManagedSnapshotProfileRestore,
  readManagedSnapshotProfileAuthority,
  rejectManagedSnapshotCloneUntilRebind,
} from "./managed-profile";

const ORIGINAL_PACKAGE_RESOLVER =
  managedWorkloadAuthorityDependencies.resolvePackageBackedSandboxAgent;
const FUTURE_PACKAGE: HarnessPackageIdentity = {
  kind: "agent-runtime",
  id: "future-harness",
  packageVersion: "1.2.3",
  contentDigest: "9".repeat(64),
};
const FUTURE_MANAGED_IMAGE = {
  repository: "registry.example/team/future-harness",
  architectures: ["linux/amd64"],
  runtime_identity: { uid: 1234, gid: 1234, workdir: "/sandbox" },
} as const;
const FUTURE_DESIRED_STATE: HarnessStartupSettings = {
  configuration: {},
  inference: {
    routeProvider: "inference",
    upstreamProvider: "nvidia",
    model: "nvidia/future-model",
    routedBaseUrl: "https://inference.local/v1",
    upstreamEndpointUrl: null,
    api: "openai-completions",
    primaryModelRef: null,
    compatibility: null,
    inputModalities: null,
  },
  proxy: {
    managedHost: "10.200.0.1",
    managedPort: 3128,
    hostHttpUrl: null,
    hostHttpsUrl: null,
    hostNoProxy: [],
  },
  dashboard: { mode: "disabled" },
  tools: { disclosure: "progressive", enabledGateways: [] },
  messaging: { plan: null },
  tuning: {
    contextWindow: null,
    maxTokens: null,
    reasoning: null,
    reasoningEffort: null,
  },
  corporateCa: { bundleSha256: null },
};

function futureWorkload(
  profilePackage: HarnessPackageIdentity = FUTURE_PACKAGE,
): Extract<SandboxWorkloadReceipt, { kind: "managed-image" }> {
  const encodedProfile = encodeManagedStartupDurableProfile({
    schemaVersion: 1,
    profileKind: "package",
    agent: profilePackage.id,
    harnessPackage: profilePackage,
    desiredState: FUTURE_DESIRED_STATE,
    packageConfig: { extension: { retained: true } },
    corporateCa: { bundleSha256: null },
  });
  return {
    schemaVersion: 1 as const,
    kind: "managed-image" as const,
    reference: `${FUTURE_MANAGED_IMAGE.repository}@sha256:${"8".repeat(64)}`,
    platform: "linux/amd64" as const,
    release: "v0.0.100",
    sourceRevision: "d".repeat(40),
    sourceCohort: "ghrun-100-1",
    capabilityContractVersion: 1 as const,
    startupProfileContractVersion: 1 as const,
    encodedProfile,
    startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
    credentialProxyReplayRequired: false,
    shared: true,
  };
}

function futureSandbox(receipt = futureWorkload()): SandboxEntry {
  return {
    name: "alpha",
    agent: FUTURE_PACKAGE.id,
    harnessPackage: FUTURE_PACKAGE,
    openshellDriver: "mxc",
    imageTag: receipt.reference,
    fromDockerfile: null,
    workload: receipt,
  };
}

function useFuturePackageResolver(): void {
  managedWorkloadAuthorityDependencies.resolvePackageBackedSandboxAgent = vi.fn((entry) => {
    if (!isDeepStrictEqual(entry.harnessPackage, FUTURE_PACKAGE)) {
      throw new Error("installed future harness receipt changed");
    }
    return {
      recordedAgent: FUTURE_PACKAGE.id,
      effectiveAgentId: FUTURE_PACKAGE.id,
      definition: {
        name: FUTURE_PACKAGE.id,
        packageRoot: "/installed/future-harness",
        managedImage: FUTURE_MANAGED_IMAGE,
      },
      harnessPackage: FUTURE_PACKAGE,
      harnessPackageMigration: null,
    } as unknown as ResolvedSandboxAgent;
  });
}

afterEach(() => {
  managedWorkloadAuthorityDependencies.resolvePackageBackedSandboxAgent = ORIGINAL_PACKAGE_RESOLVER;
});

function workload(
  agent: ShippedManagedImageAgent,
  changedProfile = false,
): Extract<SandboxWorkloadReceipt, { kind: "managed-image" }> {
  const encodedProfile = encodeManagedStartupProfile(
    managedStartupE2eProfile(agent, changedProfile),
  );
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

function sandbox(agent: ShippedManagedImageAgent, receipt = workload(agent)): SandboxEntry {
  return {
    name: "alpha",
    agent,
    openshellDriver: "mxc",
    imageTag: receipt.reference,
    fromDockerfile: null,
    workload: receipt,
  };
}

function provider(accepted = true, managedProfileRestore = true): RuntimeProviderBundle {
  return {
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
      acceptsReceipt: () => accepted,
    },
    snapshot: {
      providerId: "mxc",
      supported: true,
      contractVersion: 1,
      capabilities: {
        backup: true,
        restore: true,
        managedProfileRestore,
      },
      preflight: () => {
        throw new Error("profile preflight must not perform runtime effects");
      },
      capture: () => {
        throw new Error("profile preflight must not perform runtime effects");
      },
      validateRestore: () => {
        throw new Error("profile preflight must not perform runtime effects");
      },
      restore: () => {
        throw new Error("profile preflight must not perform runtime effects");
      },
    },
  } as unknown as RuntimeProviderBundle;
}

describe("managed snapshot profile restore", () => {
  it.each(["openclaw", "hermes", "langchain-deepagents-code"] as const)(
    "validates exact secret-free %s profile authority",
    (agent) => {
      const receipt = workload(agent);
      const source = { sandboxName: "alpha", agentType: agent, workload: receipt };

      const plan = prepareManagedSnapshotProfileRestore(
        source,
        sandbox(agent, receipt),
        provider(),
      );

      expect(plan).toMatchObject({
        schemaVersion: 1,
        providerId: "mxc",
        sourceSandboxName: "alpha",
        targetSandboxName: "alpha",
        authority: {
          agent,
          receipt,
          profile: { agent },
        },
        providerRestoreAuthority: {
          agent,
          profileFingerprint: fingerprintManagedStartupProfile(managedStartupE2eProfile(agent)),
        },
      });
    },
  );

  it("returns null for legacy snapshots without managed workload authority", () => {
    expect(
      readManagedSnapshotProfileAuthority({
        sandboxName: "legacy",
        agentType: "openclaw",
      }),
    ).toBeNull();
  });

  it("rejects malformed snapshot authority before consulting the target", () => {
    const receipt = {
      ...workload("hermes"),
      startupProfileSha256: "0".repeat(64),
    };
    expect(() =>
      prepareManagedSnapshotProfileRestore(
        { sandboxName: "alpha", agentType: "hermes", workload: receipt },
        sandbox("hermes"),
        provider(),
      ),
    ).toThrow(/invalid managed workload authority/u);
  });

  it("rebinds a same-name rebuild to its accepted replacement profile", () => {
    const receipt = workload("openclaw");
    const source = { sandboxName: "alpha", agentType: "openclaw", workload: receipt };
    const replacement = workload("openclaw", true);

    const plan = prepareManagedSnapshotProfileRestore(
      source,
      sandbox("openclaw", replacement),
      provider(),
    );

    expect(plan?.authority.receipt).toEqual(receipt);
    expect(plan?.providerRestoreAuthority).toEqual({
      agent: "openclaw",
      profileFingerprint: fingerprintManagedStartupProfile(
        managedStartupE2eProfile("openclaw", true),
      ),
    });
  });

  it("validates an unknown receipt-backed package before reporting clone unsupported", () => {
    useFuturePackageResolver();
    const receipt = futureWorkload();
    const source = {
      sandboxName: "alpha",
      agentType: FUTURE_PACKAGE.id,
      harnessPackage: FUTURE_PACKAGE,
      workload: receipt,
    };

    const support = inspectManagedSnapshotCloneSupport(source);
    const restorePlan = prepareManagedSnapshotProfileRestore(
      source,
      futureSandbox(receipt),
      provider(),
    );
    if (support.kind !== "unsupported") {
      throw new Error("expected package clone support to be unavailable");
    }

    expect(support).toMatchObject({
      kind: "unsupported",
      reason: "receipt-backed package clone rebind is not implemented",
      authority: {
        agent: FUTURE_PACKAGE.id,
        harnessPackage: FUTURE_PACKAGE,
        contract: { harnessPackage: FUTURE_PACKAGE },
        profile: { profileKind: "package", harnessPackage: FUTURE_PACKAGE },
      },
    });
    expect(Object.isFrozen(support)).toBe(true);
    expect(restorePlan).toMatchObject({
      authority: { harnessPackage: FUTURE_PACKAGE },
      providerRestoreAuthority: {
        agent: FUTURE_PACKAGE.id,
        profileFingerprint: fingerprintManagedStartupDurableProfile(support.authority.profile),
      },
    });
  });

  it.each([
    ["version", { ...FUTURE_PACKAGE, packageVersion: "1.2.4" }],
    ["digest", { ...FUTURE_PACKAGE, contentDigest: "7".repeat(64) }],
  ] as const)(
    "rejects unknown-package %s drift before clone support is granted",
    (_field, drift) => {
      useFuturePackageResolver();

      expect(() =>
        inspectManagedSnapshotCloneSupport({
          sandboxName: "alpha",
          agentType: FUTURE_PACKAGE.id,
          harnessPackage: drift,
          workload: futureWorkload(),
        }),
      ).toThrow(/invalid managed workload authority/u);
    },
  );

  it("rejects a package profile whose embedded receipt identity drifted", () => {
    useFuturePackageResolver();
    const driftedProfilePackage = { ...FUTURE_PACKAGE, packageVersion: "1.2.4" };

    expect(() =>
      inspectManagedSnapshotCloneSupport({
        sandboxName: "alpha",
        agentType: FUTURE_PACKAGE.id,
        harnessPackage: FUTURE_PACKAGE,
        workload: futureWorkload(driftedProfilePackage),
      }),
    ).toThrow(/invalid managed workload authority/u);
  });

  it("rejects provider refusal and cross-sandbox or cross-agent rebind", () => {
    const receipt = workload("openclaw");
    const source = { sandboxName: "alpha", agentType: "openclaw", workload: receipt };
    expect(() =>
      prepareManagedSnapshotProfileRestore(source, sandbox("openclaw", receipt), provider(false)),
    ).toThrow(/does not accept the snapshot workload receipt/u);
    expect(() =>
      prepareManagedSnapshotProfileRestore(
        source,
        sandbox("openclaw", receipt),
        provider(true, false),
      ),
    ).toThrow(/does not support managed-profile restore/u);
    expect(() =>
      prepareManagedSnapshotProfileRestore(
        source,
        { ...sandbox("openclaw", receipt), name: "beta" },
        provider(),
      ),
    ).toThrow(/requires a managed image or startup-profile rebind/u);
    expect(() =>
      prepareManagedSnapshotProfileRestore(source, sandbox("hermes"), provider()),
    ).toThrow(/requires a managed image or startup-profile rebind/u);
  });

  it("fails before a managed cross-sandbox clone can reach image-only creation", () => {
    expect(() =>
      rejectManagedSnapshotCloneUntilRebind(
        {
          sandboxName: "alpha",
          agentType: "langchain-deepagents-code",
          workload: workload("langchain-deepagents-code"),
        },
        "beta",
      ),
    ).toThrow(/requires managed-profile clone rebind/u);
  });
});
