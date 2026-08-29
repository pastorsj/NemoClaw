// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as f from "./snapshot-restore-test-fixture";

const OPENCLAW_PACKAGE = {
  kind: "agent-runtime" as const,
  id: "openclaw",
  packageVersion: "1.2.3",
  contractVersion: 1 as const,
  contentDigest: "a".repeat(64),
};

const offlineSourceEntry: {
  name: string;
  agent: string;
  harnessPackage: typeof OPENCLAW_PACKAGE;
  imageTag: string | null;
  openshellDriver: string;
  provider: string | null;
  model: string | null;
} = {
  name: "alpha",
  agent: "openclaw",
  harnessPackage: OPENCLAW_PACKAGE,
  imageTag: "nemoclaw-alpha:test",
  openshellDriver: "docker",
  provider: "nvidia-nim",
  model: "nvidia/model-a",
};

function stubOfflineSource(entry: typeof offlineSourceEntry): void {
  f.modelPendingCloneRegistry((name) => (name === "alpha" ? entry : null));
  f.parseLiveSandboxNamesMock.mockReturnValue(new Set<string>());
  f.captureOpenshellMock.mockImplementation((args) =>
    f.openshellResponses(args, {
      "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
      "sandbox list": { status: 0, output: "beta Ready\n" },
    }),
  );
  f.getLatestBackupMock.mockReturnValue({
    ...f.latestBackupFixture,
    version: 2,
    backupComplete: true,
    harnessPackage: OPENCLAW_PACKAGE,
  });
}

beforeEach(() => {
  f.resetSnapshotRestoreMocks();
});
afterEach(() => {
  f.cleanupSnapshotRestoreMocks();
});

describe("runSandboxSnapshot restore: source sandbox no longer running", () => {
  it("restores into a replacement sandbox built from the registered source image", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    stubOfflineSource(offlineSourceEntry);
    f.restoreSandboxStateMock.mockImplementation((_name, _path, options) => {
      options?.validateBeforeMutation?.();
      return {
        success: true,
        restoredDirs: ["workspace"],
        restoredFiles: ["user.md"],
        failedDirs: [],
        failedFiles: [],
      };
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore", to: "beta", yes: true });

    expect(f.streamSandboxCreateMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["--name", "beta", "--from", "nemoclaw-alpha:test"]),
      expect.any(Object),
      expect.any(Object),
    );
    expect(f.restoreSandboxStateMock).toHaveBeenCalledWith(
      "beta",
      "/tmp/backup-alpha",
      expect.objectContaining({
        authority: expect.objectContaining({ backupPath: "/tmp/backup-alpha" }),
        validateBeforeMutation: expect.any(Function),
      }),
    );
  });

  it("stops before creating a replacement when the source records no image", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    stubOfflineSource({ ...offlineSourceEntry, imageTag: null });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta", yes: true }),
    ).rejects.toMatchObject({ exitCode: 1 });

    const errors = consoleError.mock.calls.flat().join("\n");
    expect(errors).toContain(
      "source 'alpha' is not running and its registry entry records no image",
    );
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
  });

  it("stops before creating a replacement when the source inference route is incomplete", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    stubOfflineSource({ ...offlineSourceEntry, model: null });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta", yes: true }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "source 'alpha' has no complete durable inference route",
    );
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
  });
});
