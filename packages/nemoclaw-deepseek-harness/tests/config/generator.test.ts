// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const GENERATOR = path.join(PACKAGE_ROOT, "config", "generate-config.py");
const temporaryHomes: string[] = [];

function runConfigGenerator(environment: Readonly<Record<string, string>>) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-deepseek-config-"));
  temporaryHomes.push(home);
  const result = spawnSync("python3", ["-I", GENERATOR], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    env: { HOME: home, PATH: process.env.PATH ?? "", ...environment },
  });
  return { home, result };
}

function generatedConfigPath(home: string): string {
  return path.join(home, ".deepseek-harness", "fabric.json");
}

afterEach(() => {
  while (temporaryHomes.length > 0) {
    fs.rmSync(temporaryHomes.pop()!, { recursive: true, force: true });
  }
});

describe("DeepSeek Harness Fabric configuration", () => {
  it("writes a private credential-free managed route", () => {
    const secret = "nvapi-config-secret";
    const { home, result } = runConfigGenerator({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
      NVIDIA_API_KEY: secret,
    });
    expect(result.status, result.stderr).toBe(0);

    const configPath = generatedConfigPath(home);
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    const text = fs.readFileSync(configPath, "utf8");
    expect(text).not.toContain(secret);
    expect(text).not.toContain("nemoclaw-managed-inference");
    const config = JSON.parse(text) as {
      harness: { adapter_id: string; resolution: string };
      discovery: { local_paths: string[] };
      models: { default: Record<string, string> };
      runtime: { artifacts: string; timeout_seconds: number };
      environment: { artifacts: string; ownership: string };
    };
    expect(config.harness).toEqual({
      adapter_id: "nvidia.nemoclaw.deepseek-harness",
      resolution: "preinstalled",
    });
    expect(config.discovery.local_paths).toEqual([
      "/usr/local/share/nemoclaw/deepseek.fabric-adapter.json",
    ]);
    expect(config.models.default).toEqual({
      provider: "openshell",
      model: "nvidia/nemotron-3-super-120b-a12b",
      api_key_env: "DEEPSEEK_FABRIC_API_KEY",
      base_url: "https://inference.local/v1",
    });
    expect(config.runtime).toMatchObject({
      artifacts: "/sandbox/.deepseek-harness/fabric-artifacts",
      timeout_seconds: 90,
    });
    expect(config.environment).toMatchObject({
      artifacts: "/sandbox/.deepseek-harness/fabric-artifacts",
      ownership: "caller_owned",
    });
  });

  it.each([
    ["NEMOCLAW_MODEL", "   ", "NEMOCLAW_MODEL"],
    ["NEMOCLAW_MODEL", "model\nother", "control characters"],
    ["NEMOCLAW_INFERENCE_API", "openai-responses", "openai-completions"],
    ["NEMOCLAW_INFERENCE_BASE_URL", "https://api.deepseek.com/v1", "inference.local"],
    ["NEMOCLAW_INFERENCE_BASE_URL", "https://user:secret@inference.local/v1", "credentials"],
  ])("rejects invalid %s before writing config", (name, value, message) => {
    const { home, result } = runConfigGenerator({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      [name]: value,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(fs.existsSync(generatedConfigPath(home))).toBe(false);
  });
});
