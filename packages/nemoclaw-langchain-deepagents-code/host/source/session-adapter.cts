// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessSessionAdapterModule,
  HarnessSessionListOutput,
  HarnessSessionListOutputRequest,
  HarnessSessionListPlan,
  HarnessSessionListPlanRequest,
} from "@nvidia/nemoclaw-harness-contract";

function buildSessionListPlan(_request: HarnessSessionListPlanRequest): HarnessSessionListPlan {
  return {
    kind: "unsupported",
    reason: "LangChain Deep Agents Code does not expose session listing through NemoClaw yet.",
  };
}

function interpretSessionListOutput(
  _request: HarnessSessionListOutputRequest,
): HarnessSessionListOutput {
  return { kind: "refused", reason: "Session listing is not supported by this package." };
}

const sessionAdapter: HarnessSessionAdapterModule = {
  buildSessionListPlan,
  interpretSessionListOutput,
};

export = sessionAdapter;
