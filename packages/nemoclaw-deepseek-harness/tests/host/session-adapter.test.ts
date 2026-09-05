// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";

import type { HarnessSessionAdapterModule } from "@nvidia/nemoclaw-harness-contract";

import { loadPackageHostModule } from "../helpers/host-module";

it("returns typed unsupported session listing for DeepSeek Harness", () => {
  const adapter = loadPackageHostModule<HarnessSessionAdapterModule>("session-adapter.cts");
  expect(adapter.buildSessionListPlan({ arguments: [], useListSubcommand: true })).toMatchObject({
    kind: "unsupported",
    reason: expect.stringContaining("does not expose session listing"),
  });
  expect(
    adapter.buildSessionMutationPlan({
      operation: "delete",
      key: "session",
      agent: null,
      keepTranscript: false,
      jsonOutput: false,
      verboseOutput: false,
    }),
  ).toMatchObject({ kind: "unsupported", reason: expect.stringContaining("delete") });
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
  ).toMatchObject({ kind: "unsupported", reason: expect.stringContaining("export") });
});
