// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Imported by generator.test.ts so this cohesive validation suite shares its package test lane.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConfig, main } from "../../config/generate-config.mts";
import {
  applyMessagingAgentRenderToObject,
  applyMessagingBuildPhase,
  readMessagingBuildPlanFromEnv,
} from "../../../../src/lib/messaging/applier/build/messaging-build-applier.mts";
import { withLegacyMessagingPlanEnvDirect } from "../../../../test/messaging-plan-test-helper";
import { baseOpenClawGenerationEnv, buildOpenClawTestEnv } from "../helpers/env-fixture";

const BASE_ENV = baseOpenClawGenerationEnv();
const CHANNELS_ENV = "NEMOCLAW_MESSAGING_CHANNELS_B64";

let tmpDir: string;

const buildTestEnv = (envOverrides: Record<string, string> = {}): Record<string, string> =>
  buildOpenClawTestEnv(tmpDir, BASE_ENV, envOverrides);

const messagingEnv = (channels: string, env: Record<string, string> = {}) =>
  withLegacyMessagingPlanEnvDirect(buildTestEnv({ ...env, [CHANNELS_ENV]: channels }), "openclaw");

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-config-validation-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("generate-openclaw-config.mts: manifest validation", () => {
  it("rejects model-specific setup manifests without a known agent", () => {
    const blueprintDir = path.join(tmpDir, "fixture-blueprint");
    const registryDir = writeRegistryManifest(blueprintDir, "openclaw/missing-agent.json", {
      id: "missing-agent",
      description: "Invalid manifest",
      match: { modelIds: ["test-model"] },
      effects: { openclawCompat: {} },
    });

    expectBuildConfigError(
      { NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: registryDir },
      "field 'agent' is required",
    );

    const unknownRegistryDir = writeRegistryManifest(blueprintDir, "openclaw/unknown-agent.json", {
      id: "unknown-agent",
      agent: "sidecar",
      description: "Invalid manifest",
      match: { modelIds: ["test-model"] },
      effects: { openclawCompat: {} },
    });
    fs.rmSync(path.join(blueprintDir, "model-specific-setup", "openclaw", "missing-agent.json"));

    expectBuildConfigError(
      { NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: unknownRegistryDir },
      "unknown agent 'sidecar'",
    );
  }, 20_000);

  it("rejects empty match objects and invalid explicit registry overrides", () => {
    const missingRegistry = path.join(tmpDir, "missing-registry");
    expectBuildConfigError(
      { NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: missingRegistry },
      "NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR must point to an existing directory",
    );

    const blueprintDir = path.join(tmpDir, "fixture-blueprint");
    const registryDir = writeRegistryManifest(blueprintDir, "openclaw/empty-match.json", {
      id: "empty-match",
      agent: "openclaw",
      description: "Invalid match",
      match: {},
      effects: { openclawCompat: {} },
    });

    expectBuildConfigError(
      { NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: registryDir },
      "field 'match' must be a non-empty object",
    );
  });

  it("rejects malformed model-specific setup manifest fields independently", () => {
    const validManifest = {
      id: "fixture",
      agent: "openclaw",
      description: "Fixture manifest",
      match: { modelIds: ["test-model"] },
      effects: { openclawCompat: {} },
    };
    const cases = [
      {
        name: "non-object root",
        manifest: null,
        message: "manifest must be a JSON object",
      },
      {
        name: "missing id",
        manifest: { ...validManifest, id: "" },
        message: "field 'id' must be a non-empty string",
      },
      {
        name: "missing description",
        manifest: { ...validManifest, description: "" },
        message: "field 'description' must be a non-empty string",
      },
      {
        name: "non-object match",
        manifest: { ...validManifest, match: null },
        message: "field 'match' must be an object",
      },
      {
        name: "unknown match key",
        manifest: { ...validManifest, match: { modelIds: ["test-model"], family: "kimi" } },
        message: "unknown match keys: family",
      },
      {
        name: "empty modelIds",
        manifest: { ...validManifest, match: { modelIds: [] } },
        message: "match.modelIds must be a non-empty string array",
      },
      {
        name: "empty providerKey",
        manifest: { ...validManifest, match: { providerKey: "" } },
        message: "match.providerKey must be a non-empty string",
      },
      {
        name: "missing effects",
        manifest: { ...validManifest, effects: null },
        message: "field 'effects' must be a non-empty object",
      },
      {
        name: "non-object openclawCompat",
        manifest: { ...validManifest, effects: { openclawCompat: false } },
        message: "effects.openclawCompat must be an object",
      },
      {
        name: "non-object openclawTools",
        manifest: { ...validManifest, effects: { openclawTools: false } },
        message: "effects.openclawTools must be an object",
      },
      {
        name: "unknown openclawTools key",
        manifest: { ...validManifest, effects: { openclawTools: { webSearch: true } } },
        message: "unknown effects.openclawTools keys: webSearch",
      },
      {
        name: "non-array openclawPlugins",
        manifest: { ...validManifest, effects: { openclawPlugins: {} } },
        message: "effects.openclawPlugins must be an array",
      },
      {
        name: "non-object openclaw plugin",
        manifest: { ...validManifest, effects: { openclawPlugins: ["plugin"] } },
        message: "effects.openclawPlugins[0] must be an object",
      },
      {
        name: "missing openclaw plugin id",
        manifest: {
          ...validManifest,
          effects: {
            openclawPlugins: [
              {
                id: "",
                path: "openclaw-plugins/fixture",
                loadPath: "/usr/local/share/nemoclaw/openclaw-plugins/fixture",
              },
            ],
          },
        },
        message: "effects.openclawPlugins[0].id must be a non-empty string",
      },
      {
        name: "absolute openclaw plugin source path",
        manifest: {
          ...validManifest,
          effects: {
            openclawPlugins: [
              {
                id: "fixture-plugin",
                path: "/tmp/plugin",
                loadPath: "/usr/local/share/nemoclaw/openclaw-plugins/fixture",
              },
            ],
          },
        },
        message: "must be relative to nemoclaw-blueprint",
      },
      {
        name: "parent-relative openclaw plugin source path",
        manifest: {
          ...validManifest,
          effects: {
            openclawPlugins: [
              {
                id: "fixture-plugin",
                path: "../plugin",
                loadPath: "/usr/local/share/nemoclaw/openclaw-plugins/fixture",
              },
            ],
          },
        },
        message: "must be relative to nemoclaw-blueprint",
      },
    ];

    cases.forEach((testCase) => {
      const blueprintDir = path.join(
        tmpDir,
        `fixture-blueprint-${testCase.name.replaceAll(" ", "-")}`,
      );
      const registryDir = writeRegistryManifest(
        blueprintDir,
        "openclaw/manifest.json",
        testCase.manifest as any,
      );
      expectBuildConfigError({ NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: registryDir }, testCase.message);
    });
  });

  it("rejects unknown OpenClaw effect keys and missing plugin source paths", () => {
    const blueprintDir = path.join(tmpDir, "fixture-blueprint");
    const registryDir = writeRegistryManifest(blueprintDir, "openclaw/bad-effect.json", {
      id: "bad-effect",
      agent: "openclaw",
      description: "Invalid OpenClaw effect",
      match: { modelIds: ["test-model"] },
      effects: { hermesCompat: {} },
    });

    expectBuildConfigError(
      { NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: registryDir },
      "unknown effects for agent 'openclaw': hermesCompat",
    );

    fs.rmSync(path.join(blueprintDir, "model-specific-setup", "openclaw", "bad-effect.json"));
    const missingPluginRegistryDir = writeRegistryManifest(
      blueprintDir,
      "openclaw/missing-plugin.json",
      {
        id: "missing-plugin",
        agent: "openclaw",
        description: "Invalid plugin path",
        match: { modelIds: ["test-model"] },
        effects: {
          openclawPlugins: [
            {
              id: "missing-openclaw-plugin",
              path: "openclaw-plugins/missing",
              loadPath: "/usr/local/share/nemoclaw/openclaw-plugins/missing",
            },
          ],
        },
      },
    );

    expectBuildConfigError(
      { NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: missingPluginRegistryDir },
      "path does not exist",
    );

    fs.rmSync(path.join(blueprintDir, "model-specific-setup", "openclaw", "missing-plugin.json"));
    const badToolRegistryDir = writeRegistryManifest(
      blueprintDir,
      "openclaw/bad-tool-effect.json",
      {
        id: "bad-tool-effect",
        agent: "openclaw",
        description: "Invalid tool override",
        match: { modelIds: ["test-model"] },
        effects: { openclawTools: { toolSearch: { mode: "tools" } } },
      },
    );

    expectBuildConfigError(
      { NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: badToolRegistryDir },
      "effects.openclawTools.toolSearch must be a boolean override",
    );

    fs.rmSync(path.join(blueprintDir, "model-specific-setup", "openclaw", "bad-tool-effect.json"));
    fs.mkdirSync(path.join(blueprintDir, "openclaw-plugins", "fixture"), { recursive: true });
    const badLoadPathRegistryDir = writeRegistryManifest(
      blueprintDir,
      "openclaw/bad-load-path.json",
      {
        id: "bad-load-path",
        agent: "openclaw",
        description: "Invalid plugin load path",
        match: { modelIds: ["test-model"] },
        effects: {
          openclawPlugins: [
            {
              id: "fixture-plugin",
              path: "openclaw-plugins/fixture",
              loadPath: "/usr/local/share/nemoclaw/openclaw-plugins/wrong",
            },
          ],
        },
      },
    );

    expectBuildConfigError(
      { NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: badLoadPathRegistryDir },
      "effects.openclawPlugins[0].loadPath must be " +
        "'/usr/local/share/nemoclaw/openclaw-plugins/fixture'",
    );
  });

  it("rejects conflicting OpenClaw compat effects and duplicate plugin ids", () => {
    const blueprintDir = path.join(tmpDir, "fixture-blueprint");
    fs.mkdirSync(path.join(blueprintDir, "openclaw-plugins", "fixture"), { recursive: true });
    const registryDir = writeRegistryManifest(blueprintDir, "openclaw/conflicting-compat.json", {
      id: "conflicting-compat",
      agent: "openclaw",
      description: "Conflicting compat",
      match: { modelIds: ["test-model"] },
      effects: {
        openclawCompat: {
          supportsStore: true,
        },
      },
    });

    expectBuildConfigError(
      {
        NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: registryDir,
        NEMOCLAW_INFERENCE_COMPAT_B64: Buffer.from(
          JSON.stringify({ supportsStore: false }),
        ).toString("base64"),
      },
      "model-specific setup 'conflicting-compat' conflicts with inference compat key 'supportsStore'",
    );

    fs.rmSync(
      path.join(blueprintDir, "model-specific-setup", "openclaw", "conflicting-compat.json"),
    );
    writeRegistryManifest(blueprintDir, "openclaw/tool-a.json", {
      id: "tool-a",
      agent: "openclaw",
      description: "First tool override",
      match: { modelIds: ["test-model"] },
      effects: { openclawTools: { toolSearch: false } },
    });
    writeRegistryManifest(blueprintDir, "openclaw/tool-b.json", {
      id: "tool-b",
      agent: "openclaw",
      description: "Conflicting tool override",
      match: { modelIds: ["test-model"] },
      effects: { openclawTools: { toolSearch: true } },
    });

    expectBuildConfigError(
      { NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: registryDir },
      "model-specific setup 'tool-b' conflicts with OpenClaw tools key 'toolSearch'",
    );

    fs.rmSync(path.join(blueprintDir, "model-specific-setup", "openclaw", "tool-a.json"));
    fs.rmSync(path.join(blueprintDir, "model-specific-setup", "openclaw", "tool-b.json"));
    writeRegistryManifest(blueprintDir, "openclaw/plugin-a.json", {
      id: "plugin-a",
      agent: "openclaw",
      description: "First plugin",
      match: { modelIds: ["test-model"] },
      effects: {
        openclawPlugins: [
          {
            id: "fixture-plugin",
            path: "openclaw-plugins/fixture",
            loadPath: "/usr/local/share/nemoclaw/openclaw-plugins/fixture",
          },
        ],
      },
    });
    writeRegistryManifest(blueprintDir, "openclaw/plugin-b.json", {
      id: "plugin-b",
      agent: "openclaw",
      description: "Duplicate plugin",
      match: { modelIds: ["test-model"] },
      effects: {
        openclawPlugins: [
          {
            id: "fixture-plugin",
            path: "openclaw-plugins/fixture",
            loadPath: "/usr/local/share/nemoclaw/openclaw-plugins/fixture",
          },
        ],
      },
    });

    expectBuildConfigError(
      { NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: registryDir },
      "model-specific setup 'plugin-b' declares duplicate OpenClaw plugin 'fixture-plugin'",
    );
  });
});

describe("generate-openclaw-config.mts: non-loopback auto-disable device auth", () => {
  it("auto-disables device auth for Brev Launchable URL", () => {
    const config = runConfigScript({
      CHAT_UI_URL: "https://nemoclaw0-xxx.brevlab.com:18789",
    });
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(true);
  });

  it("auto-disables device auth for any non-loopback URL", () => {
    const config = runConfigScript({
      CHAT_UI_URL: "http://my-server.local:18789",
    });
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(true);
  });

  it("keeps device auth enabled for 127.0.0.1", () => {
    const config = runConfigScript({ CHAT_UI_URL: "http://127.0.0.1:18789" });
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(false);
  });

  it("keeps device auth enabled for localhost", () => {
    const config = runConfigScript({ CHAT_UI_URL: "http://localhost:18789" });
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(false);
  });

  it("keeps device auth enabled for IPv6 loopback", () => {
    const config = runConfigScript({ CHAT_UI_URL: "http://[::1]:18789" });
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(false);
  });

  it("honors explicit env var override on loopback URL", () => {
    const config = runConfigScript({
      CHAT_UI_URL: "http://127.0.0.1:18789",
      NEMOCLAW_DISABLE_DEVICE_AUTH: "1",
    });
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(true);
  });

  it("URL trumps env var — cannot re-enable device auth for non-loopback", () => {
    const config = runConfigScript({
      CHAT_UI_URL: "https://nemoclaw0-xxx.brevlab.com:18789",
      NEMOCLAW_DISABLE_DEVICE_AUTH: "0",
    });
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(true);
  });
});

describe("generate-openclaw-config.mts: empty-string env vars fall back to defaults", () => {
  it("treats empty CHAT_UI_URL as unset and uses the loopback default", () => {
    const config = runConfigScript({ CHAT_UI_URL: "" });
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(false);
    expect(config.gateway.controlUi.allowedOrigins).toEqual(["http://127.0.0.1:18789"]);
  });

  it("treats empty NEMOCLAW_PROXY_HOST as unset and uses the documented default", async () => {
    const channelB64 = Buffer.from(JSON.stringify(["telegram"])).toString("base64");
    const cfg = await runMessagingConfig(channelB64, {
      NEMOCLAW_PROXY_HOST: "",
    });
    expect(cfg.channels.telegram.accounts.default.proxy).toBe("http://10.200.0.1:3128");
  });

  it("treats empty NEMOCLAW_PROXY_PORT as unset and uses the documented default", async () => {
    const channelB64 = Buffer.from(JSON.stringify(["telegram"])).toString("base64");
    const cfg = await runMessagingConfig(channelB64, {
      NEMOCLAW_PROXY_PORT: "",
    });
    expect(cfg.channels.telegram.accounts.default.proxy).toBe("http://10.200.0.1:3128");
  });

  it("treats empty NEMOCLAW_CONTEXT_WINDOW as unset and uses the documented default", () => {
    const cfg = runConfigScript({ NEMOCLAW_CONTEXT_WINDOW: "" });
    expect(cfg.models.providers["test-provider"].models[0].contextWindow).toBe(131072);
  });

  it("treats empty NEMOCLAW_MAX_TOKENS as unset and uses the documented default", () => {
    const cfg = runConfigScript({ NEMOCLAW_MAX_TOKENS: "" });
    expect(cfg.models.providers["test-provider"].models[0].maxTokens).toBe(4096);
  });
});

describe("generate-openclaw-config.mts: numeric env var validation", () => {
  function runCapturingStderr(envOverrides: Record<string, string>): {
    config: any;
    stderr: string;
  } {
    const { result, stderr } = runCapturingConsoleError(() => buildConfigDirect(envOverrides));
    return { config: result, stderr };
  }

  it("skips non-numeric NEMOCLAW_CONTEXT_WINDOW and falls back to the default", () => {
    const { config, stderr } = runCapturingStderr({ NEMOCLAW_CONTEXT_WINDOW: "notanumber" });
    expect(config.models.providers["test-provider"].models[0].contextWindow).toBe(131072);
    expect(stderr).toMatch(
      /\[SECURITY\] NEMOCLAW_CONTEXT_WINDOW must be a positive integer, got "notanumber"/,
    );
  });

  it("skips non-numeric NEMOCLAW_MAX_TOKENS and falls back to the default", () => {
    const { config, stderr } = runCapturingStderr({ NEMOCLAW_MAX_TOKENS: "notanumber" });
    expect(config.models.providers["test-provider"].models[0].maxTokens).toBe(4096);
    expect(stderr).toMatch(
      /\[SECURITY\] NEMOCLAW_MAX_TOKENS must be a positive integer, got "notanumber"/,
    );
  });

  it("skips zero NEMOCLAW_CONTEXT_WINDOW and falls back to the default", () => {
    const { config, stderr } = runCapturingStderr({ NEMOCLAW_CONTEXT_WINDOW: "0" });
    expect(config.models.providers["test-provider"].models[0].contextWindow).toBe(131072);
    expect(stderr).toMatch(/NEMOCLAW_CONTEXT_WINDOW must be a positive integer/);
  });

  it("skips zero NEMOCLAW_MAX_TOKENS and falls back to the default", () => {
    const { config, stderr } = runCapturingStderr({ NEMOCLAW_MAX_TOKENS: "0" });
    expect(config.models.providers["test-provider"].models[0].maxTokens).toBe(4096);
    expect(stderr).toMatch(/NEMOCLAW_MAX_TOKENS must be a positive integer/);
  });

  it("skips negative NEMOCLAW_CONTEXT_WINDOW and falls back to the default", () => {
    const { config, stderr } = runCapturingStderr({ NEMOCLAW_CONTEXT_WINDOW: "-1" });
    expect(config.models.providers["test-provider"].models[0].contextWindow).toBe(131072);
    expect(stderr).toMatch(/NEMOCLAW_CONTEXT_WINDOW must be a positive integer/);
  });

  it("skips negative NEMOCLAW_MAX_TOKENS and falls back to the default", () => {
    const { config, stderr } = runCapturingStderr({ NEMOCLAW_MAX_TOKENS: "-1" });
    expect(config.models.providers["test-provider"].models[0].maxTokens).toBe(4096);
    expect(stderr).toMatch(/NEMOCLAW_MAX_TOKENS must be a positive integer/);
  });

  it("skips NEMOCLAW_CONTEXT_WINDOW that exceeds the safe integer guard", () => {
    const { config, stderr } = runCapturingStderr({ NEMOCLAW_CONTEXT_WINDOW: "9".repeat(10000) });
    expect(config.models.providers["test-provider"].models[0].contextWindow).toBe(131072);
    expect(stderr).toMatch(/NEMOCLAW_CONTEXT_WINDOW must be a positive integer/);
  });

  it("skips NEMOCLAW_MAX_TOKENS that exceeds the safe integer guard", () => {
    const { config, stderr } = runCapturingStderr({ NEMOCLAW_MAX_TOKENS: "9".repeat(10000) });
    expect(config.models.providers["test-provider"].models[0].maxTokens).toBe(4096);
    expect(stderr).toMatch(/NEMOCLAW_MAX_TOKENS must be a positive integer/);
  });
});
