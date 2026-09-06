// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { settlePackageDevicePairing } from "./device-pairing";

const NONCE = "a".repeat(64);

describe("receipt-backed package device pairing", () => {
  it("executes an unknown package's declared command without package-id dispatch", async () => {
    const command = ["/usr/local/bin/future-pairing-settle"] as const;
    const executeCommand = vi.fn(() => ({
      status: 0,
      signal: null,
      stdout: Buffer.from(`__NEMOCLAW_DEVICE_PAIRING_SETTLED__=${NONCE}\n`),
      stderr: Buffer.alloc(0),
    }));
    const sandbox = {
      agent: "future-harness",
      gatewayName: "future-gateway",
      harnessPackage: { id: "future-harness" },
    };

    await expect(
      settlePackageDevicePairing(
        "future-sandbox",
        "future-harness",
        { command, timeout_seconds: 45 },
        { uid: 1234, gid: 1234 },
        {
          getSandbox: () => sandbox,
          createNonce: () => NONCE,
          resolveTarget: () => ({ providerId: "docker", resourceHandle: "container-123" }),
          executeCommand,
          withSandboxLock: async (_name, operation) => operation(),
          withGatewayLock: async (_name, operation) => operation(),
        },
      ),
    ).resolves.toEqual({ kind: "settled" });
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith("future-sandbox", [...command, NONCE], {
      sanitizeEnvironment: true,
      executionUser: { uid: 1234, gid: 1234 },
      expectedResourceHandle: "container-123",
      timeout: 45_000,
      maxOutputBytes: 16 * 1024,
    });
  });

  it("refuses a declared command when the receipt package identity changed", async () => {
    const executeCommand = vi.fn();

    await expect(
      settlePackageDevicePairing(
        "future-sandbox",
        "future-harness",
        {
          command: ["/usr/local/bin/future-pairing-settle"],
          timeout_seconds: 45,
        },
        { uid: 1234, gid: 1234 },
        {
          getSandbox: () => ({
            agent: "other-harness",
            gatewayName: "future-gateway",
            harnessPackage: { id: "other-harness" },
          }),
          createNonce: () => NONCE,
          resolveTarget: () => ({ providerId: "docker", resourceHandle: "container-123" }),
          executeCommand,
          withSandboxLock: async (_name, operation) => operation(),
          withGatewayLock: async (_name, operation) => operation(),
        },
      ),
    ).resolves.toEqual({ kind: "incomplete", reason: "package-authority-invalid" });
    expect(executeCommand).not.toHaveBeenCalled();
  });
});
