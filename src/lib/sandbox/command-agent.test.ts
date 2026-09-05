// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { AgentDefinition } from "../agent/defs";
import type { SandboxEntry } from "../state/registry";
import { resolveSandboxCommandAgent } from "./command-agent";

describe("resolveSandboxCommandAgent", () => {
  it("uses the exact receipt for an unknown package without consulting the legacy catalogue", () => {
    const definition = { name: "synthetic-harness" } as AgentDefinition;
    const entry = {
      name: "alpha",
      agent: "synthetic-harness",
      harnessPackage: {
        kind: "agent-runtime",
        id: "synthetic-harness",
        packageVersion: "7.2.1",
        contentDigest: "sha256:0123456789abcdef",
      },
    } as SandboxEntry;
    const loadAgent = vi.fn();
    const resolvePackageAgent = vi.fn(() => ({ definition }));

    expect(resolveSandboxCommandAgent(entry, { loadAgent, resolvePackageAgent })).toBe(definition);
    expect(resolvePackageAgent).toHaveBeenCalledWith(entry);
    expect(loadAgent).not.toHaveBeenCalled();
  });

  it("retains catalogue lookup only for a legacy row without a receipt", () => {
    const definition = { name: "openclaw" } as AgentDefinition;
    const loadAgent = vi.fn(() => definition);
    const resolvePackageAgent = vi.fn();

    expect(
      resolveSandboxCommandAgent({ name: "legacy", agent: null } as SandboxEntry, {
        loadAgent,
        resolvePackageAgent,
      }),
    ).toBe(definition);
    expect(loadAgent).toHaveBeenCalledWith("openclaw");
    expect(resolvePackageAgent).not.toHaveBeenCalled();
  });
});
