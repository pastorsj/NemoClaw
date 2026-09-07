// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessPolicyCapability,
  HarnessToolGatewayCapability,
} from "@nvidia/nemoclaw-harness-contract";
import { describe, expect, it } from "vitest";

import { setupPolicyPresetAppliesToAgent } from "./agent-policy-presets";
import { mergeRequiredSetupPolicyPresets } from "./policy-preset-reconciliation";

const FUTURE_TOOLS = {
  support: "managed",
  selection_label: "Future tools",
  selection_prompt: "Managed tools",
  request_environment: ["NEMOCLAW_FUTURE_TOOLS"],
  incompatible_auth_message: "Future tools require browser login.",
  gateways: [
    {
      id: "future-search",
      aliases: ["search"],
      label: "Future search",
      description: "Search with the future service",
      default_selected: true,
      authentication_methods: ["browser-login"],
      policy_presets: ["future-egress"],
    },
  ],
} as const satisfies HarnessToolGatewayCapability;

const FUTURE_POLICY = {
  owned_presets: ["future-egress"],
  automatic_presets: [],
  baseline_exclusion_impacts: {},
} as const satisfies HarnessPolicyCapability;

describe("managed tool gateway policy reconciliation", () => {
  it("does not use the Hermes legacy preset table for a same-ID package", () => {
    expect(setupPolicyPresetAppliesToAgent("nous-audio", "hermes", FUTURE_POLICY)).toBe(false);
    expect(setupPolicyPresetAppliesToAgent("nous-audio", "hermes")).toBe(true);
  });

  it("maps receipt selections through package declarations without a Hermes name fallback", () => {
    expect(
      mergeRequiredSetupPolicyPresets([], {
        toolGatewayCapability: FUTURE_TOOLS,
        toolGatewaySelections: ["future-search", "nous-web"],
        knownPresetNames: ["future-egress", "nous-web"],
      }),
    ).toContain("future-egress");
    expect(
      mergeRequiredSetupPolicyPresets([], {
        toolGatewayCapability: FUTURE_TOOLS,
        toolGatewaySelections: ["future-search", "nous-web"],
        knownPresetNames: ["future-egress", "nous-web"],
      }),
    ).not.toContain("nous-web");
  });
});
