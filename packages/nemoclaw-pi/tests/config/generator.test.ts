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

type GeneratorResult = {
  readonly home: string;
  readonly status: number | null;
  readonly stderr: string;
};

function runPiConfigGenerator(env: Readonly<Record<string, string>>): GeneratorResult {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pi-config-"));
  temporaryHomes.push(home);
  const result = spawnSync(process.execPath, ["--experimental-strip-types", CONFIG_GENERATOR], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    env: { HOME: home, PATH: process.env.PATH ?? "", ...env },
  });
  return { home, status: result.status, stderr: result.stderr };
}

function configPathForHome(home: string): string {
  return path.join(home, ".pi", "agent", "models.json");
}

function fabricConfigPathForHome(home: string): string {
  return path.join(home, ".pi", "agent", "fabric.json");
}

function readManagedModel(home: string): Readonly<Record<string, unknown>> {
  const config = JSON.parse(fs.readFileSync(configPathForHome(home), "utf8")) as {
    providers: Record<string, { models: Array<Record<string, unknown>> }>;
  };
  return config.providers.openshell.models[0] ?? {};
}

afterEach(() => {
  while (temporaryHomes.length > 0) {
    fs.rmSync(temporaryHomes.pop()!, { recursive: true, force: true });
  }
});

describe("Pi managed model catalog generation", () => {
  it("writes an owner-only catalog that routes the managed model", () => {
    const { home, status, stderr } = runPiConfigGenerator({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
    });
    expect(status, stderr).toBe(0);

    const configPath = configPathForHome(home);
    const descriptor = fs.openSync(configPath, "r");
    let config: {
      defaultModel: string;
      providers: Record<string, { baseUrl: string; api: string; apiKey: string }>;
    };
    try {
      expect(fs.fstatSync(descriptor).mode & 0o777).toBe(0o600);
      config = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    } finally {
      fs.closeSync(descriptor);
    }
    expect(config.defaultModel).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(config.providers.openshell).toMatchObject({
      api: "openai-completions",
      apiKey: "nemoclaw-managed-inference",
      baseUrl: "https://inference.local/v1",
    });

    const fabricPath = fabricConfigPathForHome(home);
    const fabricDescriptor = fs.openSync(fabricPath, "r");
    let fabricConfig: {
      discovery: { local_paths: string[] };
      harness: { adapter_id: string; resolution: string };
      models: {
        default: { api_key_env: string; base_url: string; model: string; provider: string };
      };
      runtime: { input_schema: string; output_schema: string; timeout_seconds: number };
    };
    try {
      expect(fs.fstatSync(fabricDescriptor).mode & 0o777).toBe(0o600);
      fabricConfig = JSON.parse(fs.readFileSync(fabricDescriptor, "utf8"));
    } finally {
      fs.closeSync(fabricDescriptor);
    }
    expect(fabricConfig.harness).toEqual({
      adapter_id: "nvidia.nemoclaw.pi",
      resolution: "preinstalled",
    });
    expect(fabricConfig.discovery.local_paths).toEqual([
      "/usr/local/share/nemoclaw/pi.fabric-adapter.json",
    ]);
    expect(fabricConfig.runtime).toMatchObject({
      input_schema: "text",
      output_schema: "message",
      timeout_seconds: 90,
    });
    expect(fabricConfig.models.default).toEqual({
      provider: "openshell",
      model: "nvidia/nemotron-3-super-120b-a12b",
      api_key_env: "PI_FABRIC_API_KEY",
      base_url: "https://inference.local/v1",
    });
  });

  it("keeps upstream provider credentials out of the generated catalog", () => {
    const { home, status, stderr } = runPiConfigGenerator({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NVIDIA_API_KEY: "nvapi-should-never-be-written",
      OPENAI_API_KEY: "sk-proj-should-never-be-written",
    });
    expect(status, stderr).toBe(0);
    const config = fs.readFileSync(configPathForHome(home), "utf8");
    const fabricConfig = fs.readFileSync(fabricConfigPathForHome(home), "utf8");
    expect(config).not.toContain("nvapi-");
    expect(config).not.toContain("sk-proj-");
    expect(fabricConfig).not.toContain("nvapi-");
    expect(fabricConfig).not.toContain("sk-proj-");
    expect(fabricConfig).not.toContain("nemoclaw-managed-inference");
  });

  it("writes supported model limits and reasoning metadata", () => {
    const { home, status, stderr } = runPiConfigGenerator({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_CONTEXT_WINDOW: "262144",
      NEMOCLAW_MAX_TOKENS: "32000",
      NEMOCLAW_REASONING: "true",
    });
    expect(status, stderr).toBe(0);
    expect(readManagedModel(home)).toEqual({
      id: "nvidia/nemotron-3-super-120b-a12b",
      contextWindow: 262_144,
      maxTokens: 32_000,
      reasoning: true,
    });
  });

  it("omits unset model tuning so Pi keeps its defaults", () => {
    const { home, status, stderr } = runPiConfigGenerator({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
    });
    expect(status, stderr).toBe(0);
    expect(readManagedModel(home)).toEqual({ id: "nvidia/nemotron-3-super-120b-a12b" });
  });

  it("records disabled reasoning instead of dropping the setting", () => {
    const { home, status, stderr } = runPiConfigGenerator({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_REASONING: "false",
    });
    expect(status, stderr).toBe(0);
    expect(readManagedModel(home)).toEqual({
      id: "nvidia/nemotron-3-super-120b-a12b",
      reasoning: false,
    });
  });

  it.each([
    ["NEMOCLAW_MODEL", "   ", "NEMOCLAW_MODEL must not be empty."],
    [
      "NEMOCLAW_INFERENCE_API",
      "openai-responses",
      "NEMOCLAW_INFERENCE_API must be openai-completions for Pi.",
    ],
    [
      "NEMOCLAW_INFERENCE_BASE_URL",
      "https://user:secret@inference.local/v1",
      "NEMOCLAW_INFERENCE_BASE_URL must not include credentials.",
    ],
    ["NEMOCLAW_CONTEXT_WINDOW", "128k", "NEMOCLAW_CONTEXT_WINDOW must be a positive integer."],
    ["NEMOCLAW_MAX_TOKENS", "0", "NEMOCLAW_MAX_TOKENS must be a positive integer."],
    ["NEMOCLAW_REASONING", "yes", 'NEMOCLAW_REASONING must be "true" or "false".'],
  ])("rejects invalid %s input before it writes a catalog", (name, value, message) => {
    const { home, status, stderr } = runPiConfigGenerator({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      [name]: value,
    });
    expect(status).not.toBe(0);
    expect(stderr).toContain(message);
    expect(fs.existsSync(configPathForHome(home))).toBe(false);
  });
});
