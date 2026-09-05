// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessSessionAdapterModule,
  HarnessSessionExportIndexOutput,
  HarnessSessionExportIndexRequest,
  HarnessSessionExportPlan,
  HarnessSessionExportPlanRequest,
  HarnessSessionListOutput,
  HarnessSessionListOutputRequest,
  HarnessSessionListPlan,
  HarnessSessionListPlanRequest,
  HarnessSessionMutationOutput,
  HarnessSessionMutationOutputRequest,
  HarnessSessionMutationPlan,
  HarnessSessionMutationPlanRequest,
} from "@nvidia/nemoclaw-harness-contract";

function buildSessionListPlan(_request: HarnessSessionListPlanRequest): HarnessSessionListPlan {
  return {
    kind: "unsupported",
    reason: "Haystack Agent does not expose session listing through NemoClaw yet.",
  };
}

function interpretSessionListOutput(
  _request: HarnessSessionListOutputRequest,
): HarnessSessionListOutput {
  return { kind: "refused", reason: "Session listing is not supported by this package." };
}

function buildSessionMutationPlan(
  request: HarnessSessionMutationPlanRequest,
): HarnessSessionMutationPlan {
  return {
    kind: "unsupported",
    reason: `Haystack Agent does not expose session ${request.operation} through NemoClaw yet.`,
  };
}

function interpretSessionMutationOutput(
  _request: HarnessSessionMutationOutputRequest,
): HarnessSessionMutationOutput {
  return { kind: "refused", reason: "Session mutation is not supported by this package." };
}

function buildSessionExportPlan(
  _request: HarnessSessionExportPlanRequest,
): HarnessSessionExportPlan {
  return {
    kind: "unsupported",
    reason: "Haystack Agent does not expose session export through NemoClaw yet.",
  };
}

function interpretSessionExportIndex(
  _request: HarnessSessionExportIndexRequest,
): HarnessSessionExportIndexOutput {
  return { kind: "refused", reason: "Session export is not supported by this package." };
}

const sessionAdapter: HarnessSessionAdapterModule = {
  buildSessionListPlan,
  interpretSessionListOutput,
  buildSessionMutationPlan,
  interpretSessionMutationOutput,
  buildSessionExportPlan,
  interpretSessionExportIndex,
};

export = sessionAdapter;
