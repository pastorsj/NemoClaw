// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MessagingBuildPhase } from "../../../src/lib/messaging/applier/build/messaging-build-applier.mts";
import { withLegacyMessagingPlanEnvDirect } from "../../messaging-plan-test-helper";

beforeEach(() => {
  vi.clearAllMocks();
});

const SCRIPT_PATH = path.join(
  import.meta.dirname,
  "../../..",
  "src",
  "lib",
  "messaging",
  "applier",
  "build",
  "messaging-build-applier.mts",
);
const TEST_PATH = process.env.PATH || "/usr/bin:/bin";
const BASE_GENERATOR_ENV: Record<string, string> = {
  NEMOCLAW_MODEL: "test-model",
  NEMOCLAW_PROVIDER_KEY: "test-provider",
  NEMOCLAW_PRIMARY_MODEL_REF: "test-ref",
  CHAT_UI_URL: "http://127.0.0.1:18789",
  NEMOCLAW_INFERENCE_BASE_URL: "http://localhost:8080",
  NEMOCLAW_INFERENCE_API: "openai",
  NEMOCLAW_INFERENCE_COMPAT_B64: Buffer.from("{}").toString("base64"),
  NEMOCLAW_PROXY_HOST: "10.200.0.1",
  NEMOCLAW_PROXY_PORT: "3128",
  NEMOCLAW_CONTEXT_WINDOW: "131072",
  NEMOCLAW_MAX_TOKENS: "4096",
  NEMOCLAW_REASONING: "false",
  NEMOCLAW_AGENT_TIMEOUT: "600",
};

function channelsB64(channels: string[]): string {
  return Buffer.from(JSON.stringify(channels)).toString("base64");
}

function runApplierProcess(
  env: Record<string, string>,
  agent: "hermes" | "openclaw",
  phase: MessagingBuildPhase,
  managedStartupRuntime = false,
) {
  return spawnSync(
    "node",
    [
      "--experimental-strip-types",
      SCRIPT_PATH,
      "--agent",
      agent,
      "--phase",
      phase,
      ...(managedStartupRuntime ? ["--managed-startup-runtime"] : []),
    ],
    {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env,
      timeout: 10_000,
    },
  );
}

describe("messaging build post-agent-install rendering", () => {
  it("keeps doctor rerendering while managed startup skips the broad doctor", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-doctor-rewrite-"));
    const tracePath = path.join(tmp, "openclaw.trace");
    const fakeOpenclaw = path.join(tmp, "openclaw");
    const channels = channelsB64(["telegram", "discord", "slack", "wechat"]);
    const wechatConfig = Buffer.from(
      JSON.stringify({ accountId: "primary", baseUrl: "https://ilinkai.wechat.com", userId: "u1" }),
    ).toString("base64");

    fs.writeFileSync(
      fakeOpenclaw,
      [
        "#!/usr/bin/env node",
        'const fs = require("fs");',
        'const path = require("path");',
        "const args = process.argv.slice(2);",
        'fs.appendFileSync(process.env.OPENCLAW_TRACE, args.join("|") + String.fromCharCode(10));',
        'if (args[0] !== "doctor" || args[1] !== "--fix" || args[2] !== "--non-interactive") process.exit(46);',
        'const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");',
        'const config = JSON.parse(fs.readFileSync(configPath, "utf8"));',
        "if (config.channels?.telegram?.accounts?.default?.botToken !== undefined) process.exit(40);",
        "if (config.channels?.discord?.enabled !== true) process.exit(41);",
        "if (config.plugins?.entries?.discord?.enabled !== true) process.exit(42);",
        "if (config.plugins?.entries?.slack?.enabled !== true) process.exit(43);",
        'if (config.channels?.["openclaw-weixin"]?.accounts?.primary?.enabled !== true) process.exit(44);',
        'fs.writeFileSync(configPath, JSON.stringify({ channels: { telegram: { accounts: { default: { botToken: "openshell:resolve:env:v42_TELEGRAM_BOT_TOKEN" } } } }, plugins: { entries: {} } }, null, 2) + String.fromCharCode(10));',
        "process.exit(0);",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const env = await withLegacyMessagingPlanEnvDirect(
        {
          PATH: `${tmp}:${TEST_PATH}`,
          HOME: tmp,
          OPENCLAW_TRACE: tracePath,
          ...BASE_GENERATOR_ENV,
          NEMOCLAW_MESSAGING_CHANNELS_B64: channels,
          NEMOCLAW_WECHAT_CONFIG_B64: wechatConfig,
          NEMOCLAW_OPENCLAW_MANAGED_PROXY: "0",
        },
        "openclaw",
      );
      const postInstallResult = runApplierProcess(env, "openclaw", "post-agent-install");
      expect(postInstallResult.status, postInstallResult.stderr).toBe(0);
      expect(fs.readFileSync(tracePath, "utf-8").trim()).toBe("doctor|--fix|--non-interactive");

      const config = JSON.parse(
        fs.readFileSync(path.join(tmp, ".openclaw", "openclaw.json"), "utf-8"),
      );
      expect(config.channels?.telegram?.accounts?.default).toMatchObject({
        botToken: "openshell:resolve:env:v42_TELEGRAM_BOT_TOKEN",
        enabled: true,
      });
      expect(config.channels?.discord?.enabled).toBe(true);
      expect(config.plugins?.entries?.discord).toEqual({ enabled: true });
      expect(config.channels?.slack?.enabled).toBe(true);
      expect(config.plugins?.entries?.slack).toEqual({ enabled: true });
      expect(config.channels?.["openclaw-weixin"]?.accounts?.primary).toEqual({ enabled: true });
      expect(config.channels?.wechat).toBeUndefined();

      fs.writeFileSync(
        path.join(tmp, ".openclaw", "openclaw.json"),
        `${JSON.stringify({ channels: {}, plugins: { entries: {} } }, null, 2)}\n`,
      );
      fs.writeFileSync(tracePath, "");
      const managedResult = runApplierProcess(env, "openclaw", "post-agent-install", true);
      expect(managedResult.status, managedResult.stderr).toBe(0);
      expect(fs.readFileSync(tracePath, "utf-8")).toBe("");
      const managedConfig = JSON.parse(
        fs.readFileSync(path.join(tmp, ".openclaw", "openclaw.json"), "utf-8"),
      );
      expect(managedConfig.channels?.telegram?.accounts?.default).toMatchObject({
        enabled: true,
      });
      expect(managedConfig.channels?.telegram?.accounts?.default?.botToken).toBeUndefined();
      expect(managedConfig.channels?.discord?.enabled).toBe(true);
      expect(managedConfig.plugins?.entries?.discord).toEqual({ enabled: true });
      expect(managedConfig.channels?.slack?.enabled).toBe(true);
      expect(managedConfig.plugins?.entries?.slack).toEqual({ enabled: true });
      expect(managedConfig.channels?.["openclaw-weixin"]?.accounts?.primary).toEqual({
        enabled: true,
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("applies post-agent-install WeChat build files from the compiled messaging plan", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-post-agent-install-"));
    const channels = channelsB64(["wechat"]);
    const wechatConfig = Buffer.from(
      JSON.stringify({ accountId: "primary", baseUrl: "https://ilinkai.wechat.com", userId: "u1" }),
    ).toString("base64");

    try {
      const env = await withLegacyMessagingPlanEnvDirect(
        {
          PATH: `${tmp}:${TEST_PATH}`,
          HOME: tmp,
          ...BASE_GENERATOR_ENV,
          NEMOCLAW_MESSAGING_CHANNELS_B64: channels,
          NEMOCLAW_WECHAT_CONFIG_B64: wechatConfig,
          NEMOCLAW_OPENCLAW_MANAGED_PROXY: "0",
        },
        "openclaw",
      );
      fs.writeFileSync(path.join(tmp, "openclaw"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const postInstallResult = runApplierProcess(env, "openclaw", "post-agent-install");
      expect(postInstallResult.status, postInstallResult.stderr).toBe(0);

      const config = JSON.parse(
        fs.readFileSync(path.join(tmp, ".openclaw", "openclaw.json"), "utf-8"),
      );
      expect(config.plugins?.installs?.["openclaw-weixin"]).toEqual({
        source: "npm",
        spec: "@tencent-weixin/openclaw-weixin@2.4.3",
        installPath: "/sandbox/.openclaw/extensions/openclaw-weixin",
      });
      expect(config.plugins?.load?.paths ?? []).not.toContain(
        "/sandbox/.openclaw/extensions/openclaw-weixin",
      );
      expect(config.channels?.["openclaw-weixin"]?.accounts?.primary).toEqual({ enabled: true });
      expect(config.channels?.wechat).toBeUndefined();

      const account = JSON.parse(
        fs.readFileSync(
          path.join(tmp, ".openclaw", "openclaw-weixin", "accounts", "primary.json"),
          "utf-8",
        ),
      );
      expect(account).toMatchObject({
        token: "openshell:resolve:env:WECHAT_BOT_TOKEN",
        baseUrl: "https://ilinkai.wechat.com",
        userId: "u1",
      });
      expect(
        JSON.parse(
          fs.readFileSync(path.join(tmp, ".openclaw", "openclaw-weixin", "accounts.json"), "utf-8"),
        ),
      ).toEqual(["primary"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("applies Hermes messaging render to config.yaml and .env in post-agent-install", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-render-"));
    try {
      const hermesDir = path.join(tmp, ".hermes");
      fs.mkdirSync(hermesDir, { recursive: true });
      fs.writeFileSync(
        path.join(hermesDir, "config.yaml"),
        [
          "# Managed by NemoClaw - Hermes configuration",
          "# Upstream provider: openai",
          "# OpenShell rewrites model.base_url to the upstream endpoint at request time.",
          "_config_version: 12",
          "platform_toolsets:",
          "  api_server:",
          "  - web",
          "platforms:",
          "  api_server:",
          "    enabled: true",
          "",
        ].join("\n"),
      );
      fs.writeFileSync(path.join(hermesDir, ".env"), "API_SERVER_PORT=18642\n");
      const env = await withLegacyMessagingPlanEnvDirect(
        {
          PATH: TEST_PATH,
          HOME: tmp,
          NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["telegram"]),
        },
        "hermes",
      );
      const postInstallResult = runApplierProcess(env, "hermes", "post-agent-install");
      expect(postInstallResult.status, postInstallResult.stderr).toBe(0);
      const configYaml = fs.readFileSync(path.join(hermesDir, "config.yaml"), "utf-8");
      expect(configYaml).toContain("telegram:");
      expect(configYaml).toContain("enabled: true");
      const envFile = fs.readFileSync(path.join(hermesDir, ".env"), "utf-8");
      expect(envFile).toContain("API_SERVER_PORT=18642\n");
      expect(envFile).not.toContain("TELEGRAM_BOT_TOKEN=");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
