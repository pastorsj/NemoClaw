// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessWebSearchCapability,
  HarnessWebSearchProvider,
} from "@nvidia/nemoclaw-harness-contract";

import { isObjectRecord } from "../core/json-types";
import type { ManifestRecord } from "./manifest-types";

const WEB_SEARCH_PROVIDERS = new Set<HarnessWebSearchProvider>(["brave", "tavily"]);
const TOOL_GATEWAY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

/** Read one package's bounded web-search capability. */
export function readWebSearchCapability(
  manifest: ManifestRecord,
): HarnessWebSearchCapability | undefined {
  const value = manifest.web_search;
  if (value === undefined) return undefined;
  if (!isObjectRecord(value)) {
    throw new Error("Agent manifest field 'web_search' must be an object");
  }
  if (value.support === "disabled") {
    if (typeof value.reason !== "string" || !value.reason.trim()) {
      throw new Error("Agent manifest field 'web_search.reason' must be non-empty text");
    }
    return Object.freeze({ support: "disabled", reason: value.reason });
  }
  if (value.support !== "providers") {
    throw new Error("Agent manifest field 'web_search.support' must be providers or disabled");
  }
  if (
    !Array.isArray(value.providers) ||
    value.providers.length === 0 ||
    value.providers.length > WEB_SEARCH_PROVIDERS.size ||
    new Set(value.providers).size !== value.providers.length ||
    value.providers.some(
      (provider) => !WEB_SEARCH_PROVIDERS.has(provider as HarnessWebSearchProvider),
    )
  ) {
    throw new Error(
      "Agent manifest field 'web_search.providers' must contain unique brave or tavily entries",
    );
  }
  const providers = Object.freeze([...(value.providers as HarnessWebSearchProvider[])]);
  const rawConflicts = value.tool_gateway_conflicts;
  if (
    rawConflicts !== undefined &&
    (!Array.isArray(rawConflicts) || rawConflicts.length === 0 || rawConflicts.length > 16)
  ) {
    throw new Error(
      "Agent manifest field 'web_search.tool_gateway_conflicts' must contain 1 through 16 conflicts",
    );
  }
  const seen = new Set<string>();
  const toolGatewayConflicts = Object.freeze(
    (rawConflicts ?? []).map((entry, index) => {
      const field = `web_search.tool_gateway_conflicts[${String(index)}]`;
      if (
        !isObjectRecord(entry) ||
        !WEB_SEARCH_PROVIDERS.has(entry.provider as HarnessWebSearchProvider) ||
        !providers.includes(entry.provider as HarnessWebSearchProvider) ||
        typeof entry.tool_gateway !== "string" ||
        !TOOL_GATEWAY_PATTERN.test(entry.tool_gateway)
      ) {
        throw new Error(`Agent manifest field '${field}' is invalid`);
      }
      const key = `${String(entry.provider)}\0${entry.tool_gateway}`;
      if (seen.has(key)) throw new Error(`Agent manifest field '${field}' is duplicated`);
      seen.add(key);
      return Object.freeze({
        provider: entry.provider as HarnessWebSearchProvider,
        tool_gateway: entry.tool_gateway,
      });
    }),
  );
  return Object.freeze({
    support: "providers",
    providers,
    ...(toolGatewayConflicts.length > 0 ? { tool_gateway_conflicts: toolGatewayConflicts } : {}),
  });
}

/** Return whether a receipt-backed package declares one web-search provider. */
export function packageSupportsWebSearchProvider(
  agent: { web_search?: HarnessWebSearchCapability } | null | undefined,
  provider: HarnessWebSearchProvider,
): boolean {
  return (
    agent?.web_search?.support === "providers" && agent.web_search.providers.includes(provider)
  );
}

/** Remove tool gateways that the selected package declares incompatible with web search. */
export function filterPackageWebSearchToolGateways(
  agent: { web_search?: HarnessWebSearchCapability } | null | undefined,
  provider: HarnessWebSearchProvider | null,
  gateways: readonly string[],
): string[] {
  if (!provider || agent?.web_search?.support !== "providers") return [...gateways];
  const conflicts = new Set(
    (agent.web_search.tool_gateway_conflicts ?? [])
      .filter((conflict) => conflict.provider === provider)
      .map((conflict) => conflict.tool_gateway),
  );
  return gateways.filter((gateway) => !conflicts.has(gateway));
}
