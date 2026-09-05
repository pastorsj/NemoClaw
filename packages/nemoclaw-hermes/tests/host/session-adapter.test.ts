// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { HarnessSessionAdapterModule } from "@nvidia/nemoclaw-harness-contract";

import { loadPackageHostModule } from "../helpers/host-module";

const adapter = loadPackageHostModule<HarnessSessionAdapterModule>("session-adapter.cts");

describe("Hermes session adapter", () => {
  it("streams the native list command with each forwarded argument", () => {
    expect(
      adapter.buildSessionListPlan({
        arguments: ["--limit", "5"],
        useListSubcommand: false,
      }),
    ).toEqual({ kind: "stream", command: ["hermes", "sessions", "list", "--limit", "5"] });
  });

  it("preserves native output if core requests interpretation", () => {
    expect(
      adapter.interpretSessionListOutput({
        output: "Hermes session output",
        jsonOutput: false,
        hiddenSessionIdPrefix: "nemoclaw-internal-",
      }),
    ).toEqual({ kind: "output", output: "Hermes session output" });
  });

  it("builds a native delete command and reports reset as unsupported", () => {
    expect(
      adapter.buildSessionMutationPlan({
        operation: "delete",
        key: "20260727_130357_cb2b61",
        agent: null,
        keepTranscript: false,
        jsonOutput: false,
        verboseOutput: false,
      }),
    ).toEqual({
      kind: "stream",
      command: ["hermes", "sessions", "delete", "20260727_130357_cb2b61", "--yes"],
    });
    expect(
      adapter.buildSessionMutationPlan({
        operation: "reset",
        key: "20260727_130357_cb2b61",
        agent: null,
        reason: "reset",
        jsonOutput: false,
        verboseOutput: false,
      }),
    ).toMatchObject({ kind: "unsupported", reason: expect.stringContaining("reset") });
  });

  it("builds a native full-store export to the core-selected staging file", () => {
    expect(
      adapter.buildSessionExportPlan({
        agent: null,
        keys: [],
        format: "dir",
        includeTrajectory: false,
        stagingFiles: {
          tar: "/sandbox/.nemoclaw-staging/export.tgz",
          jsonl: "/sandbox/.nemoclaw-staging/export.jsonl",
        },
      }),
    ).toEqual({
      kind: "native-file",
      agent: "hermes",
      format: "jsonl",
      selectedKeys: "all",
      remoteFile: "/sandbox/.nemoclaw-staging/export.jsonl",
      command: ["hermes", "sessions", "export", "/sandbox/.nemoclaw-staging/export.jsonl"],
      allowEmpty: true,
    });
  });

  it("refuses OpenClaw-only export selection before execution", () => {
    expect(
      adapter.buildSessionExportPlan({
        agent: null,
        keys: ["main"],
        format: "dir",
        includeTrajectory: false,
        stagingFiles: {
          tar: "/sandbox/.nemoclaw-staging/export.tgz",
          jsonl: "/sandbox/.nemoclaw-staging/export.jsonl",
        },
      }),
    ).toMatchObject({ kind: "refused", reason: expect.stringContaining("positional") });
  });
});
