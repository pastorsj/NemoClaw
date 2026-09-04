// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { HarnessConfigCommand } from "../agent-runtime/config-module";
import { validatePackageConfigCommandResult } from "./config-command";

const CONTENT = '{"ready":true}\n';
const TRANSACTION: HarnessConfigCommand = {
  command: ["future-config", "write"],
  timeoutSeconds: 30,
  failureMessage: "Future config write failed",
  success: {
    kind: "config-transaction",
    action: "write-config",
    configDirectory: "/sandbox/.future",
    protectedFiles: ["config.json", ".config-hash"],
  },
};

function successfulResult(overrides: Record<string, unknown> = {}) {
  return {
    status: 0,
    signal: null,
    stdout: `${JSON.stringify({
      type: "result",
      action: "write-config",
      status: "ok",
      configDir: "/sandbox/.future",
      files: ["config.json", ".config-hash"],
      configSha256: createHash("sha256").update(CONTENT).digest("hex"),
      ...overrides,
    })}\n`,
    stderr: "",
  };
}

describe("package configuration command result", () => {
  it("accepts exit zero only when the process completed normally", () => {
    const command: HarnessConfigCommand = {
      ...TRANSACTION,
      success: { kind: "exit-zero" },
    };

    expect(validatePackageConfigCommandResult(command, CONTENT, successfulResult())).toBe(true);
    expect(
      validatePackageConfigCommandResult(command, CONTENT, {
        ...successfulResult(),
        status: 1,
      }),
    ).toBe(false);
  });

  it("accepts an exact structured transaction proof", () => {
    expect(validatePackageConfigCommandResult(TRANSACTION, CONTENT, successfulResult())).toBe(true);
  });

  it.each([
    ["digest", { configSha256: "a".repeat(64) }],
    ["directory", { configDir: "/sandbox/.other" }],
    ["protected files", { files: ["config.json"] }],
    ["action", { action: "other-action" }],
    ["status", { status: "failed" }],
  ])("rejects a mismatched %s claim", (_label, override) => {
    expect(
      validatePackageConfigCommandResult(TRANSACTION, CONTENT, successfulResult(override)),
    ).toBe(false);
  });

  it("rejects malformed, repeated, or stderr-bearing transaction output", () => {
    expect(
      validatePackageConfigCommandResult(TRANSACTION, CONTENT, {
        ...successfulResult(),
        stdout: "not-json\n",
      }),
    ).toBe(false);
    expect(
      validatePackageConfigCommandResult(TRANSACTION, CONTENT, {
        ...successfulResult(),
        stdout: `${successfulResult().stdout}${successfulResult().stdout}`,
      }),
    ).toBe(false);
    expect(
      validatePackageConfigCommandResult(TRANSACTION, CONTENT, {
        ...successfulResult(),
        stderr: "unexpected",
      }),
    ).toBe(false);
  });
});
