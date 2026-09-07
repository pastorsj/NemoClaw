// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import type { HarnessAgentManifest } from "@nvidia/nemoclaw-harness-contract";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");

function readManifest(): HarnessAgentManifest {
  return parse(
    fs.readFileSync(path.join(PACKAGE_ROOT, "manifest.yaml"), "utf8"),
  ) as HarnessAgentManifest;
}

describe("Hermes managed tool gateway declaration", () => {
  it("preserves the existing catalogue, defaults, auth boundary, and policy mapping", () => {
    const capability = readManifest().tool_gateways;
    expect(capability?.support).toBe("managed");
    if (!capability || capability.support !== "managed") throw new Error("missing capability");

    expect(capability.request_environment).toEqual([
      "NEMOCLAW_HERMES_TOOL_GATEWAYS",
      "NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS",
    ]);
    expect(capability.gateways.map(({ id }) => id)).toEqual([
      "nous-web",
      "nous-image",
      "nous-audio",
      "nous-browser",
      "nous-code",
    ]);
    expect(
      capability.gateways.filter(({ default_selected: selected }) => selected).map(({ id }) => id),
    ).toEqual(["nous-web", "nous-image", "nous-audio", "nous-browser"]);
    for (const gateway of capability.gateways) {
      expect(gateway.authentication_methods).toEqual(["oauth"]);
      expect(gateway.policy_presets).toEqual([gateway.id]);
    }
  });
});
