// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
"use strict";
function buildSessionListPlan(_request) {
  return {
    kind: "unsupported",
    reason: "DeepSeek Harness does not expose session listing through NemoClaw yet.",
  };
}
function interpretSessionListOutput(_request) {
  return { kind: "refused", reason: "Session listing is not supported by this package." };
}
function buildSessionMutationPlan(request) {
  return {
    kind: "unsupported",
    reason: `DeepSeek Harness does not expose session ${request.operation} through NemoClaw yet.`,
  };
}
function interpretSessionMutationOutput(_request) {
  return { kind: "refused", reason: "Session mutation is not supported by this package." };
}
function buildSessionExportPlan(_request) {
  return {
    kind: "unsupported",
    reason: "DeepSeek Harness does not expose session export through NemoClaw yet.",
  };
}
function interpretSessionExportIndex(_request) {
  return { kind: "refused", reason: "Session export is not supported by this package." };
}
const sessionAdapter = {
  buildSessionListPlan,
  interpretSessionListOutput,
  buildSessionMutationPlan,
  interpretSessionMutationOutput,
  buildSessionExportPlan,
  interpretSessionExportIndex,
};
module.exports = sessionAdapter;
