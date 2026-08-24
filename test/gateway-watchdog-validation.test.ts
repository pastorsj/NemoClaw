// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";
import { readOpenClawStartupSource } from "./support/openclaw-startup";

function requireNonNegative(value: number, message: string): number {
  return value >= 0
    ? value
    : (() => {
        throw new Error(message);
      })();
}

function extractShellFunction(source: string, name: string): string {
  const startMarker = `${name}() {`;
  const start = requireNonNegative(
    source.indexOf(startMarker),
    `function ${name} not found in the OpenClaw startup workflow`,
  );
  const lines = source.slice(start).split("\n");
  const endIndex = requireNonNegative(
    lines.findIndex((line, index) => index > 0 && line === "}"),
    `function ${name} missing a closing brace in the OpenClaw startup workflow`,
  );
  return lines.slice(0, endIndex + 1).join("\n");
}

function runGuard(value: string): number {
  const functionBody = extractShellFunction(
    readOpenClawStartupSource(),
    "gateway_watchdog_positive_int_ok",
  );
  const harness = `
${functionBody}
gateway_watchdog_positive_int_ok "$1"
`;
  const result = spawnSync("bash", ["-c", harness, "bash", value], {
    encoding: "utf-8",
    timeout: 10_000,
  });
  return result.status ?? -1;
}

describe("gateway watchdog numeric env guard", () => {
  it.each([
    ["1", 0],
    ["12", 0],
    ["30", 0],
    ["999", 0],
    ["999999999", 0],
  ])("accepts positive integer %s", (input, expected) => {
    expect(runGuard(input)).toBe(expected);
  });

  it.each([
    ["", 1],
    ["0", 1],
    ["00", 1],
    ["12x", 1],
    ["30abc", 1],
    ["-5", 1],
    [" 5 ", 1],
    ["5.0", 1],
    ["one", 1],
    // Over-long decimals overflow Bash arithmetic to a negative value, which
    // would make every threshold comparison false and kill the gateway on its
    // first not-serving probe.
    ["1000000000", 1],
    ["9223372036854775808", 1],
    ["999999999999999999999999999999999999", 1],
  ])("rejects non-positive-integer %j", (input, expected) => {
    expect(runGuard(input)).toBe(expected);
  });
});
