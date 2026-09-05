// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";

import type { HarnessSessionAdapterModule } from "@nvidia/nemoclaw-harness-contract";

import { loadPackageHostModule } from "../helpers/host-module";

it("returns typed unsupported session listing for Deep Agents Code", () => {
  const adapter = loadPackageHostModule<HarnessSessionAdapterModule>("session-adapter.cts");
  expect(adapter.buildSessionListPlan({ arguments: [], useListSubcommand: true })).toMatchObject({
    kind: "unsupported",
    reason: expect.stringContaining("does not expose session listing"),
  });
});
