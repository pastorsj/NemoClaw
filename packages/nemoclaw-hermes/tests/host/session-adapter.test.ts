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
});
