// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { testTimeoutOptions } from "../../../test/helpers/timeouts";
import { harnessPackageContentDigest } from "../harness/package-registry";
import type { ConfigObject } from "../security/credential-filter";
import {
  applyOpenClawAnthropicReplyBudget,
  readOpenClawPrimaryReplyBudget,
} from "./inference-set-reply-budget";

const temporaryHomes: string[] = [];

function primaryConfig(entry: ConfigObject): ConfigObject {
  return {
    agents: { defaults: { model: { primary: "inference/model-a" } } },
    models: { providers: { inference: { models: [entry] } } },
  };
}

function installedOpenClawRuntimeSource(budget: number): string {
  return [
    '"use strict";',
    "module.exports = {",
    `  DEFAULT_OPENCLAW_MAX_TOKENS: ${String(budget)},`,
    `  readOpenClawPrimaryReplyBudget() { return ${String(budget)}; },`,
    `  applyOpenClawAnthropicReplyBudget(modelConfig) { modelConfig.maxTokens = ${String(budget)}; },`,
    "};",
    "",
  ].join("\n");
}

function writeInstalledOpenClawRuntime(): { home: string; root: string; runtimePath: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-reply-budget-"));
  temporaryHomes.push(home);
  const root = path.join(home, ".nemoclaw", "harnesses", "nemoclaw-openclaw");
  const hostDir = path.join(root, "host");
  fs.mkdirSync(hostDir, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "@nvidia/nemoclaw-openclaw",
      version: "1.2.3",
      nemoclaw: { harnessManifest: "manifest.yaml" },
    }),
  );
  fs.writeFileSync(path.join(root, "manifest.yaml"), "name: openclaw\n");
  fs.writeFileSync(path.join(root, "Dockerfile"), "FROM scratch\n");
  fs.writeFileSync(path.join(root, "Dockerfile.base"), "FROM scratch\n");
  fs.writeFileSync(path.join(root, "start.sh"), "#!/usr/bin/env bash\n", { mode: 0o755 });
  fs.writeFileSync(path.join(root, "policy-additions.yaml"), "version: 1\n");
  const runtimePath = path.join(hostDir, "config-runtime.cts");
  fs.writeFileSync(runtimePath, installedOpenClawRuntimeSource(7777));
  fs.writeFileSync(
    path.join(root, ".nemoclaw-install.json"),
    `${JSON.stringify({ installedDigest: harnessPackageContentDigest(root) })}\n`,
    { mode: 0o600 },
  );
  return { home, root, runtimePath };
}

afterEach(() => {
  vi.unstubAllEnvs();
  temporaryHomes.splice(0).forEach((home) => fs.rmSync(home, { recursive: true, force: true }));
});

describe("OpenClaw reply-budget package runtime", testTimeoutOptions(30_000), () => {
  it.each([
    ["full model reference", { name: "inference/model-a", maxTokens: 8192 }],
    ["model ID", { id: "model-a", maxTokens: 8192 }],
  ])("reads a positive primary budget by %s", (_case, entry) => {
    expect(readOpenClawPrimaryReplyBudget(primaryConfig(entry))).toBe(8192);
  });

  it.each([
    ["missing agent defaults", {}],
    ["unqualified primary", { agents: { defaults: { model: { primary: "model-a" } } } }],
    [
      "absent provider",
      {
        agents: { defaults: { model: { primary: "inference/model-a" } } },
        models: { providers: { other: { models: [] } } },
      },
    ],
    [
      "non-list provider models",
      {
        agents: { defaults: { model: { primary: "inference/model-a" } } },
        models: { providers: { inference: { models: {} } } },
      },
    ],
  ])("returns no primary budget for %s", (_case, config) => {
    expect(readOpenClawPrimaryReplyBudget(config)).toBeUndefined();
  });

  it("preserves a positive target budget before the inherited budget", () => {
    const modelConfig: ConfigObject = { maxTokens: 2048 };

    applyOpenClawAnthropicReplyBudget(modelConfig, 8192);

    expect(modelConfig.maxTokens).toBe(2048);
  });

  it("uses the package default when target and inherited budgets are invalid", () => {
    const modelConfig: ConfigObject = { maxTokens: -1 };

    applyOpenClawAnthropicReplyBudget(modelConfig, 1.5);

    expect(modelConfig.maxTokens).toBe(4096);
  });

  it("keeps captured installed runtime bytes stable for the process", () => {
    const installed = writeInstalledOpenClawRuntime();
    vi.stubEnv("HOME", installed.home);
    const modelConfig: ConfigObject = {};

    applyOpenClawAnthropicReplyBudget(modelConfig);
    expect(modelConfig.maxTokens).toBe(7777);

    fs.writeFileSync(installed.runtimePath, installedOpenClawRuntimeSource(8888));
    fs.writeFileSync(
      path.join(installed.root, ".nemoclaw-install.json"),
      `${JSON.stringify({ installedDigest: harnessPackageContentDigest(installed.root) })}\n`,
      { mode: 0o600 },
    );
    applyOpenClawAnthropicReplyBudget(modelConfig);
    expect(modelConfig.maxTokens).toBe(7777);

    fs.appendFileSync(installed.runtimePath, "// changed after installation\n");
    expect(readOpenClawPrimaryReplyBudget({})).toBe(7777);
  });

  it("rejects installed runtime drift before capturing the helper", () => {
    const installed = writeInstalledOpenClawRuntime();
    vi.stubEnv("HOME", installed.home);
    fs.appendFileSync(installed.runtimePath, "// changed after installation\n");

    expect(() => readOpenClawPrimaryReplyBudget({})).toThrow(
      "Harness installation receipt does not match package content",
    );
  });
});
