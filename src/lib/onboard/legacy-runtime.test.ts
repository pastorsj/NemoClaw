// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { AgentDefinition } from "../agent-runtime/manifest-types";
import { appendLegacyRuntimeEnvironment } from "./legacy-runtime";

function legacyAgent(name: string, configDir = `/sandbox/.${name}`): AgentDefinition {
  return { name, configPaths: { dir: configDir } } as AgentDefinition;
}

describe("appendLegacyRuntimeEnvironment", () => {
  it("preserves the implicit OpenClaw layout for a no-definition legacy launch", () => {
    const envArgs: string[] = [];

    appendLegacyRuntimeEnvironment(envArgs, null, {}, false);

    expect(envArgs).toEqual([
      "OPENCLAW_HOME=/sandbox",
      "OPENCLAW_STATE_DIR=/sandbox/.openclaw",
      "OPENCLAW_WORKSPACE_DIR=/sandbox/.openclaw/workspace",
    ]);
  });

  it("derives the historical OpenClaw layout from its legacy config path", () => {
    const envArgs: string[] = [];

    appendLegacyRuntimeEnvironment(
      envArgs,
      legacyAgent("openclaw", "/srv/agent-root/.openclaw"),
      {},
      false,
    );

    expect(envArgs).toEqual([
      "OPENCLAW_HOME=/srv/agent-root",
      "OPENCLAW_STATE_DIR=/srv/agent-root/.openclaw",
      "OPENCLAW_WORKSPACE_DIR=/srv/agent-root/.openclaw/workspace",
    ]);
  });

  it("does not leak OpenClaw layout variables into another legacy runtime", () => {
    const envArgs: string[] = [];

    appendLegacyRuntimeEnvironment(envArgs, legacyAgent("hermes"), {}, false);

    expect(envArgs).toEqual([]);
  });
});
