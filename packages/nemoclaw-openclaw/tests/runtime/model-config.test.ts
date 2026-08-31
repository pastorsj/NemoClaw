// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { readOpenClawStartupSource } from "../helpers/startup-suite";

describe("runtime model override (#759)", () => {
  const src = readOpenClawStartupSource();

  function extractShellFunction(name: string): string {
    const match = src.match(new RegExp(`${name}\\(\\) \\{([\\s\\S]*?)^\\}`, "m"));
    if (!match) {
      throw new Error(`Expected ${name} in OpenClaw start.sh`);
    }
    return `${name}() {${match[1]}\n}`;
  }

  function runApplyModelOverride(env: Record<string, string> = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-model-override-"));
    const openclawDir = path.join(root, ".openclaw");
    fs.mkdirSync(openclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(openclawDir, "openclaw.json"),
      JSON.stringify({
        agents: { defaults: { model: { primary: "old-model" } } },
        models: {
          providers: {
            inference: {
              api: "openai-completions",
              models: [
                {
                  id: "old-model",
                  name: "old-model",
                  contextWindow: 1024,
                  maxTokens: 128,
                  reasoning: false,
                },
              ],
            },
          },
        },
      }),
    );
    const configPath = path.join(openclawDir, "openclaw.json");
    const hashPath = path.join(openclawDir, ".config-hash");
    fs.writeFileSync(hashPath, "oldhash\n");
    fs.chmodSync(openclawDir, 0o2770);
    fs.chmodSync(configPath, 0o660);
    fs.chmodSync(hashPath, 0o660);

    const helperFns = [
      extractShellFunction("openclaw_config_dir_owner"),
      extractShellFunction("prepare_openclaw_config_for_write"),
      extractShellFunction("restore_openclaw_config_after_write"),
    ]
      .join("\n")
      .replaceAll("/sandbox", root);
    const fn = extractShellFunction("apply_model_override").replaceAll("/sandbox", root);
    const wrapper = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "id() { echo 0; }",
      "chown() { return 0; }",
      `stat() { if [ "$1" = "-c" ] && [ "$2" = "%U" ] && [ "$3" = ${JSON.stringify(openclawDir)} ]; then echo sandbox; return 0; fi; command stat "$@"; }`,
      'relax_config_for_write() { chmod 644 "$@"; }',
      'lock_config_after_write() { chmod 444 "$@"; }',
      helperFns,
      fn,
      "apply_model_override",
    ].join("\n");
    const script = path.join(root, "run.sh");
    fs.writeFileSync(script, wrapper, { mode: 0o700 });
    const result = spawnSync("bash", [script], {
      encoding: "utf-8",
      env: { ...process.env, ...env },
    });
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const hash = fs.readFileSync(hashPath, "utf-8");
    const modes = {
      dir: fs.statSync(openclawDir).mode & 0o7777,
      config: fs.statSync(configPath).mode & 0o777,
      hash: fs.statSync(hashPath).mode & 0o777,
    };
    fs.rmSync(root, { recursive: true, force: true });
    return { result, config, hash, modes };
  }

  it("applies model, API, context, max-token, and reasoning overrides and recomputes the hash", () => {
    const { result, config, hash } = runApplyModelOverride({
      NEMOCLAW_MODEL_OVERRIDE: "new-model",
      NEMOCLAW_INFERENCE_API_OVERRIDE: "anthropic-messages",
      NEMOCLAW_CONTEXT_WINDOW: "4096",
      NEMOCLAW_MAX_TOKENS: "512",
      NEMOCLAW_REASONING: "true",
    });

    expect(result.status).toBe(0);
    expect(config.agents.defaults.model.primary).toBe("new-model");
    const provider = config.models.providers.inference;
    expect(provider.api).toBe("anthropic-messages");
    expect(provider.models[0]).toMatchObject({
      id: "new-model",
      name: "new-model",
      contextWindow: 4096,
      maxTokens: 512,
      reasoning: true,
    });
    expect(hash).toContain("openclaw.json");
  });

  it("restores mutable config permissions after successful overrides", () => {
    const { result, modes } = runApplyModelOverride({
      NEMOCLAW_MODEL_OVERRIDE: "new-model",
    });

    expect(result.status).toBe(0);
    expect(modes.dir).toBe(0o2770);
    expect(modes.config).toBe(0o660);
    expect(modes.hash).toBe(0o660);
  });

  it.each([
    {
      env: { NEMOCLAW_CONTEXT_WINDOW: "not-a-number" },
      message: "NEMOCLAW_CONTEXT_WINDOW must be a positive integer",
    },
    {
      env: { NEMOCLAW_CONTEXT_WINDOW: "0" },
      message: "NEMOCLAW_CONTEXT_WINDOW must be a positive integer",
    },
    {
      env: { NEMOCLAW_MAX_TOKENS: "not-a-number" },
      message: "NEMOCLAW_MAX_TOKENS must be a positive integer",
    },
    {
      env: { NEMOCLAW_MAX_TOKENS: "0" },
      message: "NEMOCLAW_MAX_TOKENS must be a positive integer",
    },
    {
      env: { NEMOCLAW_REASONING: "maybe" },
      message: 'NEMOCLAW_REASONING must be "true" or "false"',
    },
    {
      env: { NEMOCLAW_INFERENCE_API_OVERRIDE: "unexpected-api" },
      message: 'must be "openai-completions" or "anthropic-messages"',
    },
  ])("treats invalid supplemental overrides as atomic no-ops [case %#]", ({ env, message }) => {
    const { result, config, hash } = runApplyModelOverride({
      NEMOCLAW_MODEL_OVERRIDE: "new-model",
      ...env,
    });

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(message);
    expect(config.agents.defaults.model.primary).toBe("old-model");
    expect(config.models.providers.inference.api).toBe("openai-completions");
    expect(config.models.providers.inference.models[0]).toMatchObject({
      id: "old-model",
      name: "old-model",
      contextWindow: 1024,
      maxTokens: 128,
      reasoning: false,
    });
    expect(hash).toBe("oldhash\n");
  });
});

describe("runtime CORS origin override (#719)", () => {
  const src = readOpenClawStartupSource();

  function extractShellFunction(name: string): string {
    const match = src.match(new RegExp(`${name}\\(\\) \\{([\\s\\S]*?)^\\}`, "m"));
    if (!match) {
      throw new Error(`Expected ${name} in OpenClaw start.sh`);
    }
    return `${name}() {${match[1]}\n}`;
  }

  function runApplyCorsOverride(origin: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cors-override-"));
    const openclawDir = path.join(root, ".openclaw");
    fs.mkdirSync(openclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(openclawDir, "openclaw.json"),
      JSON.stringify({ gateway: { controlUi: { allowedOrigins: ["http://127.0.0.1:18789"] } } }),
    );
    const configPath = path.join(openclawDir, "openclaw.json");
    const hashPath = path.join(openclawDir, ".config-hash");
    fs.writeFileSync(hashPath, "oldhash\n");
    fs.chmodSync(openclawDir, 0o2770);
    fs.chmodSync(configPath, 0o660);
    fs.chmodSync(hashPath, 0o660);

    const helperFns = [
      extractShellFunction("openclaw_config_dir_owner"),
      extractShellFunction("prepare_openclaw_config_for_write"),
      extractShellFunction("restore_openclaw_config_after_write"),
    ]
      .join("\n")
      .replaceAll("/sandbox", root);
    const fn = extractShellFunction("apply_cors_override").replaceAll("/sandbox", root);
    const script = path.join(root, "run.sh");
    fs.writeFileSync(
      script,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "id() { echo 0; }",
        "chown() { return 0; }",
        `stat() { if [ "$1" = "-c" ] && [ "$2" = "%U" ] && [ "$3" = ${JSON.stringify(openclawDir)} ]; then echo sandbox; return 0; fi; command stat "$@"; }`,
        'relax_config_for_write() { chmod 644 "$@"; }',
        'lock_config_after_write() { chmod 444 "$@"; }',
        helperFns,
        fn,
        "apply_cors_override",
      ].join("\n"),
      { mode: 0o700 },
    );
    const result = spawnSync("bash", [script], {
      encoding: "utf-8",
      env: { ...process.env, NEMOCLAW_CORS_ORIGIN: origin },
    });
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const hash = fs.readFileSync(hashPath, "utf-8");
    fs.rmSync(root, { recursive: true, force: true });
    return { result, config, hash };
  }

  it("adds valid CORS origins and recomputes the config hash", () => {
    const { result, config, hash } = runApplyCorsOverride("https://chat.example.test");
    expect(result.status).toBe(0);
    expect(config.gateway.controlUi.allowedOrigins).toContain("https://chat.example.test");
    expect(hash).toContain("openclaw.json");
  });

  it("rejects invalid CORS origins without mutating config", () => {
    const { result, config } = runApplyCorsOverride("javascript:alert(1)");
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("must start with http:// or https://");
    expect(config.gateway.controlUi.allowedOrigins).toEqual(["http://127.0.0.1:18789"]);
  });
});
