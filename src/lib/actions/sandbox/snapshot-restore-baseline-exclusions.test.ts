// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as f from "./snapshot-restore-test-fixture";

const HERMES_PACKAGE = {
  kind: "agent-runtime" as const,
  id: "hermes",
  packageVersion: "1.2.3",
  contractVersion: 1 as const,
  contentDigest: "b".repeat(64),
};
const HERMES_PACKAGE_ROOT = `/state/harnesses/objects/${HERMES_PACKAGE.contentDigest}`;
const HERMES_SNAPSHOT = {
  ...f.latestBackupFixture,
  version: 2,
  backupComplete: true,
  agentType: HERMES_PACKAGE.id,
  harnessPackage: HERMES_PACKAGE,
};

beforeEach(f.resetSnapshotRestoreMocks);
afterEach(f.cleanupSnapshotRestoreMocks);

describe("runSandboxSnapshot restore: baseline exclusions", () => {
  it("uses the OpenClaw baseline in the shared fixture when the agent is absent", () => {
    const openClawBaseline = {
      agent: "openclaw",
      policyPath: "/repo/nemoclaw-blueprint/policies/openclaw-sandbox.yaml",
      content: "version: 1\nnetwork_policies: {}\n",
    };

    expect(f.resolveAgentBaselinePolicyMock(undefined)).toEqual(openClawBaseline);
    expect(f.resolveAgentBaselinePolicyMock(null)).toEqual(openClawBaseline);
    expect(f.resolveAgentBaselinePolicyMock("openclaw")).toEqual(openClawBaseline);
  });

  it("creates a clone with the source exclusions applied to its live policy (#7178)", async () => {
    const exclusion = {
      version: 1 as const,
      agent: "hermes",
      key: "nous_research",
      digest: "a".repeat(64),
      acknowledgedAt: "2026-07-19T00:00:00.000Z",
      appliedAgentVersion: "0.18.0",
    };
    const cleanup = vi.fn(() => true);
    f.modelPendingCloneRegistry((name) =>
      name === "alpha"
        ? {
            name: "alpha",
            agent: "hermes",
            harnessPackage: HERMES_PACKAGE,
            imageTag: "nemoclaw-alpha:test",
            openshellDriver: "docker",
            provider: "nvidia-nim",
            model: "nvidia/model-a",
            baselineExclusions: [exclusion],
          }
        : null,
    );
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.getLatestBackupMock.mockReturnValue({ ...HERMES_SNAPSHOT });
    f.prepareInitialSandboxCreatePolicyMock.mockReturnValue({
      policyPath: "/tmp/snapshot-clone-policy.yaml",
      appliedPresets: [],
      cleanup,
    });

    const { runSandboxSnapshot } = await import("./snapshot");
    await runSandboxSnapshot("alpha", { kind: "restore", to: "beta" });

    expect(f.resolveAgentDefinitionBaselinePolicyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "hermes",
        packageRoot: HERMES_PACKAGE_ROOT,
        policyAdditionsPath: `${HERMES_PACKAGE_ROOT}/policy-additions.yaml`,
      }),
    );
    expect(f.resolveAgentBaselinePolicyMock).not.toHaveBeenCalled();
    expect(f.prepareInitialSandboxCreatePolicyMock).toHaveBeenCalledWith(
      `${HERMES_PACKAGE_ROOT}/policy-additions.yaml`,
      [],
      { agentName: "hermes", sandboxName: "beta", baselineExclusions: [exclusion] },
    );
    const createArgs = f.streamSandboxCreateMock.mock.calls[0]?.[1] ?? [];
    expect(createArgs[createArgs.indexOf("--policy") + 1]).toBe("/tmp/snapshot-clone-policy.yaml");
    expect(f.registerSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "beta",
        harnessPackage: HERMES_PACKAGE,
        baselineExclusions: [exclusion],
      }),
      undefined,
      { pending: true, expectedCurrent: null },
    );
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
