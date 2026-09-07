// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessProviderAuthAdapterModule,
  HarnessProviderAuthPlan,
  HarnessProviderAuthPlanRequest,
} from "@nvidia/nemoclaw-harness-contract";

const AUTH_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  api: "api-key",
  key: "api-key",
  "api-key": "api-key",
  apikey: "api-key",
  "nous-api-key": "api-key",
  oauth: "oauth",
  "nous-oauth": "oauth",
  "nous-portal-oauth": "oauth",
});

function normalizeRequestedMethod(value: string | null): string | null {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, "-");
  return normalized ? (AUTH_ALIASES[normalized] ?? null) : null;
}

function resolveProviderAuthMethod(
  request: HarnessProviderAuthPlanRequest,
): HarnessProviderAuthPlan {
  const requested = normalizeRequestedMethod(request.requestedMethod);
  if (request.requestedMethod && !requested) {
    return {
      kind: "unsupported",
      reason: "requested provider authentication method is unsupported",
    };
  }
  return {
    kind: "managed",
    methodId:
      requested ?? (request.availableCredentialEnvs.includes("NOUS_API_KEY") ? "api-key" : "oauth"),
  };
}

const providerAuthAdapter = { resolveProviderAuthMethod };

export = providerAuthAdapter satisfies HarnessProviderAuthAdapterModule;
