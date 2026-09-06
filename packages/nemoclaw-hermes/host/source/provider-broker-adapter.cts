// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HarnessProviderBrokerAdapterModule } from "@nvidia/nemoclaw-harness-contract";

const SANDBOX_NAME = /^(?!.*--)[a-z](?:[a-z0-9-]*[a-z0-9])?$/u;

function buildProviderBrokerPlan(
  request: Parameters<HarnessProviderBrokerAdapterModule["buildProviderBrokerPlan"]>[0],
): ReturnType<HarnessProviderBrokerAdapterModule["buildProviderBrokerPlan"]> {
  if (!SANDBOX_NAME.test(request.sandboxName) || request.sandboxName.length > 19) {
    return { kind: "unsupported", reason: "sandbox name is not supported by this provider broker" };
  }
  return {
    kind: "managed",
    providerName: `${request.sandboxName}-hermes-tool-gateway`,
  };
}

const providerBrokerAdapter = { buildProviderBrokerPlan };

export = providerBrokerAdapter satisfies HarnessProviderBrokerAdapterModule;
