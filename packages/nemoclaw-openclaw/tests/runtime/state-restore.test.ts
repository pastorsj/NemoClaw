// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { HarnessStateLifecycleDeclaration } from "@nvidia/nemoclaw-harness-contract";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const STATE_SCRIPT = path.join(PACKAGE_ROOT, "runtime/state-restore.py");
const tempRoots: string[] = [];

function runStateRestore(config: unknown, sessions: unknown): unknown {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-restore-"));
  tempRoots.push(root);
  const configPath = path.join(root, "config.json");
  const sessionsPath = path.join(root, "sessions.json");
  fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  fs.writeFileSync(sessionsPath, JSON.stringify(sessions), { mode: 0o600 });
  const runner = [
    "import importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('state_restore', sys.argv[1])",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "module.CONFIG_PATH = sys.argv[2]",
    "module.SESSIONS_PATH = sys.argv[3]",
    "module.main()",
  ].join("; ");
  const result = spawnSync(
    "python3",
    ["-I", "-c", runner, STATE_SCRIPT, configPath, sessionsPath],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(fs.readFileSync(sessionsPath, "utf8")) as unknown;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("OpenClaw package state restore", () => {
  it("clears only stale managed-provider session pins", () => {
    expect(
      runStateRestore(
        { agents: { defaults: { model: { primary: "inference/new-model" } } } },
        {
          stale: { modelProvider: "inference", model: "old-model", keep: true },
          current: { modelProvider: "inference", model: "new-model" },
          intentional: { modelProvider: "other", model: "old-model" },
        },
      ),
    ).toEqual({
      stale: { keep: true },
      current: { modelProvider: "inference", model: "new-model" },
      intentional: { modelProvider: "other", model: "old-model" },
    });
  });

  it("leaves sessions unchanged when no safe primary model is available", () => {
    const sessions = { existing: { modelProvider: "inference", model: "old-model" } };
    expect(runStateRestore({ agents: {} }, sessions)).toEqual(sessions);
  });

  it("declares and materializes one fixed package-owned command", () => {
    const manifest = parse(fs.readFileSync(path.join(PACKAGE_ROOT, "manifest.yaml"), "utf8")) as {
      state_lifecycle: HarnessStateLifecycleDeclaration;
    };
    const postRestore = manifest.state_lifecycle.rebuild.post_restore;
    expect(postRestore).toMatchObject({
      kind: "managed",
      command: {
        command: ["/usr/local/bin/nemoclaw-state-restore"],
        timeout_seconds: 300,
      },
    });
    const shellCheck = spawnSync("sh", ["-n", path.join(PACKAGE_ROOT, "runtime/state-restore.sh")]);
    expect(shellCheck.status).toBe(0);
    const pythonCheck = spawnSync("python3", [
      "-I",
      "-c",
      "compile(open(__import__('sys').argv[1], encoding='utf-8').read(), __import__('sys').argv[1], 'exec')",
      STATE_SCRIPT,
    ]);
    expect(pythonCheck.status).toBe(0);
    const dockerfile = fs.readFileSync(path.join(PACKAGE_ROOT, "Dockerfile"), "utf8");
    expect(dockerfile).toContain(
      "COPY --chmod=0555 packages/nemoclaw-openclaw/runtime/state-restore.sh /usr/local/bin/nemoclaw-state-restore",
    );
    expect(dockerfile).toContain(
      "COPY --chmod=0444 packages/nemoclaw-openclaw/runtime/state-restore.py /usr/local/lib/nemoclaw/openclaw-state-restore.py",
    );
  });
});
