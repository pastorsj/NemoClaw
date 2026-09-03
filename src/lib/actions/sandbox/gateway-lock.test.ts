// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("Portable lifecycle locking", () => {
  it(
    "holds both non-default gateway state and host-global Portable receipt authority",
    { timeout: 15_000 },
    async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-lock-"));
      temporaryDirectories.push(home);
      vi.stubEnv("HOME", home);
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "18137");
      vi.stubEnv("NEMOCLAW_TEST_BASE_HOME", `${home}-not-the-private-home`);
      vi.stubEnv("NEMOCLAW_TEST_STATE_DIR", "");
      vi.resetModules();

      const gatewayState = await import("./gateway-state");
      const lifecycleLock = await import("../../state/mcp-lifecycle-lock-acquisition");
      const receipts = await import("../../onboard/experimental/hermes-portable-receipt");
      const sandboxName = "openclaw-restart";
      const gatewayStateDir = path.join(home, ".nemoclaw", "gateways", "18137", "state");
      const portableStateRoot = path.join(home, ".nemoclaw");
      const portableStateDir = path.join(home, ".nemoclaw", "state");

      await gatewayState.withPortableLifecycleLocks(sandboxName, () => {
        expect(lifecycleLock.isMcpLifecycleLockHeld(sandboxName, gatewayStateDir)).toBe(true);
        expect(lifecycleLock.isMcpLifecycleLockHeld(sandboxName, portableStateDir)).toBe(true);
        expect(
          receipts.inspectPortableAgentReceiptAuthorityForRequalification(
            sandboxName,
            portableStateRoot,
          ),
        ).toEqual({ kind: "none" });
      });

      expect(lifecycleLock.isMcpLifecycleLockHeld(sandboxName, gatewayStateDir)).toBe(false);
      expect(lifecycleLock.isMcpLifecycleLockHeld(sandboxName, portableStateDir)).toBe(false);
    },
  );

  it("re-enters one lock when the default gateway and Portable state share a root", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-lock-"));
    temporaryDirectories.push(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "8080");
    vi.stubEnv("NEMOCLAW_TEST_BASE_HOME", `${home}-not-the-private-home`);
    vi.stubEnv("NEMOCLAW_TEST_STATE_DIR", "");
    vi.resetModules();

    const gatewayState = await import("./gateway-state");
    const lifecycleLock = await import("../../state/mcp-lifecycle-lock-acquisition");
    const sandboxName = "openclaw-restart";
    const sharedStateDir = path.join(home, ".nemoclaw", "state");

    await gatewayState.withPortableLifecycleLocks(sandboxName, () => {
      expect(lifecycleLock.isMcpLifecycleLockHeld(sandboxName, sharedStateDir)).toBe(true);
    });

    expect(lifecycleLock.isMcpLifecycleLockHeld(sandboxName, sharedStateDir)).toBe(false);
  });
});
