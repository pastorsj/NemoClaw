// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Functional tests run the package script with controlled environment values
// and assert on the generated openclaw.json output.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConfig, buildOpenClawFabricConfig, main } from "../../config/generate-config.mts";
import {
  applyMessagingAgentRenderToObject,
  applyMessagingBuildPhase,
  readMessagingBuildPlanFromEnv,
} from "../../../../src/lib/messaging/applier/build/messaging-build-applier.mts";
import { withLegacyMessagingPlanEnvDirect } from "../../../../test/messaging-plan-test-helper";
import type { HarnessMessagingAdapterModule } from "@nvidia/nemoclaw-harness-contract";
import { baseOpenClawGenerationEnv, buildOpenClawTestEnv } from "../helpers/env-fixture";
import { loadPackageHostModule } from "../helpers/host-module";
const OPENCLAW_PACKAGE = path.resolve(import.meta.dirname, "../..");
const SCRIPT_PATH = path.join(OPENCLAW_PACKAGE, "config/generate-config.mts");
const SCRIPT_ARGS = ["--experimental-strip-types", SCRIPT_PATH];

/** Minimal env vars required for a valid config generation run. */
const BASE_ENV = baseOpenClawGenerationEnv();
const STRUCTURED_TOOL_SEARCH = { mode: "tools", searchDefaultLimit: 8, maxSearchLimit: 20 };

let tmpDir: string;

const buildTestEnv = (envOverrides: Record<string, string> = {}): Record<string, string> =>
  buildOpenClawTestEnv(tmpDir, BASE_ENV, envOverrides);

const CHANNELS_ENV = "NEMOCLAW_MESSAGING_CHANNELS_B64";
const OPENCLAW_MESSAGING_INTEGRATION = loadPackageHostModule<HarnessMessagingAdapterModule>(
  "messaging-adapter.cts",
).describeMessagingIntegration({ packageId: "openclaw" });
if (OPENCLAW_MESSAGING_INTEGRATION.kind !== "channels") {
  throw new Error("OpenClaw messaging test fixture must be enabled");
}
const OPENCLAW_MESSAGING_BUILD_PROFILE = OPENCLAW_MESSAGING_INTEGRATION.build;

function withOpenClawMessagingBuildProfile(env: Record<string, string>): Record<string, string> {
  const encodedPlan = env.NEMOCLAW_MESSAGING_PLAN_B64;
  if (!encodedPlan) return env;
  const plan = JSON.parse(Buffer.from(encodedPlan, "base64").toString("utf8")) as Record<
    string,
    unknown
  >;
  return {
    ...env,
    NEMOCLAW_MESSAGING_PLAN_B64: Buffer.from(
      JSON.stringify({ ...plan, packageBuild: OPENCLAW_MESSAGING_BUILD_PROFILE }),
    ).toString("base64"),
  };
}

const messagingEnv = (channels: string, env: Record<string, string> = {}) =>
  withLegacyMessagingPlanEnvDirect(
    buildTestEnv({ ...env, [CHANNELS_ENV]: channels }),
    "openclaw",
  ).then(withOpenClawMessagingBuildProfile);

function runConfigScriptRaw(envOverrides: Record<string, string> = {}) {
  const env = buildTestEnv(envOverrides);
  const result = spawnSync("node", SCRIPT_ARGS, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env,
    timeout: 10_000,
  });
  return result;
}

function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const originalEnv = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, env);
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  }
}

function withConfigEnv<T>(envOverrides: Record<string, string>, fn: () => T): T {
  return withEnv(buildTestEnv(envOverrides), fn);
}

function runMessagingPostInstall(env: Record<string, string>): void {
  withEnv(env, () =>
    applyMessagingBuildPhase(
      readMessagingBuildPlanFromEnv(env, "openclaw"),
      "post-agent-install",
      env,
    ),
  );
}

function runConfigScript(envOverrides: Record<string, string> = {}): any {
  const env = buildTestEnv(envOverrides);
  withEnv(env, () => main());
  runMessagingPostInstall(env);
  const configPath = path.join(tmpDir, ".openclaw", "openclaw.json");
  return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

const runMessagingConfig = async (channels: string, env: Record<string, string> = {}) =>
  runConfigScript(await messagingEnv(channels, env));

function runConfigSubprocess(envOverrides: Record<string, string> = {}): any {
  const env = buildTestEnv(envOverrides);
  const result = spawnSync("node", SCRIPT_ARGS, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env,
    timeout: 10_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `Script failed (exit ${result.status}):
stdout: ${result.stdout}
stderr: ${result.stderr}`,
    );
  }
  runMessagingPostInstall(env);

  const configPath = path.join(tmpDir, ".openclaw", "openclaw.json");
  return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

function buildBaseConfigDirect(envOverrides: Record<string, string> = {}): any {
  return withConfigEnv(envOverrides, () => buildConfig());
}

const buildMessagingBaseConfig = async (channels: string, env: Record<string, string> = {}) =>
  buildBaseConfigDirect(await messagingEnv(channels, env));

function buildConfigDirect(envOverrides: Record<string, string> = {}): any {
  const env = buildTestEnv(envOverrides);
  return withEnv(env, () => {
    const config = buildConfig();
    applyMessagingAgentRenderToObject(
      config,
      readMessagingBuildPlanFromEnv(env, "openclaw"),
      "openclaw.json",
    );
    return config;
  });
}

const buildMessagingConfig = async (channels: string, env: Record<string, string> = {}) =>
  buildConfigDirect(await messagingEnv(channels, env));

function expectBuildConfigError(envOverrides: Record<string, string>, message: string | RegExp) {
  expect(() => buildConfigDirect(envOverrides)).toThrow(message);
}

function runCapturingConsoleError<T>(fn: () => T): { result: T; stderr: string } {
  const original = console.error;
  const messages: string[] = [];
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };
  try {
    return { result: fn(), stderr: messages.join("\n") };
  } finally {
    console.error = original;
  }
}

function writeWeChatPluginMetadata(manifest: Record<string, unknown>) {
  const pluginDir = path.join(tmpDir, ".openclaw", "extensions", "openclaw-weixin");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "openclaw.plugin.json"), JSON.stringify(manifest, null, 2));
}

function writeWeChatNpmPackageMetadata(manifest: Record<string, unknown>) {
  const pluginDir = path.join(
    tmpDir,
    ".openclaw",
    "npm",
    "node_modules",
    "@tencent-weixin",
    "openclaw-weixin",
  );
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "package.json"), JSON.stringify(manifest, null, 2));
}

function writeWeChatNpmPluginMetadata(manifest: Record<string, unknown>) {
  const pluginDir = path.join(
    tmpDir,
    ".openclaw",
    "npm",
    "node_modules",
    "@tencent-weixin",
    "openclaw-weixin",
  );
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "openclaw.plugin.json"), JSON.stringify(manifest, null, 2));
}

function wechatExtensionPath(stateDir = path.join(tmpDir, ".openclaw")) {
  return path.join(fs.realpathSync(stateDir), "extensions", "openclaw-weixin");
}

function writeRegistryManifest(
  blueprintDir: string,
  relativeManifestPath: string,
  manifest: Record<string, unknown>,
): string {
  const manifestPath = path.join(blueprintDir, "model-specific-setup", relativeManifestPath);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return path.join(blueprintDir, "model-specific-setup");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-config-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("generate-openclaw-config.mts: config generation", () => {
  it("generates valid JSON with minimal env vars", () => {
    const config = runConfigScript();
    expect(config).toBeDefined();
    expect(config.gateway).toBeDefined();
    expect(config.models).toBeDefined();
    expect(config.agents).toBeDefined();
  });

  it("runs as a node --experimental-strip-types executable", () => {
    const config = runConfigSubprocess();
    expect(config.gateway).toBeDefined();
    expect(config.models).toBeDefined();
  });

  it("writes the credential-free Fabric adapter selection beside OpenClaw config", () => {
    runConfigScript();
    const fabricPath = path.join(tmpDir, ".openclaw", "fabric.json");
    const fabric = JSON.parse(fs.readFileSync(fabricPath, "utf-8"));

    expect(fabric).toEqual(buildOpenClawFabricConfig());
    expect(fabric.harness).toEqual({
      adapter_id: "nvidia.nemoclaw.openclaw",
      resolution: "preinstalled",
    });
    expect(fabric.environment.workspace).toBe("/sandbox");
    expect(fabric.models).toBeUndefined();
    expect(JSON.stringify(fabric)).not.toMatch(/api[_-]?key|token|credential/iu);
    expect(fs.statSync(fabricPath).mode & 0o777).toBe(0o600);
  });

  it("keeps OpenClaw OTEL diagnostics disabled by default", () => {
    const config = runConfigScript();
    expect(config.diagnostics).toBeUndefined();
    expect(config.plugins.entries["diagnostics-otel"]).toBeUndefined();
  });

  it("enables traces-only OpenClaw OTEL diagnostics when requested", () => {
    const config = buildConfigDirect({
      NEMOCLAW_OPENCLAW_OTEL: "1",
      NEMOCLAW_OPENCLAW_OTEL_ENDPOINT: "http://host.openshell.internal:4318",
      NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME: "nemoclaw-local",
      NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE: "0.5",
    });

    expect(config.plugins.entries["diagnostics-otel"]).toEqual({ enabled: true });
    expect(config.diagnostics).toEqual({
      enabled: true,
      otel: {
        enabled: true,
        endpoint: "http://host.openshell.internal:4318",
        protocol: "http/protobuf",
        serviceName: "nemoclaw-local",
        traces: true,
        metrics: false,
        logs: false,
        sampleRate: 0.5,
      },
    });
    expect(config.diagnostics.otel.captureContent).toBeUndefined();
  });

  it("rejects OTEL endpoints with embedded credentials", () => {
    const result = runConfigScriptRaw({
      NEMOCLAW_OPENCLAW_OTEL: "1",
      NEMOCLAW_OPENCLAW_OTEL_ENDPOINT: "http://token@example.com:4318",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("NEMOCLAW_OPENCLAW_OTEL_ENDPOINT must not include credentials");
  });

  it("sets dangerouslyDisableDeviceAuth to false for loopback URL", () => {
    const config = runConfigScript({ CHAT_UI_URL: "http://127.0.0.1:18789" });
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(false);
  });

  it("treats loopback-looking URL userinfo before a remote host as remote", () => {
    const config = buildConfigDirect({ CHAT_UI_URL: "http://127.0.0.1:18789@evil.example" });
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(true);
    expect(config.gateway.controlUi.allowedOrigins).toContain("http://evil.example");
    expect(config.gateway.controlUi.allowedOrigins).not.toContain(
      "http://127.0.0.1:18789@evil.example",
    );
  });

  it("treats localhost userinfo before a remote host as remote", () => {
    const config = buildConfigDirect({ CHAT_UI_URL: "http://localhost@evil.example" });
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(true);
    expect(config.gateway.controlUi.allowedOrigins).toContain("http://evil.example");
  });

  it("sets dangerouslyDisableDeviceAuth to true when env var is '1'", () => {
    const config = runConfigScript({ NEMOCLAW_DISABLE_DEVICE_AUTH: "1" });
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(true);
  });

  it("sets allowInsecureAuth to true for http scheme", () => {
    const config = runConfigScript({ CHAT_UI_URL: "http://127.0.0.1:18789" });
    expect(config.gateway.controlUi.allowInsecureAuth).toBe(true);
  });

  it("sets allowInsecureAuth to false for https scheme", () => {
    const config = runConfigScript({ CHAT_UI_URL: "https://nemoclaw0-xxx.brevlab.com:18789" });
    expect(config.gateway.controlUi.allowInsecureAuth).toBe(false);
  });

  it("falls back to text input when NEMOCLAW_INFERENCE_INPUTS is empty", () => {
    const config = runConfigScript({ NEMOCLAW_INFERENCE_INPUTS: "" });
    expect(config.models.providers["test-provider"].models[0].input).toEqual(["text"]);
  });

  it("includes non-loopback origin in allowedOrigins", () => {
    const config = runConfigScript({
      CHAT_UI_URL: "https://nemoclaw0-xxx.brevlab.com:18789",
    });
    expect(config.gateway.controlUi.allowedOrigins).toContain("http://127.0.0.1:18789");
    expect(config.gateway.controlUi.allowedOrigins).toContain(
      "https://nemoclaw0-xxx.brevlab.com:18789",
    );
    expect(config.gateway.controlUi.allowedOrigins).toContain("https://nemoclaw0-xxx.brevlab.com");
  });

  it("includes only loopback origin for loopback URL", () => {
    const config = runConfigScript({ CHAT_UI_URL: "http://127.0.0.1:18789" });
    expect(config.gateway.controlUi.allowedOrigins).toEqual(["http://127.0.0.1:18789"]);
  });

  it("emits gateway.port from a non-default CHAT_UI_URL port (#3256)", () => {
    const config = runConfigScript({ CHAT_UI_URL: "http://127.0.0.1:18790" });
    expect(config.gateway.port).toBe(18790);
    expect(config.gateway.controlUi.allowedOrigins).toEqual(["http://127.0.0.1:18790"]);
  });

  it("lets NEMOCLAW_DASHBOARD_PORT drive gateway.port when set (#3256)", () => {
    const config = runConfigScript({
      CHAT_UI_URL: "",
      NEMOCLAW_DASHBOARD_PORT: "18790",
    });
    expect(config.gateway.port).toBe(18790);
    expect(config.gateway.controlUi.allowedOrigins).toEqual(["http://127.0.0.1:18790"]);
  });

  it("rejects an invalid NEMOCLAW_DASHBOARD_PORT", () => {
    expectBuildConfigError(
      { NEMOCLAW_DASHBOARD_PORT: "18790x" },
      /NEMOCLAW_DASHBOARD_PORT.*1024 and 65535/,
    );
  });

  it("rejects an out-of-range NEMOCLAW_DASHBOARD_PORT", () => {
    expectBuildConfigError(
      { NEMOCLAW_DASHBOARD_PORT: "80" },
      /NEMOCLAW_DASHBOARD_PORT.*1024 and 65535/,
    );
  });

  it("falls back to the default gateway port when CHAT_UI_URL uses a reserved port", () => {
    const config = buildConfigDirect({ CHAT_UI_URL: "http://127.0.0.1:81" });
    expect(config.gateway.port).toBe(18789);
    expect(config.gateway.controlUi.allowedOrigins).toEqual([
      "http://127.0.0.1:18789",
      "http://127.0.0.1:81",
    ]);
  });

  it("normalizes schemeless CHAT_UI_URL values before parsing", () => {
    const config = buildConfigDirect({ CHAT_UI_URL: "remote.example:18790" });
    expect(config.gateway.port).toBe(18790);
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(true);
    expect(config.gateway.controlUi.allowedOrigins).toContain("http://remote.example:18790");
    expect(config.gateway.controlUi.allowedOrigins).toContain("http://remote.example");
  });

  it("includes a portless origin for reverse-proxy access (#3000)", () => {
    const config = runConfigScript({
      CHAT_UI_URL: "https://nemoclaw0-abc123.brevlab.com:18789",
    });
    const origins = config.gateway.controlUi.allowedOrigins;
    expect(origins).toContain("https://nemoclaw0-abc123.brevlab.com:18789");
    expect(origins).toContain("https://nemoclaw0-abc123.brevlab.com");
  });

  it("preserves brackets in portless origin for public IPv6 addresses", () => {
    const config = runConfigScript({
      CHAT_UI_URL: "https://[2606:4700::1]:18789",
    });
    const origins = config.gateway.controlUi.allowedOrigins;
    expect(origins).toContain("https://[2606:4700::1]:18789");
    expect(origins).toContain("https://[2606:4700::1]");
  });

  it("does not add portless origin for IPv6 loopback", () => {
    const config = runConfigScript({
      CHAT_UI_URL: "http://[::1]:18789",
    });
    const origins = config.gateway.controlUi.allowedOrigins;
    expect(origins).toContain("http://[::1]:18789");
    expect(origins).not.toContain("http://[::1]");
  });

  it("does not crash on malformed port in CHAT_UI_URL", () => {
    const config = runConfigScript({
      CHAT_UI_URL: "https://ilinkai.wechat.com.com:abc",
    });
    const origins = config.gateway.controlUi.allowedOrigins;
    expect(origins).toContain("http://127.0.0.1:18789");
    expect(origins).not.toContain("https://ilinkai.wechat.com.com");
  });

  it("leaves messaging render to the messaging build applier", async () => {
    const channels = Buffer.from(JSON.stringify(["telegram"])).toString("base64");
    const config = await buildMessagingBaseConfig(channels);
    expect(config.channels.telegram).toBeUndefined();
  });

  it("parses messaging channels from base64", async () => {
    const channels = Buffer.from(JSON.stringify(["telegram"])).toString("base64");
    const config = await runMessagingConfig(channels);
    expect(config.channels).toBeDefined();
    expect(config.channels.telegram).toBeDefined();
  });

  it("emits a tokenless WhatsApp config block for QR-paired channels", async () => {
    const channels = Buffer.from(JSON.stringify(["whatsapp"])).toString("base64");
    const config = await buildMessagingConfig(channels);
    expect(config.channels.whatsapp).toBeDefined();
    expect(config.channels.whatsapp.enabled).toBe(true);
    expect(config.plugins.entries.whatsapp).toEqual({ enabled: true });
    const account = config.channels.whatsapp.accounts.default;
    expect(account.enabled).toBe(true);
    expect(account.healthMonitor).toEqual({ enabled: false });
    expect(account.token).toBeUndefined();
    expect(account.botToken).toBeUndefined();
    expect(account.appToken).toBeUndefined();
  });

  it("keeps WhatsApp config alongside token-based channels in the same run", async () => {
    const channels = Buffer.from(JSON.stringify(["telegram", "whatsapp"])).toString("base64");
    const config = await buildMessagingConfig(channels);
    expect(config.channels.telegram.enabled).toBe(true);
    expect(config.plugins.entries.telegram).toEqual({ enabled: true });
    expect(config.channels.telegram.accounts.default.botToken).toBeUndefined();
    expect(config.channels.whatsapp.enabled).toBe(true);
    expect(config.plugins.entries.whatsapp).toEqual({ enabled: true });
    expect(config.channels.whatsapp.accounts.default.enabled).toBe(true);
    expect(config.channels.whatsapp.accounts.default.botToken).toBeUndefined();
  });

  it("emits groups with requireMention when TELEGRAM_REQUIRE_MENTION is true (#3022)", async () => {
    const channels = Buffer.from(JSON.stringify(["telegram"])).toString("base64");
    const telegramConfig = Buffer.from(JSON.stringify({ requireMention: true })).toString("base64");
    const config = await runMessagingConfig(channels, {
      NEMOCLAW_TELEGRAM_CONFIG_B64: telegramConfig,
    });
    expect(config.channels.telegram.accounts.default.groupPolicy).toBe("open");
    expect(config.channels.telegram.groups).toEqual({ "*": { requireMention: true } });
  });

  it("keeps groupPolicy open with no groups stanza when requireMention is false (#3022)", async () => {
    const channels = Buffer.from(JSON.stringify(["telegram"])).toString("base64");
    const telegramConfig = Buffer.from(JSON.stringify({ requireMention: false })).toString(
      "base64",
    );
    const config = await runMessagingConfig(channels, {
      NEMOCLAW_TELEGRAM_CONFIG_B64: telegramConfig,
    });
    expect(config.channels.telegram.accounts.default.groupPolicy).toBe("open");
    expect(config.channels.telegram.groups).toBeUndefined();
  });

  it("defaults Telegram group replies to require mentions when telegramConfig is empty (#3022)", async () => {
    const channels = Buffer.from(JSON.stringify(["telegram"])).toString("base64");
    const config = await runMessagingConfig(channels);
    expect(config.channels.telegram.accounts.default.groupPolicy).toBe("open");
    expect(config.channels.telegram.groups).toEqual({ "*": { requireMention: true } });
  });

  it("emits OpenClaw-valid Discord guild allowlist config when guilds are provided", async () => {
    const channels = Buffer.from(JSON.stringify(["discord"])).toString("base64");
    const legacyGuilds = { "1234567890": { enabled: true, requireMention: true } };
    const config = await buildMessagingConfig(channels, {
      NEMOCLAW_DISCORD_GUILDS_B64: Buffer.from(JSON.stringify(legacyGuilds)).toString("base64"),
    });

    expect(config.channels.discord.groupPolicy).toBe("allowlist");
    expect(config.channels.discord.guilds).toEqual({
      "1234567890": { requireMention: true },
    });
    expect(config.channels.discord.guilds["1234567890"].enabled).toBeUndefined();
  });

  it("applies WeChat post-agent-install build-file outputs through the messaging applier", async () => {
    const channels = Buffer.from(JSON.stringify(["wechat"])).toString("base64");
    const wechatConfig = Buffer.from(
      JSON.stringify({ accountId: "primary", baseUrl: "https://ilinkai.wechat.com", userId: "u1" }),
    ).toString("base64");
    const config = await runMessagingConfig(channels, {
      NEMOCLAW_WECHAT_CONFIG_B64: wechatConfig,
    });

    expect(config.plugins?.installs?.["openclaw-weixin"]).toEqual({
      source: "npm",
      spec: "@tencent-weixin/openclaw-weixin@2.4.3",
      installPath: "/sandbox/.openclaw/extensions/openclaw-weixin",
    });
    expect(config.plugins?.load?.paths ?? []).not.toContain(
      "/sandbox/.openclaw/extensions/openclaw-weixin",
    );
    expect(config.plugins?.entries?.["openclaw-weixin"]?.enabled).toBe(true);
    expect(config.channels?.["openclaw-weixin"]?.accounts?.primary).toEqual({ enabled: true });
    expect(config.channels?.wechat).toBeUndefined();
  });

  it("omits channels.openclaw-weixin when no accountId was captured", async () => {
    // No QR-login result → seed step bails on the empty accountId and
    // leaves openclaw.json untouched, so the bridge stays dormant.
    const channels = Buffer.from(JSON.stringify(["wechat"])).toString("base64");
    const config = await runMessagingConfig(channels);
    expect(config.channels?.["openclaw-weixin"]).toBeUndefined();
    expect(config.channels?.wechat).toBeUndefined();
  });

  it("omits the openclaw-weixin plugin entry until WeChat is active", () => {
    const config = runConfigScript({});
    expect(config.plugins?.entries?.["openclaw-weixin"]).toBeUndefined();
  });

  it("preserves existing plugin install registry entries without enabling WeChat", () => {
    const configPath = path.join(tmpDir, ".openclaw", "openclaw.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const installEntry = {
      source: "npm",
      spec: "@tencent-weixin/openclaw-weixin@2.4.3",
    };
    fs.writeFileSync(
      configPath,
      JSON.stringify({ plugins: { installs: { "openclaw-weixin": installEntry } } }),
    );

    const config = runConfigScript({});

    expect(config.plugins?.installs?.["openclaw-weixin"]).toEqual(installEntry);
    expect(config.plugins?.entries?.["openclaw-weixin"]).toBeUndefined();
  });

  it.each([null, { plugins: null }, { plugins: { installs: {} } }])(
    "ignores malformed existing plugin install registry %# while regenerating config",
    (existing) => {
      const configPath = path.join(tmpDir, ".openclaw", "openclaw.json");
      fs.mkdirSync(path.dirname(configPath), { recursive: true });

      fs.writeFileSync(configPath, JSON.stringify(existing));
      const config = runConfigScript();
      expect(config.plugins?.entries?.["openclaw-weixin"]).toBeUndefined();
      expect(config.plugins?.installs).toBeUndefined();
    },
  );

  it("omits the Discord token from generated config", async () => {
    const channels = Buffer.from(JSON.stringify(["telegram", "discord"])).toString("base64");
    const config = await runMessagingConfig(channels);
    expect(config.proxy).toMatchObject({
      enabled: true,
      proxyUrl: "http://10.200.0.1:3128",
      loopbackMode: "gateway-only",
    });
    expect(config.channels.telegram.accounts.default.botToken).toBeUndefined();
    expect(config.channels.discord.accounts.default.token).toBeUndefined();
    expect(config.channels.telegram.accounts.default.proxy).toBe("http://10.200.0.1:3128");
    expect(config.channels.discord.accounts.default.proxy).toBeUndefined();
  });

  it("routes Discord gateway traffic through OpenClaw's managed proxy (#3894)", async () => {
    const channels = Buffer.from(JSON.stringify(["discord"])).toString("base64");
    const config = await runMessagingConfig(channels, {
      NEMOCLAW_PROXY_HOST: "10.201.0.9",
      NEMOCLAW_PROXY_PORT: "43128",
    });

    expect(config.proxy).toEqual({
      enabled: true,
      proxyUrl: "http://10.201.0.9:43128",
      loopbackMode: "gateway-only",
    });
    expect(config.channels.discord.accounts.default).toMatchObject({
      enabled: true,
    });
    expect(config.channels.discord.accounts.default.token).toBeUndefined();
    expect(config.channels.discord.accounts.default.proxy).toBeUndefined();
  });

  it("does not write a Discord account proxy when the managed proxy is configured", async () => {
    const channels = Buffer.from(JSON.stringify(["discord"])).toString("base64");
    const config = await runMessagingConfig(channels, {
      NEMOCLAW_PROXY_PORT: "43128",
    });

    expect(config.proxy.proxyUrl).toBe("http://10.200.0.1:43128");
    expect(config.channels.discord.accounts.default.proxy).toBeUndefined();
  });

  it("can defer OpenClaw managed proxy config for build-time doctor", async () => {
    const channels = Buffer.from(JSON.stringify(["discord"])).toString("base64");
    const config = await runMessagingConfig(channels, {
      NEMOCLAW_OPENCLAW_MANAGED_PROXY: "0",
    });

    expect(config.proxy).toBeUndefined();
    expect(config.channels.discord.accounts.default.proxy).toBeUndefined();
  });

  it("ignores the OpenShell loopback proxy env var when using OpenClaw managed proxy", async () => {
    const channels = Buffer.from(JSON.stringify(["discord"])).toString("base64");
    const config = await runMessagingConfig(channels, {
      OPENSHELL_LOOPBACK_PROXY_URL: "http://127.0.0.1:45211",
      NEMOCLAW_DISCORD_PROXY_PORT: "43129",
    });

    expect(config.proxy.proxyUrl).toBe("http://10.200.0.1:3128");
    expect(config.channels.discord.accounts.default.proxy).toBeUndefined();
  });

  it("keeps Telegram on the OpenShell proxy while Discord relies on the managed proxy", async () => {
    const channels = Buffer.from(JSON.stringify(["telegram", "discord"])).toString("base64");
    const config = await runMessagingConfig(channels, {
      NEMOCLAW_PROXY_HOST: "10.201.0.9",
      NEMOCLAW_PROXY_PORT: "43128",
    });

    expect(config.proxy.proxyUrl).toBe("http://10.201.0.9:43128");
    expect(config.channels.telegram.accounts.default.proxy).toBe("http://10.201.0.9:43128");
    expect(config.channels.discord.accounts.default.proxy).toBeUndefined();
  });

  it("emits Bolt-shape placeholders for Slack so the SDK's prefix regex passes", async () => {
    const channels = Buffer.from(JSON.stringify(["slack"])).toString("base64");
    const config = await runMessagingConfig(channels);
    expect(config.channels.slack.enabled).toBe(true);
    expect(config.plugins.entries.slack).toEqual({ enabled: true });
    const slack = config.channels.slack.accounts.default;
    expect(slack.botToken).toBeUndefined();
    expect(slack.appToken).toBeUndefined();
  });

  it("marks Telegram and Discord channels enabled so OpenClaw loads the bridges (#4314, #4390)", async () => {
    // Regression: OpenClaw 2026.5.22 no longer auto-starts a channel bridge
    // from the account-level enabled flag alone. The Slack mitigation in
    // PR #4222 added `channels.slack.enabled: true`; #4314 / #4390 reported
    // the same silent failure for Telegram, and the symptom matches Discord
    // too. Bake the top-level enabled marker for every credential-backed
    // messaging channel.
    const channels = Buffer.from(JSON.stringify(["telegram", "discord"])).toString("base64");
    const config = await runMessagingConfig(channels);
    expect(config.channels.telegram.enabled).toBe(true);
    expect(config.channels.discord.enabled).toBe(true);
    expect(config.channels.telegram.accounts.default.enabled).toBe(true);
    expect(config.channels.discord.accounts.default.enabled).toBe(true);
  });

  it("uses Telegram allowed IDs for direct-message allowlisting (#4553)", async () => {
    const allowedUsers = ["8388960805", "8388960806"];
    const channels = Buffer.from(JSON.stringify(["telegram"])).toString("base64");
    const allowedIds = Buffer.from(JSON.stringify({ telegram: allowedUsers })).toString("base64");
    const config = await runMessagingConfig(channels, {
      NEMOCLAW_MESSAGING_ALLOWED_IDS_B64: allowedIds,
    });
    const telegram = config.channels.telegram.accounts.default;

    expect(config.channels.telegram.enabled).toBe(true);
    expect(config.plugins.entries.telegram).toEqual({ enabled: true });
    expect(telegram.dmPolicy).toBe("allowlist");
    expect(telegram.allowFrom).toEqual(allowedUsers);
  });

  it("uses Slack allowed IDs for DMs and channel mention allowlisting (#3729)", async () => {
    const allowedUsers = ["U01ABC2DEF3", "U04GHI5JKL6"];
    const channels = Buffer.from(JSON.stringify(["slack"])).toString("base64");
    const allowedIds = Buffer.from(JSON.stringify({ slack: allowedUsers })).toString("base64");
    const config = await runMessagingConfig(channels, {
      NEMOCLAW_MESSAGING_ALLOWED_IDS_B64: allowedIds,
    });
    const slack = config.channels.slack.accounts.default;

    expect(config.channels.slack.enabled).toBe(true);
    expect(config.plugins.entries.slack).toEqual({ enabled: true });
    expect(slack.dmPolicy).toBe("allowlist");
    expect(slack.allowFrom).toEqual(allowedUsers);
    expect(slack.groupPolicy).toBe("allowlist");
    expect(slack.channels).toEqual({
      "*": {
        enabled: true,
        requireMention: true,
        users: allowedUsers,
      },
    });
  });

  it("uses Slack allowed channels to scope channel @mentions", async () => {
    const allowedUsers = ["U01ABC2DEF3", "U04GHI5JKL6"];
    const allowedChannels = ["C012AB3CD", "C987ZY6XW"];
    const channels = Buffer.from(JSON.stringify(["slack"])).toString("base64");
    const allowedIds = Buffer.from(JSON.stringify({ slack: allowedUsers })).toString("base64");
    const slackConfig = Buffer.from(JSON.stringify({ allowedChannels })).toString("base64");
    const config = await runMessagingConfig(channels, {
      NEMOCLAW_MESSAGING_ALLOWED_IDS_B64: allowedIds,
      NEMOCLAW_SLACK_CONFIG_B64: slackConfig,
    });
    const slack = config.channels.slack.accounts.default;

    expect(slack.dmPolicy).toBe("allowlist");
    expect(slack.allowFrom).toEqual(allowedUsers);
    expect(slack.groupPolicy).toBe("allowlist");
    expect(slack.channels).toEqual({
      C012AB3CD: {
        enabled: true,
        requireMention: true,
        users: allowedUsers,
      },
      C987ZY6XW: {
        enabled: true,
        requireMention: true,
        users: allowedUsers,
      },
    });
  });

  it("enables structured OpenClaw Tool Search by default", () => {
    const config = runConfigScript();
    expect(config.tools?.toolSearch).toEqual(STRUCTURED_TOOL_SEARCH);
  });

  it("enables keyless web_fetch through the trusted env proxy by default", () => {
    const config = runConfigScript();
    expect(config.tools?.web?.fetch).toEqual({
      enabled: true,
      useTrustedEnvProxy: true,
    });
    expect(config.tools?.web?.search).toBeUndefined();
  });

  it("defaults enabled web search to Brave using the current plugin schema", () => {
    const config = runConfigScript({ NEMOCLAW_WEB_SEARCH_ENABLED: "1" });
    expect(config.tools?.toolSearch).toEqual(STRUCTURED_TOOL_SEARCH);
    // #5266: apiKey lives under plugins.entries.brave.config (not inline on
    // tools.web.search) so build-time `openclaw plugins install` validates.
    expect(config.tools?.web?.search).toEqual({ enabled: true, provider: "brave" });
    expect(config.plugins?.entries?.brave).toEqual({
      enabled: true,
      config: { webSearch: { apiKey: "openshell:resolve:env:BRAVE_API_KEY" } },
    });
    expect(config.tools?.web?.fetch).toEqual({ enabled: true, useTrustedEnvProxy: true });
  });

  it("omits web search when env is not set", () => {
    const config = runConfigScript();
    expect(config.tools?.toolSearch).toEqual(STRUCTURED_TOOL_SEARCH);
    expect(config.tools?.web?.search).toBeUndefined();
  });
  it("propagates the agent timeout to the run and provider request (#8468)", () => {
    const config = runConfigScript({ NEMOCLAW_AGENT_TIMEOUT: "300" });
    expect(config.agents.defaults.timeoutSeconds).toBe(300);
    expect(config.models.providers["test-provider"].timeoutSeconds).toBe(300);
  });

  it("rejects invalid agent timeout values", () => {
    expectBuildConfigError(
      { NEMOCLAW_AGENT_TIMEOUT: "forever" },
      "NEMOCLAW_AGENT_TIMEOUT must be a positive integer",
    );
  });

  it("omits heartbeat when NEMOCLAW_AGENT_HEARTBEAT_EVERY is unset", () => {
    const config = runConfigScript();
    expect(config.agents.defaults.heartbeat).toBeUndefined();
  });

  it("omits heartbeat when NEMOCLAW_AGENT_HEARTBEAT_EVERY is the empty string", () => {
    // Docker promotes the unset ARG to an empty ENV value rather than dropping
    // the variable, so the build path almost always sees "" rather than undefined.
    const config = runConfigScript({ NEMOCLAW_AGENT_HEARTBEAT_EVERY: "" });
    expect(config.agents.defaults.heartbeat).toBeUndefined();
  });

  it("propagates heartbeat cadence into agents.defaults.heartbeat.every", () => {
    const config = runConfigScript({ NEMOCLAW_AGENT_HEARTBEAT_EVERY: "30m" });
    expect(config.agents.defaults.heartbeat).toEqual({ every: "30m" });
  });

  it("disables heartbeat when set to 0m (#2880)", () => {
    const config = runConfigScript({ NEMOCLAW_AGENT_HEARTBEAT_EVERY: "0m" });
    expect(config.agents.defaults.heartbeat).toEqual({ every: "0m" });
  });

  it("rejects malformed heartbeat values, preserves OpenClaw default, and warns on stderr", () => {
    const { result: config, stderr } = runCapturingConsoleError(() =>
      buildConfigDirect({ NEMOCLAW_AGENT_HEARTBEAT_EVERY: "5 minutes" }),
    );
    expect(config.agents.defaults.heartbeat).toBeUndefined();
    expect(stderr).toMatch(
      /\[SECURITY\] NEMOCLAW_AGENT_HEARTBEAT_EVERY must match \^\\d\+\(s\|m\|h\)\$, got "5 minutes"/,
    );
  });

  it("disables OpenClaw first-run workspace bootstrap", () => {
    const config = runConfigScript();
    expect(config.agents.defaults.skipBootstrap).toBe(true);
  });

  it("disables inferred thinking for first-turn sandbox replies", () => {
    const config = runConfigScript();
    expect(config.agents.defaults.thinkingDefault).toBe("off");
  });

  // ─── agents.list bake ─────────────────────────────────────────────────────
  // Even with no NEMOCLAW_EXTRA_AGENTS_JSON_B64 set, agents.list must exist
  // with the canonical main entry pinned as default. Otherwise a wholesale
  // list overwrite could leave OpenClaw resolving default to agents[0]
  // without "main" present.

  const TOOLS_OK = { profile: "minimal", allow: ["read"], deny: ["exec"] };

  function makeExtra(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "research",
      workspace: "/sandbox/.openclaw/workspace-research",
      agentDir: "/sandbox/.openclaw/agents/research",
      tools: TOOLS_OK,
      ...overrides,
    };
  }

  function extraAgentsB64(extras: unknown): string {
    return Buffer.from(JSON.stringify(extras)).toString("base64");
  }

  it("always writes agents.list with a default 'main' entry first", () => {
    const config = runConfigScript();
    expect(Array.isArray(config.agents.list)).toBe(true);
    expect(config.agents.list).toHaveLength(1);
    expect(config.agents.list[0]).toEqual({ id: "main", default: true });
  });

  it("appends NEMOCLAW_EXTRA_AGENTS_JSON_B64 entries after main", () => {
    const extras = [
      makeExtra({ id: "research" }),
      makeExtra({
        id: "writing",
        workspace: "/sandbox/.openclaw/workspace-writing",
        agentDir: "/sandbox/.openclaw/agents/writing",
      }),
    ];
    const config = runConfigScript({
      NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64(extras),
    });
    expect(config.agents.list).toHaveLength(3);
    expect(config.agents.list[0]).toEqual({ id: "main", default: true });
    expect(config.agents.list[1]).toMatchObject({ id: "research" });
    expect(config.agents.list[2]).toMatchObject({ id: "writing" });
  });

  it("keeps 'main' as the default even when extras are present", () => {
    // Wholesale list replacement would leave agents[0] = first extra, so
    // resolveDefaultAgentId would silently re-elect the first extra as
    // default. The bake must always emit { id: "main", default: true } first.
    const config = runConfigScript({
      NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([makeExtra()]),
    });
    const defaultEntries = config.agents.list.filter(
      (entry: { default?: boolean }) => entry.default === true,
    );
    expect(defaultEntries).toHaveLength(1);
    expect(defaultEntries[0].id).toBe("main");
    expect(config.agents.list[0].id).toBe("main");
  });

  it("rejects extras that claim id 'main'", () => {
    expectBuildConfigError(
      { NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([makeExtra({ id: "main" })]) },
      /reserved for the primary agent/,
    );
  });

  it("rejects extras that set default: true", () => {
    expectBuildConfigError(
      { NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([makeExtra({ default: true })]) },
      /default cannot be true/,
    );
  });

  it("rejects extras with duplicate ids", () => {
    const extras = [
      makeExtra(),
      makeExtra({
        workspace: "/sandbox/.openclaw/workspace-research-2",
        agentDir: "/sandbox/.openclaw/agents/research-2",
      }),
    ];
    expectBuildConfigError(
      { NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64(extras) },
      /is duplicated/,
    );
  });

  it("rejects extras whose ids violate the regex", () => {
    expectBuildConfigError(
      { NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([makeExtra({ id: "Research" })]) },
      /\.id must match/,
    );
  });

  it("rejects extras with relative paths", () => {
    expectBuildConfigError(
      {
        NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([
          makeExtra({ workspace: "workspace-research" }),
        ]),
      },
      /must be an absolute path/,
    );
  });

  it("rejects extras whose paths escape the sandbox state root", () => {
    expectBuildConfigError(
      {
        NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([
          makeExtra({ workspace: "/etc/openclaw/workspace-research" }),
        ]),
      },
      /workspace must equal "\/sandbox\/\.openclaw\/workspace-research"/,
    );
  });

  it("rejects extras that smuggle dot-segments past the sandbox state root prefix", () => {
    // /sandbox/.openclaw/../../tmp/research resolves to /tmp/research; a raw
    // startsWith() check on the prefix would accept it. The validator must
    // normalise before containment.
    expectBuildConfigError(
      {
        NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([
          makeExtra({ workspace: "/sandbox/.openclaw/../../tmp/research" }),
        ]),
      },
      /workspace must equal "\/sandbox\/\.openclaw\/workspace-research"/,
    );
  });

  it.each([
    "/sandbox/.openclaw",
    "/sandbox/.openclaw/openclaw.json",
    "/sandbox/.openclaw/credentials",
    "/sandbox/.openclaw/workspace",
    "/sandbox/.openclaw/workspace-other",
  ])("rejects extra workspace %s outside the canonical workspace-<id> slot", (workspace) => {
    // The runtime startup script provisions /sandbox/.openclaw/workspace-<id>
    // as the per-agent workspace. Pointing at sibling paths (gateway state,
    // openclaw.json, credentials/) blurs that isolation boundary.
    expectBuildConfigError(
      { NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([makeExtra({ workspace })]) },
      /workspace must equal "\/sandbox\/\.openclaw\/workspace-research"/,
    );
  });

  it.each([
    "/sandbox/.openclaw",
    "/sandbox/.openclaw/agents",
    "/sandbox/.openclaw/agents/other",
    "/sandbox/.openclaw/openclaw.json",
  ])("rejects extra agentDir %s outside the canonical agents/<id> slot", (agentDir) => {
    expectBuildConfigError(
      { NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([makeExtra({ agentDir })]) },
      /agentDir must equal "\/sandbox\/\.openclaw\/agents\/research"/,
    );
  });

  it("rejects extras that lack a tools policy", () => {
    expectBuildConfigError(
      {
        NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([makeExtra({ tools: undefined })]),
      },
      /\.tools must be an object/,
    );
  });

  it("rejects extras whose tools policy lacks allow[] and deny[]", () => {
    expectBuildConfigError(
      {
        NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([
          makeExtra({ tools: { profile: "minimal" } }),
        ]),
      },
      /must declare a non-empty allow\[\] or deny\[\]/,
    );
  });

  it("treats subagents as optional and omits it when absent or empty", () => {
    const config = runConfigScript({
      NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([makeExtra()]),
    });
    expect(config.agents.list[1]).not.toHaveProperty("subagents");
  });

  it("rejects per-agent subagents.maxSpawnDepth with a migration hint", () => {
    expectBuildConfigError(
      {
        NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([
          makeExtra({ subagents: { maxSpawnDepth: 2 } }),
        ]),
      },
      /maxSpawnDepth is not accepted per-agent.*defaults\.subagents\.maxSpawnDepth/,
    );
  });

  it("rejects extras when the payload is neither array nor object", () => {
    expectBuildConfigError(
      { NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64("not-a-list") },
      /must decode to a JSON array of agent objects or an object with/,
    );
  });

  it("rejects extras that include unsupported top-level fields (no implicit pass-through)", () => {
    expectBuildConfigError(
      {
        NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([
          makeExtra({ apiKey: "leaking-secret-disguised-as-config" }),
        ]),
      },
      /contains unsupported field\(s\): apiKey/,
    );
  });

  it("rejects extras that smuggle credential-like keys inside tools", () => {
    expectBuildConfigError(
      {
        NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([
          makeExtra({ tools: { ...TOOLS_OK, apiKey: "x" } }),
        ]),
      },
      /\.tools contains unsupported field\(s\): apiKey/,
    );
  });

  it("rejects extras that smuggle credential-like keys inside subagents", () => {
    expectBuildConfigError(
      {
        NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([makeExtra({ subagents: { token: "x" } })]),
      },
      /\.subagents contains unsupported field\(s\): token/,
    );
  });

  it("emits canonical paths for workspace/agentDir even when operator input contains dot segments", () => {
    // Resolves to the canonical /sandbox/.openclaw/workspace-research path,
    // but the operator-supplied string is the dot-segment form. The bake
    // must write the canonical string so the runtime
    // `provision_agent_workspaces` parser (which only matches direct
    // `/sandbox/.openclaw/workspace-*`) still recognises it.
    const config = runConfigScript({
      NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([
        makeExtra({
          workspace: "/sandbox/.openclaw/foo/../workspace-research",
          agentDir: "/sandbox/.openclaw/bar/../agents/research",
        }),
      ]),
    });
    expect(config.agents.list[1].workspace).toBe("/sandbox/.openclaw/workspace-research");
    expect(config.agents.list[1].agentDir).toBe("/sandbox/.openclaw/agents/research");
  });

  it("strips operator entries to the allowlist when writing agents.list", () => {
    // The validator must drop unknown keys at every nesting level before
    // they reach the baked image. (The previous tests confirm unknown
    // fields fail; this test guards against an allowlist drift where an
    // unknown field is accepted but a known one is dropped.)
    const subagentsInput = {
      delegationMode: "prefer",
      allowAgents: ["analyst"],
      requireAgentId: true,
    };
    const config = runConfigScript({
      NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([
        {
          id: "research",
          workspace: "/sandbox/.openclaw/workspace-research",
          agentDir: "/sandbox/.openclaw/agents/research",
          tools: TOOLS_OK,
          subagents: subagentsInput,
          description: "Researches things",
        },
      ]),
    });
    expect(config.agents.list[1]).toEqual({
      id: "research",
      workspace: "/sandbox/.openclaw/workspace-research",
      agentDir: "/sandbox/.openclaw/agents/research",
      tools: TOOLS_OK,
      subagents: subagentsInput,
      description: "Researches things",
    });
  });

  it("matches OpenClaw's resolveDefaultAgentId fallback shape for the baked list", () => {
    // OpenClaw's resolver: pick the first entry with default === true; if
    // none, fall back to agents[0]. Simulate that locally over the baked
    // list to prove the bake satisfies the upstream contract today. The
    // authoritative resolver still lives in the openclaw npm package; see
    // packages/nemoclaw-openclaw/manifest.yaml -> expected_version for the pinned tag.
    const config = runConfigScript({
      NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([
        makeExtra({ id: "research" }),
        makeExtra({
          id: "writing",
          workspace: "/sandbox/.openclaw/workspace-writing",
          agentDir: "/sandbox/.openclaw/agents/writing",
        }),
      ]),
    });
    const list: Array<{ id: string; default?: boolean }> = config.agents.list;
    const resolved = list.find((entry) => entry.default === true)?.id ?? list[0]?.id;
    expect(resolved).toBe("main");
  });

  // ─── agents-manifest extensions ───────────────────────────────────────────
  // The v1 `{agents,defaults?,main?}` payload shape covered by
  // tests/config/agents-manifest.test.ts to keep this file
  // under the legacy size budget.

  it("keeps compatible endpoints on the managed inference.local OpenClaw provider", () => {
    const config = runConfigScript({
      NEMOCLAW_MODEL: "deepseek-ai/DeepSeek-V4-Flash",
      NEMOCLAW_PROVIDER_KEY: "inference",
      NEMOCLAW_PRIMARY_MODEL_REF: "inference/deepseek-ai/DeepSeek-V4-Flash",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
      NEMOCLAW_INFERENCE_COMPAT_B64: Buffer.from(JSON.stringify({ supportsStore: false })).toString(
        "base64",
      ),
    });

    expect(Object.keys(config.models.providers)).toEqual(["inference"]);
    expect(config.models.providers.inference.baseUrl).toBe("https://inference.local/v1");
    expect(config.models.providers.inference.apiKey).toBe("unused");
    expect(config.models.providers.inference.models[0]).toMatchObject({
      id: "deepseek-ai/DeepSeek-V4-Flash",
      name: "inference/deepseek-ai/DeepSeek-V4-Flash",
      compat: { supportsStore: false },
    });
    expect(config.agents.defaults.model.primary).toBe("inference/deepseek-ai/DeepSeek-V4-Flash");
    expect(config.models.providers.deepinfra).toBeUndefined();
  });

  it("propagates ollama-local streaming usage compat through the managed inference route (#3947)", () => {
    const config = runConfigScript({
      NEMOCLAW_MODEL: "qwen3.6:35b",
      NEMOCLAW_PROVIDER_KEY: "inference",
      NEMOCLAW_PRIMARY_MODEL_REF: "inference/qwen3.6:35b",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
      NEMOCLAW_INFERENCE_COMPAT_B64: Buffer.from(
        JSON.stringify({ supportsUsageInStreaming: true }),
      ).toString("base64"),
    });

    expect(Object.keys(config.models.providers)).toEqual(["inference"]);
    expect(config.models.providers.inference.models[0]).toMatchObject({
      id: "qwen3.6:35b",
      name: "inference/qwen3.6:35b",
      compat: { supportsUsageInStreaming: true },
    });
    expect(config.agents.defaults.model.primary).toBe("inference/qwen3.6:35b");
  });

  it("adds Kimi K2.6 compat for managed inference.local chat completions", () => {
    const config = runConfigScript({
      NEMOCLAW_MODEL: "moonshotai/kimi-k2.6",
      NEMOCLAW_PROVIDER_KEY: "inference",
      NEMOCLAW_PRIMARY_MODEL_REF: "inference/moonshotai/kimi-k2.6",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
      NEMOCLAW_INFERENCE_COMPAT_B64: Buffer.from(JSON.stringify({ supportsStore: false })).toString(
        "base64",
      ),
    });

    expect(config.models.providers.inference.models[0].compat).toEqual({
      supportsStore: false,
      requiresStringContent: true,
      maxTokensField: "max_tokens",
      requiresToolResultName: true,
    });
    expect(config.plugins.entries["nemoclaw-kimi-inference-compat"]).toEqual({
      enabled: true,
    });
    expect(config.plugins.load.paths).toEqual([
      "/usr/local/share/nemoclaw/openclaw-plugins/kimi-inference-compat",
    ]);
    expect(config.tools?.toolSearch).toBe(false);
  });

  it("adds registry compat when the incoming compat blob is null", () => {
    const config = runConfigScript({
      NEMOCLAW_MODEL: "moonshotai/kimi-k2.6",
      NEMOCLAW_PROVIDER_KEY: "inference",
      NEMOCLAW_PRIMARY_MODEL_REF: "inference/moonshotai/kimi-k2.6",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
      NEMOCLAW_INFERENCE_COMPAT_B64: Buffer.from("null").toString("base64"),
    });
    expect(config.models.providers.inference.models[0].compat).toEqual({
      supportsStore: false,
      requiresStringContent: true,
      maxTokensField: "max_tokens",
      requiresToolResultName: true,
    });
  });

  it("rejects inference compat blobs that decode to non-object JSON", () => {
    expectBuildConfigError(
      { NEMOCLAW_INFERENCE_COMPAT_B64: Buffer.from('"not-an-object"').toString("base64") },
      "NEMOCLAW_INFERENCE_COMPAT_B64 must decode to a JSON object or null",
    );
  });

  // #2747: Ollama's OpenAI-compatible streaming API omits the usage chunk
  // unless `stream_options.include_usage` is set on the request. OpenClaw
  // gates that on `model.compat.supportsUsageInStreaming`. NemoClaw routes
  // ollama-local through the standardised `inference.local` URL, which
  // OpenClaw's own Ollama detector does not recognise — so we force the
  // flag here. Cloud providers and other local backends must not be
  // affected.
  it.each(["ollama", "ollama-local"])(
    "enables supportsUsageInStreaming for Ollama provider key %s (#2747)",
    (providerKey) => {
      const config = runConfigScript({
        NEMOCLAW_MODEL: "qwen3.5:9b",
        NEMOCLAW_PROVIDER_KEY: providerKey,
        NEMOCLAW_PRIMARY_MODEL_REF: "qwen3.5:9b",
        NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
        NEMOCLAW_INFERENCE_API: "openai-completions",
      });
      const model = config.models.providers[providerKey].models[0];
      expect(model.compat?.supportsUsageInStreaming).toBe(true);
    },
  );

  it.each([
    { NEMOCLAW_PROVIDER_KEY: "openai", NEMOCLAW_INFERENCE_BASE_URL: "https://api.openai.com/v1" },
    {
      NEMOCLAW_PROVIDER_KEY: "anthropic",
      NEMOCLAW_INFERENCE_BASE_URL: "https://api.anthropic.com",
    },
    { NEMOCLAW_PROVIDER_KEY: "vllm", NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1" },
    {
      NEMOCLAW_PROVIDER_KEY: "nim-local",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
    },
  ])("does not enable supportsUsageInStreaming for $NEMOCLAW_PROVIDER_KEY (#2747)", (envCase) => {
    const config = runConfigScript({
      NEMOCLAW_MODEL: "test-model",
      NEMOCLAW_PRIMARY_MODEL_REF: "test-ref",
      NEMOCLAW_INFERENCE_API: "openai-completions",
      ...envCase,
    });
    const model = config.models.providers[envCase.NEMOCLAW_PROVIDER_KEY].models[0];
    expect(model.compat?.supportsUsageInStreaming).toBeUndefined();
  });

  // If a future model-specific-setup manifest declares
  // supportsUsageInStreaming explicitly, that decision should win over our
  // ollama-keyed default — including when a manifest opts the flag *off*.
  it("respects existing supportsUsageInStreaming from inference compat (#2747)", () => {
    const config = runConfigScript({
      NEMOCLAW_MODEL: "qwen3.5:9b",
      NEMOCLAW_PROVIDER_KEY: "ollama",
      NEMOCLAW_PRIMARY_MODEL_REF: "qwen3.5:9b",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
      NEMOCLAW_INFERENCE_COMPAT_B64: Buffer.from(
        JSON.stringify({ supportsUsageInStreaming: false }),
      ).toString("base64"),
    });
    expect(config.models.providers.ollama.models[0].compat.supportsUsageInStreaming).toBe(false);
  });

  it.each([
    { NEMOCLAW_MODEL: "deepseek-ai/DeepSeek-V4-Flash" },
    { NEMOCLAW_PROVIDER_KEY: "openai" },
    { NEMOCLAW_INFERENCE_API: "responses" },
    { NEMOCLAW_INFERENCE_BASE_URL: "https://integrate.api.nvidia.com/v1" },
  ])(
    "does not activate the OpenClaw Kimi setup for non-matching route %#",
    { timeout: 20_000 },
    (envCase) => {
      const config = runConfigScript({
        NEMOCLAW_MODEL: "moonshotai/kimi-k2.6",
        NEMOCLAW_PROVIDER_KEY: "inference",
        NEMOCLAW_PRIMARY_MODEL_REF: "inference/moonshotai/kimi-k2.6",
        NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
        NEMOCLAW_INFERENCE_API: "openai-completions",
        NEMOCLAW_INFERENCE_COMPAT_B64: Buffer.from(
          JSON.stringify({ supportsStore: false }),
        ).toString("base64"),
        ...envCase,
      });

      const providerConfig = Object.values(config.models.providers)[0] as any;
      expect(providerConfig.models[0].compat).toEqual({ supportsStore: false });
      expect(config.plugins.entries["nemoclaw-kimi-inference-compat"]).toBeUndefined();
      expect(config.plugins.load).toBeUndefined();
      expect(config.tools?.toolSearch).toEqual(STRUCTURED_TOOL_SEARCH);
    },
  );
  // #4780: keep false safeguards until live search can replace the direct-tool fallback.
  it.each([
    "nvidia/nemotron-3-super-120b-a12b",
    "nvidia/nemotron-3-ultra-550b-a55b",
    "nvidia/nvidia/nemotron-3-ultra",
  ])("keeps Tool Search disabled for Nemotron model %s (#4780)", (model) => {
    const config = runConfigScript({
      NEMOCLAW_MODEL: model,
      NEMOCLAW_PROVIDER_KEY: "inference",
      NEMOCLAW_PRIMARY_MODEL_REF: `inference/${model}`,
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
    });
    expect(config.tools?.toolSearch, model).toBe(false);
  });
  it.each([
    { NEMOCLAW_MODEL: "nvidia/nemotron-3-nano:30b" },
    { NEMOCLAW_PROVIDER_KEY: "nvidia" },
    { NEMOCLAW_INFERENCE_API: "responses" },
    { NEMOCLAW_INFERENCE_BASE_URL: "https://integrate.api.nvidia.com/v1" },
  ])(
    "keeps structured Tool Search for non-matching Nemotron route %# (#4780)",
    { timeout: 20_000 },
    (envCase) => {
      const config = runConfigScript({
        NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
        NEMOCLAW_PROVIDER_KEY: "inference",
        NEMOCLAW_PRIMARY_MODEL_REF: "inference/nvidia/nemotron-3-super-120b-a12b",
        NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
        NEMOCLAW_INFERENCE_API: "openai-completions",
        ...envCase,
      });

      expect(config.tools?.toolSearch).toEqual(STRUCTURED_TOOL_SEARCH);
    },
  );

  it("sets gateway auth token to empty string", () => {
    const config = runConfigScript();
    expect(config.gateway.auth.token).toBe("");
  });

  it("disables bundled bonjour in sandbox config by default", () => {
    const config = runConfigScript();
    expect(config.plugins.entries.bonjour.enabled).toBe(false);
    expect(config.plugins.entries.bonjour.config).toBeUndefined();
  });

  it("omits stale disabled entries for optional bundled plugins", () => {
    const config = runConfigScript({ NEMOCLAW_PROVIDER_KEY: "inference" });
    expect(Object.keys(config.plugins.entries)).toEqual(["bonjour"]);
  });

  it("keeps the selected bundled provider plugin available", () => {
    const config = runConfigScript({ NEMOCLAW_PROVIDER_KEY: "anthropic" });
    expect(config.plugins.entries.anthropic).toBeUndefined();
    expect(config.plugins.entries.google).toBeUndefined();
  });

  it("keeps the selected OpenAI bundled provider plugin available", () => {
    const config = runConfigScript({ NEMOCLAW_PROVIDER_KEY: "openai" });
    expect(config.plugins.entries.openai).toBeUndefined();
    expect(config.plugins.entries.xai).toBeUndefined();
  });

  it("enables the discord plugin entry when Discord is configured (#4246)", async () => {
    const channels = Buffer.from(JSON.stringify(["discord"])).toString("base64");
    const config = await runMessagingConfig(channels);
    expect(config.plugins.entries.discord).toEqual({ enabled: true });
  });

  it("omits the discord plugin entry when Discord is not configured (#4246)", () => {
    const config = runConfigScript();
    expect(config.plugins.entries.discord).toBeUndefined();
  });

  it("creates file with 0600 permissions", () => {
    runConfigScript();
    const configPath = path.join(tmpDir, ".openclaw", "openclaw.json");
    const stats = fs.statSync(configPath);
    // 0o600 = owner read/write only (octal 600 = decimal 384)
    expect(stats.mode & 0o777).toBe(0o600);
  });
});
