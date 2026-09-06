// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
"use strict";
const SANDBOX_NAME = /^(?!.*--)[a-z](?:[a-z0-9-]*[a-z0-9])?$/u;
function buildProviderBrokerPlan(request) {
  if (!SANDBOX_NAME.test(request.sandboxName) || request.sandboxName.length > 19) {
    return { kind: "unsupported", reason: "sandbox name is not supported by this provider broker" };
  }
  return {
    kind: "managed",
    providerName: `${request.sandboxName}-hermes-tool-gateway`,
  };
}
const providerBrokerAdapter = { buildProviderBrokerPlan };
module.exports = providerBrokerAdapter;
