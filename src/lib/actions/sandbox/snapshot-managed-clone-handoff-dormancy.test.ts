// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { HarnessStartupSettings } from "@nvidia/nemoclaw-harness-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HarnessPackageIdentity } from "../../agent-runtime/package/identity";
import type { ResolvedSandboxAgent } from "../../onboard/sandbox-agent";
import { encodeManagedStartupDurableProfile } from "../../onboard/managed-startup/profile";
import type { SandboxWorkloadReceipt } from "../../state/registry/types";
import * as fixture from "./snapshot-restore-test-fixture";

let managedWorkloadAuthorityDependencies: typeof import("../../onboard/workload/authority").managedWorkloadAuthorityDependencies;
let originalPackageResolver: typeof managedWorkloadAuthorityDependencies.resolvePackageBackedSandboxAgent;
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

beforeEach(async () => {
  fixture.resetSnapshotRestoreMocks();
  ({ managedWorkloadAuthorityDependencies } = await import("../../onboard/workload/authority"));
  originalPackageResolver = managedWorkloadAuthorityDependencies.resolvePackageBackedSandboxAgent;
});
afterEach(() => {
  managedWorkloadAuthorityDependencies.resolvePackageBackedSandboxAgent = originalPackageResolver;
  fixture.cleanupSnapshotRestoreMocks();
});

function configureFuturePackageSnapshot(
  profilePackage: HarnessPackageIdentity = FUTURE_PACKAGE,
): void {
  managedWorkloadAuthorityDependencies.resolvePackageBackedSandboxAgent = vi.fn((entry) => {
    if (!isDeepStrictEqual(entry.harnessPackage, FUTURE_PACKAGE)) {
      throw new Error("installed future harness receipt changed");
    }
    return {
      recordedAgent: FUTURE_PACKAGE.id,
      effectiveAgentId: FUTURE_PACKAGE.id,
      definition: {
        name: FUTURE_PACKAGE.id,
        packageRoot: `/state/harnesses/objects/${FUTURE_PACKAGE.contentDigest}`,
        managedImage: FUTURE_MANAGED_IMAGE,
      },
      harnessPackage: FUTURE_PACKAGE,
      harnessPackageMigration: null,
    } as unknown as ResolvedSandboxAgent;
  });
  const encodedProfile = encodeManagedStartupDurableProfile({
    schemaVersion: 1,
    profileKind: "package",
    agent: profilePackage.id,
    harnessPackage: profilePackage,
    desiredState: FUTURE_DESIRED_STATE,
    packageConfig: { extension: { retained: true } },
    corporateCa: { bundleSha256: null },
  });
  const workload: Extract<SandboxWorkloadReceipt, { kind: "managed-image" }> = {
    schemaVersion: 1 as const,
    kind: "managed-image" as const,
    reference: `${FUTURE_MANAGED_IMAGE.repository}@sha256:${"8".repeat(64)}`,
    platform: "linux/amd64" as const,
    release: "v0.0.100",
    sourceRevision: "b".repeat(40),
    sourceCohort: "ghrun-123-1",
    capabilityContractVersion: 1 as const,
    startupProfileContractVersion: 1 as const,
    encodedProfile,
    startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
    credentialProxyReplayRequired: false,
    shared: true,
  };
  fixture.getLatestBackupMock.mockReturnValue({
    version: 2,
    backupComplete: true,
    snapshotVersion: 4,
    timestamp: "2026-07-30T00:00:00.000Z",
    backupPath: "/tmp/backup-alpha",
    sandboxName: "alpha",
    agentType: FUTURE_PACKAGE.id,
    harnessPackage: FUTURE_PACKAGE,
    workload,
    runtimeSnapshot: {
      schemaVersion: 1,
      providerId: "docker",
      providerHandle: "snapshot-provider-handle",
      lifecycleState: "running",
      lifecycleGeneration: "snapshot-generation",
      runtime: {
        schemaVersion: 1,
        providerId: "docker",
        runtime: { kind: "docker-container", handle: "container-id" },
        acceleration: { kind: "none" },
      },
    },
  });
  fixture.getSandboxMock.mockImplementation((name) =>
    name === "alpha"
      ? {
          name: "alpha",
          agent: FUTURE_PACKAGE.id,
          harnessPackage: FUTURE_PACKAGE,
          openshellDriver: "docker",
          imageTag: workload.reference,
          workload,
        }
      : null,
  );
}

function expectNoCloneEffects(): void {
  expect(fixture.lifecycleMock.events).not.toContain("delete");
  expect(fixture.streamSandboxCreateMock).not.toHaveBeenCalled();
  expect(fixture.restoreSandboxStateMock).not.toHaveBeenCalled();
  expect(fixture.runOpenshellMock).not.toHaveBeenCalledWith(
    expect.arrayContaining(["provider", "create"]),
    expect.anything(),
  );
}

describe("managed snapshot clone activation boundary", () => {
  it("rejects an unknown receipt-backed package clone before destination effects (#7744)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    configureFuturePackageSnapshot();
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta", force: true, yes: true }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "requires managed-profile clone rebind",
    );
    expectNoCloneEffects();
  });

  it("rejects embedded package-field drift before destination effects", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    configureFuturePackageSnapshot({ ...FUTURE_PACKAGE, contentDigest: "7".repeat(64) });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta", force: true, yes: true }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "invalid managed workload authority",
    );
    expectNoCloneEffects();
  });
});
