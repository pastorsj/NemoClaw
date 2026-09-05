// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { HarnessSessionAdapterModule } from "@nvidia/nemoclaw-harness-contract";

import { loadPackageHostModule } from "../helpers/host-module";

const adapter = loadPackageHostModule<HarnessSessionAdapterModule>("session-adapter.cts");
const HIDDEN_PREFIX = "nemoclaw-onboard-warmup-";

function interpret(output: string, jsonOutput: boolean) {
  return adapter.interpretSessionListOutput({
    output,
    jsonOutput,
    hiddenSessionIdPrefix: HIDDEN_PREFIX,
  });
}

describe("OpenClaw session adapter", () => {
  it("builds the native parent and explicit list command forms", () => {
    expect(adapter.buildSessionListPlan({ arguments: [], useListSubcommand: false })).toEqual({
      kind: "capture",
      command: ["openclaw", "sessions"],
    });
    expect(
      adapter.buildSessionListPlan({
        arguments: ["--agent", "main", "--limit", "4"],
        useListSubcommand: true,
      }),
    ).toEqual({
      kind: "capture",
      command: ["openclaw", "sessions", "list", "--agent", "main", "--limit", "4"],
    });
  });

  it("filters internal sessions from each recognized JSON array and adjusts counts", () => {
    const result = interpret(
      JSON.stringify({
        count: 2,
        totalCount: 2,
        sessions: [{ key: "agent:main:real", sessionId: "sid-real" }],
        entries: [{ key: "agent:main:warm", sessionId: `${HIDDEN_PREFIX}1` }],
      }),
      true,
    );

    expect(result.kind).toBe("output");
    expect(JSON.parse(result.kind === "output" ? result.output : "null")).toEqual({
      count: 1,
      totalCount: 1,
      sessions: [{ key: "agent:main:real", sessionId: "sid-real" }],
      entries: [],
    });
  });

  it("finds pretty JSON between native warning lines", () => {
    const result = interpret(
      [
        "Node warning before payload",
        JSON.stringify(
          {
            sessions: [{ key: "agent:main:warm", id: `${HIDDEN_PREFIX}1` }],
            count: 1,
          },
          null,
          2,
        ),
        "Node warning after payload",
      ].join("\n"),
      true,
    );

    expect(result.kind).toBe("output");
    expect(JSON.parse(result.kind === "output" ? result.output : "null")).toEqual({
      sessions: [],
      count: 0,
    });
  });

  it("filters only text rows whose session-id field carries the internal prefix", () => {
    const result = interpret(
      [
        "Sessions listed: 3",
        "direct  agent:main:real  id:sid-real",
        `direct  agent:main:warm  sessionId:${HIDDEN_PREFIX}one`,
        `direct  agent:main:note  note:${HIDDEN_PREFIX}mentioned`,
        "",
      ].join("\n"),
      false,
    );

    expect(result).toEqual({
      kind: "output",
      output: [
        "Sessions listed: 2",
        "direct  agent:main:real  id:sid-real",
        `direct  agent:main:note  note:${HIDDEN_PREFIX}mentioned`,
        "",
      ].join("\n"),
    });
  });

  it("refuses unknown JSON that could expose an internal session", () => {
    expect(
      interpret(JSON.stringify({ records: [{ sid: `${HIDDEN_PREFIX}1` }] }), true),
    ).toMatchObject({ kind: "refused", reason: expect.stringContaining("Could not parse") });
  });

  it("preserves unknown JSON when it contains no internal session identifier", () => {
    const output = JSON.stringify({ records: [{ sid: "sid-real" }] });
    expect(interpret(output, true)).toEqual({ kind: "output", output });
  });
});
