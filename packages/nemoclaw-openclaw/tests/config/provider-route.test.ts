// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildConfig } from "../../config/generate-config.mts";
import {
  extractShellFunctionFromSource,
  readOpenClawStartupSource,
} from "../helpers/startup-suite";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("inference provider route identifier rename (#7177)", () => {
  it("falls back to the legacy route identifier when the new value is blank", () => {
    const config = buildConfig({
      NEMOCLAW_MODEL: "test-model",
      NEMOCLAW_PRIMARY_MODEL_REF: "test-ref",
      NEMOCLAW_INFERENCE_PROVIDER_ID: "",
      NEMOCLAW_PROVIDER_KEY: "openai",
      NEMOCLAW_INFERENCE_BASE_URL: "https://api.openai.com/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
      NEMOCLAW_INFERENCE_COMPAT_B64: Buffer.from("{}").toString("base64"),
    });

    expect(config).toHaveProperty("models.providers.openai");
    expect(
      Object.keys((config.models as { providers: Record<string, unknown> }).providers),
    ).toEqual(["openai"]);
  });
});

describe("write_auth_profile route identifier migration (#7177)", () => {
  const startupSource = readOpenClawStartupSource();
  const wrapper = [
    "set -euo pipefail",
    extractShellFunctionFromSource(startupSource, "openclaw_config_dir_owner"),
    extractShellFunctionFromSource(startupSource, "write_auth_profile"),
    "write_auth_profile",
  ].join("\n");

  function runWriteAuthProfile(env: Record<string, string>): {
    home: string;
    authPath: string;
    status: number;
    stderr: string;
  } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-provider-id-auth-"));
    temporaryDirectories.push(home);
    const result = spawnSync("bash", ["-s"], {
      input: wrapper,
      env: { PATH: process.env.PATH, HOME: home, ...env },
      encoding: "utf-8",
    });
    return {
      home,
      authPath: path.join(home, ".openclaw", "agents", "main", "agent", "auth-profiles.json"),
      status: result.status ?? -1,
      stderr: result.stderr ?? "",
    };
  }

  it("reads the legacy NEMOCLAW_PROVIDER_KEY when NEMOCLAW_INFERENCE_PROVIDER_ID is unset", () => {
    const { authPath, status, stderr } = runWriteAuthProfile({
      NVIDIA_INFERENCE_API_KEY: "secret",
      NEMOCLAW_PROVIDER_KEY: "openai",
    });
    expect(status, stderr).toBe(0);
    const profile = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    expect(profile).toHaveProperty("openai:manual");
    expect(profile["openai:manual"].provider).toBe("openai");
  });

  it("prefers NEMOCLAW_INFERENCE_PROVIDER_ID over the legacy NEMOCLAW_PROVIDER_KEY", () => {
    const { authPath, status, stderr } = runWriteAuthProfile({
      NVIDIA_INFERENCE_API_KEY: "secret",
      NEMOCLAW_INFERENCE_PROVIDER_ID: "openai",
      NEMOCLAW_PROVIDER_KEY: "anthropic",
    });
    expect(status, stderr).toBe(0);
    const profile = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    expect(profile).toHaveProperty("openai:manual");
    expect(profile).not.toHaveProperty("anthropic:manual");
  });
});
