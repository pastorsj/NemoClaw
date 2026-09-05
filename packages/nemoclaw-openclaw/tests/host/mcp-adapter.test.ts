// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { loadPackageHostModule } from "../helpers/host-module";

const adapter = loadPackageHostModule<{
  buildMcpRuntimePlan(request: { readonly command: readonly string[] }): {
    readonly command: readonly string[];
    readonly environmentVariablesToRemove: readonly string[];
  };
}>("mcp-adapter.cts");

describe("OpenClaw MCP runtime adapter", () => {
  it("preserves a child argument that begins with a dash", () => {
    const plan = adapter.buildMcpRuntimePlan({ command: ["--require", "child.mjs"] });

    expect(plan.command.slice(0, 3)).toEqual(["nemoclaw-start", "node", "-e"]);
    expect(plan.command.slice(4)).toEqual(["--", "--require", "child.mjs"]);
    expect(plan.environmentVariablesToRemove).toContain("OPENCLAW_GATEWAY_TOKEN");
  });
});
