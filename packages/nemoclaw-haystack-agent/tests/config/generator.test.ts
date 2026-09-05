// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const CONFIG_GENERATOR = path.join(PACKAGE_ROOT, "config", "generate-config.ts");
const temporaryHomes: string[] = [];

function runConfigGenerator(env: Readonly<Record<string, string>>) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-haystack-config-"));
  temporaryHomes.push(home);
  const result = spawnSync(process.execPath, ["--experimental-strip-types", CONFIG_GENERATOR], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    env: { HOME: home, PATH: process.env.PATH ?? "", ...env },
  });
  return { home, result };
}

function configPath(home: string): string {
  return path.join(home, ".haystack-agent", "fabric.json");
}

afterEach(() => {
  while (temporaryHomes.length > 0) {
    fs.rmSync(temporaryHomes.pop()!, { recursive: true, force: true });
  }
});

describe("Haystack Agent Fabric configuration", () => {
  it("writes a private credential-free direct Agent projection", () => {
    const { home, result } = runConfigGenerator({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_TEMPERATURE: "0.25",
      NEMOCLAW_MAX_TURNS: "12",
      NEMOCLAW_SYSTEM_INSTRUCTION: "Answer briefly.",
      NVIDIA_API_KEY: "nvapi-should-not-appear",
      OPENAI_API_KEY: "sk-proj-should-not-appear",
    });
    expect(result.status, result.stderr).toBe(0);

    const target = configPath(home);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    const text = fs.readFileSync(target, "utf8");
    expect(text).not.toContain("nvapi-should-not-appear");
    expect(text).not.toContain("sk-proj-should-not-appear");
    expect(text).not.toContain("nemoclaw-managed-inference");

    const config = JSON.parse(text) as any;
    expect(config.harness).toEqual({
      adapter_id: "nvidia.nemoclaw.haystack-agent",
      resolution: "preinstalled",
    });
    expect(config.discovery.local_paths).toEqual([
      "/usr/local/share/nemoclaw/haystack-agent.fabric-adapter.json",
    ]);
    expect(config.models.default).toEqual({
      provider: "openshell",
      model: "nvidia/nemotron-3-super-120b-a12b",
      api_key_env: "HAYSTACK_FABRIC_API_KEY",
      temperature: 0.25,
      base_url: "https://inference.local/v1",
    });
    expect(config.instructions.system).toEqual({ content: "Answer briefly.", mode: "replace" });
    expect(config.runtime).toMatchObject({
      input_schema: "text",
      output_schema: "message",
      timeout_seconds: 90,
      max_turns: 12,
    });
  });

  it("uses bounded deterministic defaults", () => {
    const { home, result } = runConfigGenerator({ NEMOCLAW_MODEL: "test-model" });
    expect(result.status, result.stderr).toBe(0);
    const config = JSON.parse(fs.readFileSync(configPath(home), "utf8")) as any;
    expect(config.models.default.temperature).toBe(0);
    expect(config.runtime.max_turns).toBe(8);
    expect(config.models.default.base_url).toBe("https://inference.local/v1");
  });

  it.each([
    ["NEMOCLAW_MODEL", " ", "NEMOCLAW_MODEL is required."],
    [
      "NEMOCLAW_INFERENCE_API",
      "openai-responses",
      "NEMOCLAW_INFERENCE_API must be openai-completions",
    ],
    [
      "NEMOCLAW_INFERENCE_BASE_URL",
      "https://user:secret@inference.local/v1",
      "must not include credentials",
    ],
    ["NEMOCLAW_INFERENCE_BASE_URL", "https://example.com/v1", "must be https://inference.local/v1"],
    ["NEMOCLAW_TEMPERATURE", "3", "must be a number between 0 and 2"],
    ["NEMOCLAW_MAX_TURNS", "33", "must be an integer between 1 and 32"],
  ])("rejects invalid %s before writing a config", (name, value, message) => {
    const { home, result } = runConfigGenerator({
      NEMOCLAW_MODEL: "test-model",
      [name]: value,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(fs.existsSync(configPath(home))).toBe(false);
  });
});
