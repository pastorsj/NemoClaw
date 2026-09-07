// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../../../state/registry";
import {
  observePackageSessionQualification,
  PackageSessionQualificationError,
} from "./package-session";

const NONCE = "a".repeat(64);
const STATE_DIGEST = "b".repeat(64);

function packageEntry(packageId = "future-harness"): SandboxEntry {
  return {
    name: "future-sandbox",
    agent: packageId,
    harnessPackage: {
      kind: "agent-runtime",
      id: packageId,
      packageVersion: "1.0.0",
      contentDigest: "c".repeat(64),
    },
  };
}

describe("receipt-backed package session qualification", () => {
  it("executes an unknown package's declared observation without native dispatch", () => {
    const command = ["/usr/local/bin/future-session-qualify"] as const;
    const executeCommand = vi.fn(() => ({
      status: 0,
      signal: null,
      stdout: Buffer.from(`__NEMOCLAW_SESSION_QUALIFIED__=${NONCE}:${STATE_DIGEST}\n`),
      stderr: Buffer.alloc(0),
    }));
    const entry = packageEntry();

    expect(
      observePackageSessionQualification(
        "future-sandbox",
        "future-harness",
        { command, timeout_seconds: 45 },
        { uid: 1234, gid: 1235 },
        {
          createNonce: () => NONCE,
          executeCommand,
          getSandbox: () => entry,
          resolveTarget: () => ({ providerId: "docker", resourceHandle: "container-123" }),
        },
      ),
    ).toEqual({
      schemaVersion: 1,
      kind: "package-session",
      packageId: "future-harness",
      stateSha256: STATE_DIGEST,
    });
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith("future-sandbox", [...command, NONCE], {
      executionUser: { uid: 1234, gid: 1235 },
      expectedResourceHandle: "container-123",
      maxOutputBytes: 16 * 1024,
      sanitizeEnvironment: true,
      timeout: 45_000,
    });
  });

  it.each([
    ["the receipt changes", packageEntry("other-harness")],
    ["the receipt disappears", null],
  ])("fails closed before execution when %s", (_case, entry) => {
    const executeCommand = vi.fn();
    expect(() =>
      observePackageSessionQualification(
        "future-sandbox",
        "future-harness",
        { command: ["/usr/local/bin/future-session-qualify"], timeout_seconds: 45 },
        { uid: 1234, gid: 1235 },
        {
          createNonce: () => NONCE,
          executeCommand,
          getSandbox: () => entry,
          resolveTarget: () => ({ providerId: "docker", resourceHandle: "container-123" }),
        },
      ),
    ).toThrow(PackageSessionQualificationError);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("rejects ambiguous or unstructured package output", () => {
    const entry = packageEntry();
    expect(() =>
      observePackageSessionQualification(
        "future-sandbox",
        "future-harness",
        { command: ["/usr/local/bin/future-session-qualify"], timeout_seconds: 45 },
        { uid: 1234, gid: 1235 },
        {
          createNonce: () => NONCE,
          executeCommand: () => ({
            status: 0,
            signal: null,
            stdout: Buffer.from(
              `__NEMOCLAW_SESSION_QUALIFIED__=${NONCE}:${STATE_DIGEST}\n` +
                `__NEMOCLAW_SESSION_QUALIFIED__=${NONCE}:${STATE_DIGEST}\n`,
            ),
            stderr: Buffer.alloc(0),
          }),
          getSandbox: () => entry,
          resolveTarget: () => ({ providerId: "docker", resourceHandle: "container-123" }),
        },
      ),
    ).toThrow(PackageSessionQualificationError);
  });
});
