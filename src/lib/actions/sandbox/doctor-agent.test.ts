// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { AgentDefinition } from "../../agent/defs";
import type { SandboxEntry } from "../../state/registry";
import { resolveDoctorAgentAuthority } from "./doctor-agent";

function packageEntry(agent = "future-harness"): SandboxEntry {
  return {
    name: "alpha",
    agent,
    harnessPackage: {
      kind: "agent-runtime",
      id: agent,
      packageVersion: "1.0.0",
      contentDigest: "a".repeat(64),
    },
  };
}

function definition(kind: "gateway" | "terminal"): AgentDefinition {
  return {
    name: "future-harness",
    displayName: "Future Harness",
    runtime: { kind, interactive_command: "future-harness" },
  } as AgentDefinition;
}

describe("doctor agent authority", () => {
  it("leaves rows without a package receipt on the legacy path", () => {
    const resolveStatusAgent = vi.fn();

    expect(
      resolveDoctorAgentAuthority({ name: "legacy", agent: "openclaw" }, { resolveStatusAgent }),
    ).toEqual({ kind: "legacy" });
    expect(resolveStatusAgent).not.toHaveBeenCalled();
  });

  it.each(["gateway", "terminal"] as const)(
    "returns typed %s runtime authority for an exact external package",
    (runtimeKind) => {
      const entry = packageEntry();
      const agent = definition(runtimeKind);
      const resolveStatusAgent = vi.fn(() => ({
        agentName: agent.name,
        agentDisplayName: agent.displayName,
        agentRuntime: runtimeKind,
        agentDefinition: agent,
      }));

      expect(resolveDoctorAgentAuthority(entry, { resolveStatusAgent })).toEqual({
        kind: "resolved",
        definition: agent,
        runtimeKind,
      });
      expect(resolveStatusAgent).toHaveBeenCalledWith(entry);
    },
  );

  it("returns an explicit unsupported result when package authority is invalid", () => {
    const entry = packageEntry();

    expect(
      resolveDoctorAgentAuthority(entry, {
        resolveStatusAgent: () => ({
          agentName: "future-harness",
          agentDisplayName: "future-harness",
          agentRuntime: "unknown",
          agentLoadError: "package receipt digest changed",
          packageAuthorityInvalid: true,
          agentDefinition: null,
        }),
      }),
    ).toEqual({ kind: "unsupported", reason: "package receipt digest changed" });
  });

  it("bounds unsafe resolver diagnostics before returning them", () => {
    const unsafe = `bad\n${"x".repeat(300)}`;
    const result = resolveDoctorAgentAuthority(packageEntry(), {
      resolveStatusAgent: () => {
        throw new Error(unsafe);
      },
    });

    expect(result.kind).toBe("unsupported");
    if (result.kind === "unsupported") {
      expect(result.reason).not.toContain("\n");
      expect(result.reason.length).toBeLessThanOrEqual(240);
    }
  });
});
