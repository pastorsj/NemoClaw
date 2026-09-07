// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { resolveOnboardOptions, runOnboardCommand } from "./command";

function exitWithCode(code: number): never {
  throw new Error(`exit:${String(code)}`);
}

describe("onboard --agents", () => {
  it("resolves an existing manifest without choosing a harness by ID", () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-agents-"));
    try {
      const manifestPath = path.join(temporaryDirectory, "agents.yaml");
      fs.writeFileSync(manifestPath, "workers: []\n");
      const relativeManifestPath = path.relative(process.cwd(), manifestPath);

      const result = resolveOnboardOptions(
        { agent: "future-harness", agents: relativeManifestPath },
        {
          env: {},
          listAgents: () => ["future-harness"],
          exit: exitWithCode,
        },
      );
      expect(result.agentsManifest).toBe(path.resolve(relativeManifestPath));
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("rejects a missing manifest", () => {
    const errors: string[] = [];
    expect(() =>
      resolveOnboardOptions(
        { agents: "/nonexistent/agents.yaml" },
        {
          env: {},
          error: (message = "") => errors.push(message),
          exit: exitWithCode,
        },
      ),
    ).toThrow("exit:1");
    expect(errors.join("\n")).toContain("--agents path not found");
  });

  it("transports package-native manifest data without OpenClaw path defaults", async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-roster-"));
    const manifestPath = path.join(temporaryDirectory, "agents.yaml");
    fs.writeFileSync(manifestPath, "workers:\n  - name: planner\n");
    let observedRaw: string | undefined;
    const environment: NodeJS.ProcessEnv = {};
    try {
      await runOnboardCommand({
        flags: { agent: "future-harness", agents: manifestPath },
        env: environment,
        listAgents: () => ["future-harness"],
        runOnboard: vi.fn(async () => {
          observedRaw = environment.NEMOCLAW_EXTRA_AGENTS_JSON;
        }),
        exit: exitWithCode,
      });
      expect(JSON.parse(observedRaw ?? "null")).toEqual({ workers: [{ name: "planner" }] });
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
