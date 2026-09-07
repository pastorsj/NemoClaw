// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { AgentDefinition } from "../../agent/defs";
import {
  buildBackupQuiescencePlan,
  executeReceiptBackedStateCommand,
  inspectReceiptBackedBackupQuiescence,
  packageRequestsSnapshotRestoreAction,
  receiptBackedPackageRequestsSnapshotRestoreAction,
} from "./state-lifecycle";

const RECEIPT = Object.freeze({
  kind: "agent-runtime" as const,
  id: "future-harness",
  packageVersion: "7.8.9",
  contentDigest: "a".repeat(64),
});

function futureHarness(
  backupQuiescence: AgentDefinition["stateLifecycle"]["backup_quiescence"],
  options: {
    readonly rebuild?: AgentDefinition["stateLifecycle"]["rebuild"];
    readonly snapshotRestore?: AgentDefinition["stateLifecycle"]["snapshot_restore"];
  } = {},
): AgentDefinition {
  return {
    name: RECEIPT.id,
    managedImage: {
      runtime_identity: { uid: 1234, gid: 1235, workdir: "/sandbox" },
    },
    stateLifecycle: {
      backup_quiescence: backupQuiescence,
      snapshot_restore: options.snapshotRestore ?? [],
      rebuild: options.rebuild ?? {
        managed_extensions: {
          support: "disabled",
          reason: "Test package has no managed extensions.",
        },
        scheduled_work: { support: "disabled", reason: "No scheduled work." },
        post_restore: { kind: "not-required" },
      },
    },
  } as AgentDefinition;
}

function commandResult(status: number, stderr = "") {
  return {
    status,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.from(stderr),
  };
}

describe("receipt-backed state lifecycle", () => {
  it("accepts an unknown package's explicit no-quiescence declaration without execution", () => {
    const executeCommand = vi.fn(() => commandResult(0));
    const result = inspectReceiptBackedBackupQuiescence(
      "future-box",
      { agent: RECEIPT.id, harnessPackage: RECEIPT },
      futureHarness({ kind: "not-required" }),
      { executeCommand },
    );

    expect(result).toEqual({ kind: "ready" });
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("executes an unknown package's bounded capture command under core authority", () => {
    const executeCommand = vi.fn(() => commandResult(0));
    const result = inspectReceiptBackedBackupQuiescence(
      "future-box",
      { agent: RECEIPT.id, harnessPackage: RECEIPT },
      futureHarness({
        kind: "command",
        command: ["/usr/local/lib/nemoclaw/future-state-ready", "--capture"],
        timeout_seconds: 19,
      }),
      { executeCommand },
    );

    expect(result).toEqual({ kind: "ready" });
    expect(executeCommand).toHaveBeenCalledWith(
      "future-box",
      ["/usr/local/lib/nemoclaw/future-state-ready", "--capture"],
      {
        sanitizeEnvironment: true,
        timeout: 19_000,
        maxOutputBytes: 64 * 1024,
      },
    );
  });

  it("maps the package's reserved busy status without exposing native output", () => {
    const executeCommand = vi.fn(() => commandResult(75, "package-specific busy detail"));

    expect(
      inspectReceiptBackedBackupQuiescence(
        "future-box",
        { agent: RECEIPT.id, harnessPackage: RECEIPT },
        futureHarness({
          kind: "command",
          command: ["/usr/local/lib/nemoclaw/future-state-ready"],
          timeout_seconds: 10,
        }),
        { executeCommand },
      ),
    ).toEqual({ kind: "busy" });
  });

  it("fails closed before privileged execution for a mutable backup command", () => {
    const executeCommand = vi.fn(() => commandResult(0));

    expect(
      inspectReceiptBackedBackupQuiescence(
        "future-box",
        { agent: RECEIPT.id, harnessPackage: RECEIPT },
        futureHarness({
          kind: "command",
          command: ["/sandbox/state-ready"],
          timeout_seconds: 10,
        }),
        { executeCommand },
      ),
    ).toEqual({
      kind: "unverified",
      detail: "the package backup quiescence command is not stored in the immutable image",
    });
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("fails closed before execution when exact receipt authority is unavailable", () => {
    const executeCommand = vi.fn(() => commandResult(0));
    const agent = futureHarness({ kind: "not-required" });

    expect(
      inspectReceiptBackedBackupQuiescence(
        "future-box",
        { agent: "different-harness", harnessPackage: RECEIPT },
        agent,
        { executeCommand },
      ),
    ).toEqual({
      kind: "unverified",
      detail: "the exact package state lifecycle declaration is unavailable",
    });
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("returns the explicit legacy plan only when no package receipt exists", () => {
    expect(
      buildBackupQuiescencePlan(
        { agent: "future-harness", harnessPackage: null },
        futureHarness({ kind: "not-required" }),
      ),
    ).toEqual({ kind: "legacy" });
  });

  it("selects a finite snapshot action only for matching receipt-backed package authority", () => {
    const declaration = futureHarness(
      { kind: "not-required" },
      { snapshotRestore: ["restart-runtime"] },
    );

    expect(
      receiptBackedPackageRequestsSnapshotRestoreAction(
        { agent: RECEIPT.id, harnessPackage: RECEIPT },
        declaration,
        "restart-runtime",
      ),
    ).toBe(true);
    expect(
      receiptBackedPackageRequestsSnapshotRestoreAction(
        { agent: "different-harness", harnessPackage: RECEIPT },
        declaration,
        "restart-runtime",
      ),
    ).toBe(false);
    expect(
      receiptBackedPackageRequestsSnapshotRestoreAction(
        { agent: RECEIPT.id, harnessPackage: null },
        declaration,
        "restart-runtime",
      ),
    ).toBe(false);
  });

  it("executes an unknown package's fixed state command with its receipt-pinned identity", () => {
    const executeCommand = vi.fn(() => commandResult(0));
    const resolveTarget = vi.fn(() => ({ resourceHandle: "future-resource" }) as never);
    const declaration = futureHarness(
      { kind: "not-required" },
      {
        snapshotRestore: ["repair-mutable-config"],
      },
    );

    const result = executeReceiptBackedStateCommand(
      "future-box",
      { agent: RECEIPT.id, harnessPackage: RECEIPT },
      declaration,
      { command: ["/opt/future/restore-state", "--repair"], timeout_seconds: 23 },
      {
        executeCommand,
        resolveTarget,
        withExecutionLease: (_sandboxName, _operation, run) => run(),
      },
    );

    expect(result).toEqual({ kind: "completed" });
    expect(
      packageRequestsSnapshotRestoreAction(declaration.stateLifecycle, "repair-mutable-config"),
    ).toBe(true);
    expect(executeCommand).toHaveBeenCalledWith(
      "future-box",
      ["/opt/future/restore-state", "--repair"],
      {
        sanitizeEnvironment: true,
        executionUser: { uid: 1234, gid: 1235 },
        expectedResourceHandle: "future-resource",
        timeout: 23_000,
        maxOutputBytes: 64 * 1024,
      },
    );
  });
});
