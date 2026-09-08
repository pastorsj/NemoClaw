// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { loadAgent } from "./defs";
import { buildAgentSkillIntegration, renderAgentSkillCommand } from "./skill-integration";

describe("agent skill integration metadata", () => {
  it.each([
    [
      "openclaw",
      "/sandbox/.openclaw/workspace/skills",
      ["/usr/local/bin/openclaw", "skills", "list", "--agent", "main"],
      true,
      false,
    ],
    [
      "hermes",
      "/sandbox/.hermes/skills",
      ["/usr/local/bin/hermes", "skills", "list"],
      false,
      false,
    ],
    [
      "langchain-deepagents-code",
      "/sandbox/.deepagents/agent/skills",
      ["/usr/local/bin/dcode", "skills", "list", "--agent", "agent"],
      false,
      true,
    ],
  ] as const)(
    "loads the static %s root and native list contract",
    (name, writableRoot, listCommand, hasNativeAdd, hasNativeRemove) => {
      const agent = loadAgent(name);
      const integration = agent.skillIntegration;

      expect(integration?.writableRoot).toBe(writableRoot);
      expect(
        renderAgentSkillCommand(agent.binary_path ?? "", integration?.listCommand ?? []),
      ).toEqual(listCommand);
      expect(Boolean(integration?.addCommand)).toBe(hasNativeAdd);
      expect(Boolean(integration?.removeCommand)).toBe(hasNativeRemove);
    },
  );

  it("renders only declared native placeholders", () => {
    expect(
      renderAgentSkillCommand(
        "/usr/local/bin/agent",
        ["skills", "install", "{source}", "--as", "{name}"],
        { name: "demo", source: "/sandbox/stage/demo" },
      ),
    ).toEqual(["/usr/local/bin/agent", "skills", "install", "/sandbox/stage/demo", "--as", "demo"]);
  });

  it("does not invent an integration for a disabled package capability", () => {
    expect(
      buildAgentSkillIntegration({ support: "disabled", reason: "No native skill loader." }),
    ).toBeNull();
  });
});
