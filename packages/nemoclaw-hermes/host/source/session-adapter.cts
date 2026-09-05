// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessSessionAdapterModule,
  HarnessSessionListOutput,
  HarnessSessionListOutputRequest,
  HarnessSessionListPlan,
  HarnessSessionListPlanRequest,
} from "@nvidia/nemoclaw-harness-contract";

function buildSessionListPlan(request: HarnessSessionListPlanRequest): HarnessSessionListPlan {
  return {
    kind: "stream",
    command: ["hermes", "sessions", "list", ...request.arguments],
  };
}

function interpretSessionListOutput(
  request: HarnessSessionListOutputRequest,
): HarnessSessionListOutput {
  return { kind: "output", output: request.output };
}

const sessionAdapter: HarnessSessionAdapterModule = {
  buildSessionListPlan,
  interpretSessionListOutput,
};

export = sessionAdapter;
