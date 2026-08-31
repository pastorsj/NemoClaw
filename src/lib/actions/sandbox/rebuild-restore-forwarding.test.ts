// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentDefinition } from "../../agent-runtime/manifest-types";
import { runRebuildRestorePhase } from "./rebuild-restore-phase";
import * as snapshotRestore from "./snapshot/restore-authority";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rebuild restore target forwarding", () => {
  it("forwards the recreated target, custom-image capability, and live identity reader", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const restoreRecreatedSandboxState = vi
      .spyOn(snapshotRestore, "restoreRecreatedSandboxStateWithManagedAuthority")
      .mockReturnValue({
        success: true,
        restoredDirs: [],
        restoredFiles: [],
        failedDirs: [],
        failedFiles: [],
      });

    const agentDefinition = {
      name: "langchain-deepagents-code",
      packageRoot: "/selected/deepagents",
    } as AgentDefinition;

    runRebuildRestorePhase({
      sandboxName: "alpha",
      agentDefinition,
      targetImageIsCustom: true,
      backupManifest: { agentType: "openclaw", backupPath: "/tmp/rebuild-backup" } as never,
      reconcileManagedDcodeObservability: false,
      log: vi.fn(),
    });

    expect(restoreRecreatedSandboxState).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ backupPath: "/tmp/rebuild-backup" }),
      {
        targetAgentType: "langchain-deepagents-code",
        agentDefinition,
        allowCustomImageWholeStateFileRestore: true,
      },
      {
        getSandbox: expect.any(Function),
        captureOpenshell: expect.any(Function),
      },
    );
    expect(restoreRecreatedSandboxState.mock.calls[0]?.[2].agentDefinition).toBe(agentDefinition);
  });
});
