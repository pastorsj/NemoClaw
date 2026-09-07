// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncReturns } from "node:child_process";

import type { HarnessManagedExtensionsDeclaration } from "@nvidia/nemoclaw-harness-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));

import { discoverManagedImageExtensions } from "./snapshot/managed-extensions.js";

const DECLARATION = {
  support: "managed",
  controller: { command: ["/opt/future/state-controller"], timeout_seconds: 17 },
  state_directory: "addons",
  preserved_directories: [],
  allowed_symlinks: [],
} as const satisfies Extract<HarnessManagedExtensionsDeclaration, { readonly support: "managed" }>;

function spawnResult(stdout: Buffer): SpawnSyncReturns<Buffer> {
  return {
    pid: 123,
    output: [null, stdout, Buffer.alloc(0)],
    stdout,
    stderr: Buffer.alloc(0),
    status: 0,
    signal: null,
  };
}

describe("managed-extension controller execution", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it("rejects controller output beyond the core-owned byte limit", () => {
    spawnSyncMock.mockReturnValue(spawnResult(Buffer.alloc(1024 * 1024 + 1, 0x20)));

    expect(
      discoverManagedImageExtensions("future", DECLARATION, {
        getSshConfig: () => "Host future\n  HostName 127.0.0.1\n",
        sshArgs: (configFile, sandboxName) => ["-F", configFile, sandboxName],
      }),
    ).toEqual({ ok: false, error: "managed-extension inspection response is too large" });
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "ssh",
      expect.arrayContaining([
        "future",
        "'/opt/future/state-controller' 'inspect-managed-extensions'",
      ]),
      expect.objectContaining({ maxBuffer: 1024 * 1024, timeout: 17_000 }),
    );
  });

  it("fails closed before execution for a mutable package controller", () => {
    expect(
      discoverManagedImageExtensions(
        "future",
        {
          ...DECLARATION,
          controller: { ...DECLARATION.controller, command: ["/sandbox/state-controller"] },
        },
        {
          getSshConfig: () => "Host future\n  HostName 127.0.0.1\n",
          sshArgs: (configFile, sandboxName) => ["-F", configFile, sandboxName],
        },
      ),
    ).toEqual({
      ok: false,
      error: "managed-extension controller command is not stored in the immutable image",
    });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});
