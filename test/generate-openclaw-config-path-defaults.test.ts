// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../packages/nemoclaw-openclaw/config/generate-config.mts";
import { dockerRunCommandBetween, runLoggedDockerShell } from "./helpers/dockerfile-run-shell";
import { baseOpenClawGenerationEnv, buildOpenClawTestEnv } from "./helpers/openclaw-env-fixture";
import { withLegacyMessagingPlanEnv } from "./messaging-plan-test-helper";

const BASE_ENV = baseOpenClawGenerationEnv();
const OPENCLAW_DOCKERFILE = path.resolve("packages", "nemoclaw-openclaw", "Dockerfile");

const TOOLS_OK = { profile: "minimal", allow: ["read"], deny: ["exec"] };

let tmpDir: string;

const buildTestEnv = (envOverrides: Record<string, string> = {}): Record<string, string> =>
  withLegacyMessagingPlanEnv(buildOpenClawTestEnv(tmpDir, BASE_ENV, envOverrides), "openclaw");

function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const original = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, original);
  }
}

function runConfigScript(envOverrides: Record<string, string> = {}): any {
  const env = buildTestEnv(envOverrides);
  withEnv(env, () => main());
  return JSON.parse(fs.readFileSync(path.join(tmpDir, ".openclaw", "openclaw.json"), "utf-8"));
}

function extraAgentsB64(extras: unknown): string {
  return Buffer.from(JSON.stringify(extras)).toString("base64");
}

describe("generate-openclaw-config.mts: extra-agents path defaulting", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-path-defaults-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("auto-fills workspace and agentDir from id when omitted (full or partial)", () => {
    const config = runConfigScript({
      NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([
        { id: "alpha", tools: TOOLS_OK },
        { id: "beta", workspace: "/sandbox/.openclaw/workspace-beta", tools: TOOLS_OK },
      ]),
    });
    expect(config.agents.list[1]).toMatchObject({
      id: "alpha",
      workspace: "/sandbox/.openclaw/workspace-alpha",
      agentDir: "/sandbox/.openclaw/agents/alpha",
    });
    expect(config.agents.list[2]).toMatchObject({
      id: "beta",
      workspace: "/sandbox/.openclaw/workspace-beta",
      agentDir: "/sandbox/.openclaw/agents/beta",
    });
  });

  it("accepts the legacy allow-only array payload with defaulted workspace and agentDir", () => {
    const config = runConfigScript({
      NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([
        { id: "legacy-worker", tools: { allow: ["read"] } },
      ]),
    });
    expect(config.agents.list).toHaveLength(2);
    expect(config.agents.list[1]).toMatchObject({
      id: "legacy-worker",
      workspace: "/sandbox/.openclaw/workspace-legacy-worker",
      agentDir: "/sandbox/.openclaw/agents/legacy-worker",
      tools: { allow: ["read"] },
    });
  });

  it("auto-fills workspace and agentDir for the object-shaped {agents} payload", () => {
    const config = runConfigScript({
      NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64({
        agents: [{ id: "legacy-worker", tools: { allow: ["read"] } }],
      }),
    });
    expect(config.agents.list).toHaveLength(2);
    expect(config.agents.list[1]).toMatchObject({
      id: "legacy-worker",
      workspace: "/sandbox/.openclaw/workspace-legacy-worker",
      agentDir: "/sandbox/.openclaw/agents/legacy-worker",
      tools: { allow: ["read"] },
    });
  });

  it("restores search permission on copied package configuration directories", () => {
    const imageRoot = path.join(tmpDir, "image-root");
    const imagePackagesRoot = path.join(imageRoot, "packages");
    const packageRoot = path.join(imagePackagesRoot, "nemoclaw-openclaw");
    const configDirectory = path.join(packageRoot, "config");
    const hostDirectory = path.join(packageRoot, "host");

    fs.mkdirSync(configDirectory, { recursive: true });
    fs.mkdirSync(hostDirectory, { recursive: true });
    fs.chmodSync(hostDirectory, 0o444);
    fs.chmodSync(configDirectory, 0o444);
    fs.chmodSync(packageRoot, 0o444);
    fs.chmodSync(imagePackagesRoot, 0o444);

    try {
      const dockerfile = fs.readFileSync(OPENCLAW_DOCKERFILE, "utf8");
      const permissionCommand = dockerRunCommandBetween(
        dockerfile,
        "# COPY --chmod=0444 also applies that mode to destination directories",
        "# Copy startup script and shared sandbox initialisation library.",
      ).replaceAll("/packages", imagePackagesRoot);
      const { result } = runLoggedDockerShell(permissionCommand, tmpDir);

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(fs.statSync(imagePackagesRoot).mode & 0o777).toBe(0o555);
      expect(fs.statSync(packageRoot).mode & 0o777).toBe(0o555);
      expect(fs.statSync(configDirectory).mode & 0o777).toBe(0o555);
      expect(fs.statSync(hostDirectory).mode & 0o777).toBe(0o555);
    } finally {
      fs.chmodSync(imagePackagesRoot, 0o755);
      fs.chmodSync(packageRoot, 0o755);
      fs.chmodSync(configDirectory, 0o755);
      fs.chmodSync(hostDirectory, 0o755);
    }
  });

  it("runs the copied package-relative image layout through the real Node entry point", () => {
    const imageRoot = path.join(tmpDir, "image-root");
    const imagePackageRoot = path.join(imageRoot, "packages", "nemoclaw-openclaw");
    const imageConfigDir = path.join(imagePackageRoot, "config");
    const imageHostDir = path.join(imagePackageRoot, "host");
    const imageSourceDir = path.join(imageRoot, "src", "lib");
    fs.mkdirSync(imageConfigDir, { recursive: true });
    fs.mkdirSync(imageHostDir, { recursive: true });
    fs.mkdirSync(imageSourceDir, { recursive: true });

    const packageRoot = path.resolve("packages", "nemoclaw-openclaw");
    fs.copyFileSync(
      path.join(packageRoot, "config", "generate-config.mts"),
      path.join(imageConfigDir, "generate-config.mts"),
    );
    fs.copyFileSync(
      path.join(packageRoot, "config", "agent-config.mts"),
      path.join(imageConfigDir, "agent-config.mts"),
    );
    fs.copyFileSync(
      path.join(packageRoot, "config", "model-setup.mts"),
      path.join(imageConfigDir, "model-setup.mts"),
    );
    fs.copyFileSync(
      path.join(packageRoot, "host", "config-runtime.cts"),
      path.join(imageHostDir, "config-runtime.cts"),
    );
    fs.copyFileSync(
      path.resolve("src", "lib", "tool-disclosure.ts"),
      path.join(imageSourceDir, "tool-disclosure.ts"),
    );

    const imageGenerator = fs.realpathSync(path.join(imageConfigDir, "generate-config.mts"));
    const result = spawnSync(process.execPath, ["--experimental-strip-types", imageGenerator], {
      cwd: imageRoot,
      encoding: "utf8",
      env: buildTestEnv(tmpDir, BASE_ENV),
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".openclaw", "openclaw.json"), "utf8"),
    );
    expect(config.models.providers[BASE_ENV.NEMOCLAW_PROVIDER_KEY].models[0]).toMatchObject({
      id: BASE_ENV.NEMOCLAW_MODEL,
      name: BASE_ENV.NEMOCLAW_PRIMARY_MODEL_REF,
    });
  });
});
