// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { HarnessAgentRosterAdapterModule } from "@nvidia/nemoclaw-harness-contract";

import { loadPackageHostModule } from "../helpers/host-module";

const adapter = loadPackageHostModule<HarnessAgentRosterAdapterModule>("agent-roster-adapter.cts");

describe("OpenClaw agent roster adapter", () => {
  it.each(["list", "add", "delete"] as const)(
    "preserves OpenClaw native %s pass-through argv",
    (operation) => {
      expect(
        adapter.buildAgentRosterCommand({ operation, arguments: ["alpha", "--json"] }),
      ).toEqual({
        kind: "stream",
        command: ["openclaw", "agents", operation, "alpha", "--json"],
      });
    },
  );

  it("owns inspection argv and path defaults", () => {
    const manifest = { agents: [{ id: "alpha" }] };
    expect(adapter.buildAgentRosterInspection({ manifest })).toEqual({
      kind: "capture",
      command: ["openclaw", "agents", "list", "--json"],
    });

    expect(
      adapter.buildAgentRosterApplyPlan({
        manifest,
        current_output: '[{"id":"main"}]',
      }),
    ).toMatchObject({
      kind: "ready",
      current_count: 1,
      additions: [
        {
          agent_id: "alpha",
          command: [
            "openclaw",
            "agents",
            "add",
            "alpha",
            "--non-interactive",
            "--workspace",
            "/sandbox/.openclaw/workspace-alpha",
          ],
        },
      ],
    });
  });

  it("preserves the force-only delete distinction", () => {
    const plan = adapter.buildAgentRosterApplyPlan({
      manifest: { agents: [] },
      current_output: '[{"id":"main"},{"id":"logs-reader"}]',
    });

    expect(plan).toMatchObject({
      kind: "ready",
      deletions: [
        {
          agent_id: "logs-reader",
          command: ["openclaw", "agents", "delete", "logs-reader", "--force"],
        },
      ],
    });
    if (plan.kind === "ready") {
      expect(plan.deletions[0]?.command).not.toContain("--non-interactive");
    }
  });

  it("reports rebuild-only fields and live tool-policy notices", () => {
    const plan = adapter.buildAgentRosterApplyPlan({
      manifest: {
        defaults: { subagents: { maxSpawnDepth: 3 } },
        main: { subagents: { allowAgents: ["alpha"] } },
        agents: [{ id: "alpha", model: "provider/model", tools: { allow: ["read"] } }],
      },
      current_output: '{"agents":[{"id":"main"}]}',
    });

    expect(plan).toMatchObject({
      kind: "ready",
      rebuild_only_fields: ["defaults", "main", "agents[alpha].model", "agents[alpha].tools"],
    });
    if (plan.kind === "ready") {
      expect(plan.notices[0]?.message).toContain('tools for "alpha"');
    }
  });

  it("returns a typed refusal for unsafe native IDs before inspection", () => {
    expect(
      adapter.buildAgentRosterInspection({ manifest: { agents: [{ id: "--help" }] } }),
    ).toMatchObject({ kind: "refused", reason: expect.stringContaining("agents[0].id") });
  });

  it("returns a typed refusal when native list output cannot be parsed", () => {
    expect(
      adapter.buildAgentRosterApplyPlan({
        manifest: { agents: [] },
        current_output: "not-json",
      }),
    ).toMatchObject({ kind: "refused" });
  });
});
