// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import type { HarnessAgentCommandDeclaration } from "@nvidia/nemoclaw-harness-contract";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");

describe("OpenClaw agent command declaration", () => {
  it("owns the native selector, output, and timeout grammar", () => {
    const manifest = parse(fs.readFileSync(path.join(PACKAGE_ROOT, "manifest.yaml"), "utf8")) as {
      runtime?: { agent_command?: unknown };
    };
    const expected = {
      argv: ["openclaw", "agent"],
      output_mode: "bounded-text",
      selector_options: ["--agent", "--session-id", "--session-key", "--to"],
      selector_required: true,
      value_options: [
        "-a",
        "-m",
        "--message",
        "--model",
        "--provider",
        "--reply-channel",
        "--thinking",
        "--timeout",
      ],
      boolean_options: ["--deliver"],
      json_output_option: "--json",
      timeout_option: "--timeout",
    } satisfies HarnessAgentCommandDeclaration;

    expect(manifest.runtime?.agent_command).toEqual(expected);
  });
});
