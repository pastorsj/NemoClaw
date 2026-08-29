// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentDefinition } from "../agent/definition-types";
import * as agentDefs from "../agent/defs";
import * as registry from "../state/registry";
import { loadPresetForSandbox } from "./index";

const tempDirs: string[] = [];

function writeAgentPolicy(content: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-agent-preset-"));
  tempDirs.push(directory);
  const policyPath = path.join(directory, "policy-additions.yaml");
  fs.writeFileSync(policyPath, content);
  return policyPath;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("agent-specific preset resolution", () => {
  it("uses pinned package metadata without loading the ambient agent definition", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "alpha",
      agent: "hermes",
    } as never);
    const ambientLoad = vi.spyOn(agentDefs, "loadAgent").mockImplementation(() => {
      throw new Error("ambient agent metadata must not be loaded");
    });
    const pinnedAgentDefinition = {
      name: "hermes",
      displayName: "Installed Hermes",
      policyAdditionsPath: writeAgentPolicy(`
network_policies:
  pypi:
    name: pypi
    endpoints:
      - host: installed-packages.example.test
        port: 443
        protocol: rest
        enforcement: enforce
        rules:
          - allow: { method: GET, path: "/**" }
    binaries:
      - { path: /usr/bin/python3 }
`),
    } as AgentDefinition;

    const preset = loadPresetForSandbox("alpha", "pypi", {
      agentDefinition: pinnedAgentDefinition,
    });

    expect(preset).toContain("installed-packages.example.test");
    expect(preset).not.toContain("pypi.org");
    expect(ambientLoad).not.toHaveBeenCalled();
  });
});
