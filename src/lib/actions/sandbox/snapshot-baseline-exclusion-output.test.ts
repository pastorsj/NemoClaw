// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { testTimeoutOptions } from "../../../../test/helpers/timeouts";

const fixture = vi.hoisted(() => ({
  harnessPackage: {
    kind: "agent-runtime" as const,
    id: "hermes",
    packageVersion: "1.0.0-test",
    contentDigest: "b".repeat(64),
  },
}));

const mocks = vi.hoisted(() => ({
  backupWithAuthority: vi.fn(),
  captureOpenshell: vi.fn(() => ({ status: 0, output: "alpha Ready\n" })),
  findBackup: vi.fn(),
  getBaselineExclusions: vi.fn(),
}));

vi.mock("../../adapters/openshell/runtime", () => ({
  captureOpenshell: mocks.captureOpenshell,
  getOpenshellBinary: vi.fn(() => "openshell"),
  runOpenshell: vi.fn(),
}));

vi.mock("../../runtime-recovery", () => ({
  parseLiveSandboxNames: vi.fn(() => new Set(["alpha"])),
}));

vi.mock("../../shields", () => ({
  isShieldsDown: vi.fn(() => true),
}));

vi.mock("../../shields/timer-bound-lock", () => ({
  withTimerBoundShieldsMutationLock: vi.fn(
    (_sandboxName: string, _command: string, operation: () => unknown) => operation(),
  ),
}));

vi.mock("../../state/mcp-lifecycle-lock", () => ({
  withSandboxMutationLock: vi.fn((_sandboxName: string, operation: () => Promise<unknown>) =>
    operation(),
  ),
}));

vi.mock("../../state/registry", () => ({
  getBaselineExclusions: mocks.getBaselineExclusions,
  getSandbox: vi.fn(() => ({
    name: "alpha",
    agent: "hermes",
    harnessPackage: fixture.harnessPackage,
  })),
}));

vi.mock("../../state/sandbox", () => ({
  findBackup: mocks.findBackup,
}));

vi.mock("./snapshot/dependencies", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./snapshot/dependencies")>()),
  backupSandboxStateWithManagedAuthority: mocks.backupWithAuthority,
}));

vi.mock("./sandbox-gateway-routing", () => ({
  probeGatewayRunning: vi.fn(() => true),
  selectSandboxGatewayIfRegistered: vi.fn(() => true),
  usesGatewayMetadataProbe: vi.fn(() => false),
}));

describe("snapshot baseline exclusion output", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const manifest = {
      timestamp: "2026-06-15T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
    };
    mocks.backupWithAuthority.mockReturnValue({
      success: true,
      backedUpDirs: ["workspace"],
      backedUpFiles: ["openclaw.json"],
      failedDirs: [],
      failedFiles: [],
      manifest,
    });
    mocks.findBackup.mockReturnValue({ match: { ...manifest, snapshotVersion: 7 } });
    mocks.getBaselineExclusions.mockReturnValue([{ key: "nous_research", digest: "a".repeat(64) }]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "reports active exclusions and support impact after a successful snapshot (#7178)",
    testTimeoutOptions(10_000),
    async () => {
      const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
      const { runSandboxSnapshot } = await import("./snapshot");

      await runSandboxSnapshot("alpha", { kind: "create" });

      const output = consoleLog.mock.calls.flat().join("\n");
      expect(output).toContain("Active baseline exclusions: nous_research");
      expect(output).toContain(
        "Support impact: Excluded egress leaves dependent agent features unsupported for this sandbox.",
      );
    },
  );
});
