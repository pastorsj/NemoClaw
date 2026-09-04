// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  HarnessConfigRestoreHostModule,
  HarnessConfigRestoreResult,
} from "../../agent-runtime/config-module";
import { HarnessConfigModuleError } from "../../agent-runtime/config-module";
import type { StateFilePackageConfigRestoreOwnership } from "../../agent-runtime/manifest-types";
import { type PackageConfigRestoreContext, restoreStateFile } from "../state-file-restore";

interface SpawnSyncResult {
  readonly status: number | null;
  readonly error?: Error;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

type SpawnSyncCall = (
  command: string,
  args: readonly string[],
  options: { readonly input?: Buffer },
) => SpawnSyncResult;

const spawnSyncMock = vi.hoisted(() =>
  vi.fn<SpawnSyncCall>(() => ({
    status: 0,
    signal: null,
    stdout: Buffer.from('{"fresh":true}'),
    stderr: Buffer.alloc(0),
  })),
);
const listManagedChannelNamesMock = vi.hoisted(() =>
  vi.fn((_agentName: string) => ["managed-channel"]),
);

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));
vi.mock("./managed-channels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./managed-channels")>()),
  listManagedChannelNames: listManagedChannelNamesMock,
}));

const OWNERSHIP: StateFilePackageConfigRestoreOwnership = { merge: "package-config" };
const SPEC = { path: "config.json", strategy: "copy" } as const;
const SSH_ARGS = ["-F", "/tmp/ssh-config", "openshell-alpha"] as const;

function contextFor(result: HarnessConfigRestoreResult): PackageConfigRestoreContext {
  const adapter: HarnessConfigRestoreHostModule = {
    mergeConfigState: vi.fn(() => result),
  };
  return { agentName: "future-harness", adapter };
}

function restoreWithContext(
  context: PackageConfigRestoreContext,
  log = vi.fn<(message: string) => void>(),
): { readonly log: typeof log; readonly restored: boolean } {
  const restored = restoreStateFile(
    SSH_ARGS,
    "/sandbox/.future",
    SPEC,
    Buffer.from('{"backup":true}'),
    OWNERSHIP,
    false,
    log,
    undefined,
    undefined,
    undefined,
    context,
  );
  return { log, restored };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("package configuration state restore", () => {
  it("derives managed channel names from the package agent identity", () => {
    const mergeConfigState = vi.fn((): HarnessConfigRestoreResult => ({
      kind: "merged",
      content: '{"merged":true}\n',
      write: { kind: "atomic" },
    }));

    const { restored } = restoreWithContext({
      agentName: "future-harness",
      adapter: { mergeConfigState },
    });

    expect(restored).toBe(true);
    expect(listManagedChannelNamesMock).toHaveBeenCalledWith("future-harness");
    expect(mergeConfigState).toHaveBeenCalledWith(
      expect.objectContaining({ managedChannelNames: ["managed-channel"] }),
    );
  });

  it("uses the generic atomic write plan without recovery anchors", () => {
    const merged = '{"merged":true}\n';
    const { restored } = restoreWithContext(
      contextFor({ kind: "merged", content: merged, write: { kind: "atomic" } }),
    );

    expect(restored).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
    const [, writeArgs, writeOptions] = spawnSyncMock.mock.calls[1] ?? [];
    const writeCommand = String(writeArgs?.at(-1));
    expect(writeCommand).toContain('chmod 640 "$tmp"');
    expect(writeCommand).not.toContain(".last-good");
    expect(writeCommand).not.toContain(".config-hash");
    expect(writeOptions?.input).toEqual(Buffer.from(merged));
  });

  it("uses the bounded config-anchor plan for protected configuration", () => {
    const { restored } = restoreWithContext(
      contextFor({
        kind: "merged",
        content: '{"merged":true}\n',
        write: { kind: "config-anchors", hashFiles: ["config.json", "fabric.json"] },
      }),
    );

    expect(restored).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
    const [, writeArgs] = spawnSyncMock.mock.calls[1] ?? [];
    const writeCommand = String(writeArgs?.at(-1));
    expect(writeCommand).toContain('chmod 660 "$tmp"');
    expect(writeCommand).toContain(".last-good");
    expect(writeCommand).toContain(".config-hash");
    expect(writeCommand).toContain("fabric.json");
  });

  it.each([
    ["adapter execution", new Error("credential-value-must-not-leak")],
    [
      "result schema validation",
      new HarnessConfigModuleError("schema detail credential-value-must-not-leak"),
    ],
    [
      "result size validation",
      new HarnessConfigModuleError("size detail credential-value-must-not-leak"),
    ],
  ])("fails without a write after %s fails", (_case, failure) => {
    const adapter: HarnessConfigRestoreHostModule = {
      mergeConfigState: vi.fn(() => {
        throw failure;
      }),
    };
    const { log, restored } = restoreWithContext({ agentName: "future-harness", adapter });

    expect(restored).toBe(false);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenLastCalledWith("FAILED: package configuration restore adapter failed");
    expect(log.mock.calls.flat().join("\n")).not.toContain("credential-value-must-not-leak");
  });

  it("refuses package configuration restore when its adapter is unavailable", () => {
    const log = vi.fn<(message: string) => void>();

    const restored = restoreStateFile(
      SSH_ARGS,
      "/sandbox/.future",
      SPEC,
      Buffer.from('{"backup":true}'),
      OWNERSHIP,
      false,
      log,
    );

    expect(restored).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenLastCalledWith(
      "FAILED: package configuration restore adapter is unavailable",
    );
  });
});
