// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  extractShellFunctionFromSource,
  JSON5_MODULE,
  MUTABLE_CONFIG_NORMALIZER,
  readOpenClawStartupSource,
} from "../helpers/startup-suite";

describe("write_auth_profile (#1332)", () => {
  // Invokes write_auth_profile from the production start script in an isolated
  // HOME, then asserts on the resulting auth-profiles.json — observable
  // behavior, not source-text shape.
  const wrapper = [
    "set -euo pipefail",
    extractShellFunctionFromSource(readOpenClawStartupSource(), "write_auth_profile"),
    "write_auth_profile",
  ].join("\n");

  function runWriteAuthProfile(env: Record<string, string>): {
    home: string;
    authPath: string;
    status: number;
    stderr: string;
  } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auth-test-"));
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

  it("writes profile under the route identifier from NEMOCLAW_INFERENCE_PROVIDER_ID", () => {
    const { home, authPath, status, stderr } = runWriteAuthProfile({
      NVIDIA_INFERENCE_API_KEY: "secret",
      NEMOCLAW_INFERENCE_PROVIDER_ID: "openai",
    });
    try {
      expect(status, stderr).toBe(0);
      const profile = JSON.parse(fs.readFileSync(authPath, "utf-8"));
      expect(profile).toEqual({
        "openai:manual": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", id: "NVIDIA_INFERENCE_API_KEY" },
          profileId: "openai:manual",
        },
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("falls back to 'inference' when neither route identifier is set", () => {
    const { home, authPath, status, stderr } = runWriteAuthProfile({
      NVIDIA_INFERENCE_API_KEY: "secret",
    });
    try {
      expect(status, stderr).toBe(0);
      const profile = JSON.parse(fs.readFileSync(authPath, "utf-8"));
      expect(profile).toHaveProperty("inference:manual");
      expect(profile["inference:manual"].provider).toBe("inference");
      expect(profile).not.toHaveProperty("nvidia:manual");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not use 'nvidia' as the default provider key", () => {
    const { home, authPath, status } = runWriteAuthProfile({
      NVIDIA_INFERENCE_API_KEY: "secret",
    });
    try {
      expect(status).toBe(0);
      const profile = JSON.parse(fs.readFileSync(authPath, "utf-8"));
      expect(Object.keys(profile).every((key) => !/^nvidia:/.test(key))).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("treats provider_key as a literal (no shell command substitution)", () => {
    // If the provider_key were interpolated into the heredoc instead of
    // passed as argv, $(...) inside the value would execute and replace it.
    const { home, authPath, status, stderr } = runWriteAuthProfile({
      NVIDIA_INFERENCE_API_KEY: "secret",
      NEMOCLAW_INFERENCE_PROVIDER_ID: "$(echo pwned)",
    });
    try {
      expect(status, stderr).toBe(0);
      const profile = JSON.parse(fs.readFileSync(authPath, "utf-8"));
      expect(profile).toHaveProperty("$(echo pwned):manual");
      expect(profile["$(echo pwned):manual"].provider).toBe("$(echo pwned)");
      expect(profile).not.toHaveProperty("pwned:manual");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("is a no-op when NVIDIA_INFERENCE_API_KEY is unset", () => {
    const { home, authPath, status } = runWriteAuthProfile({});
    try {
      expect(status).toBe(0);
      expect(fs.existsSync(authPath)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("writes the auth profile with 0600 permissions", () => {
    const { home, authPath, status } = runWriteAuthProfile({
      NVIDIA_INFERENCE_API_KEY: "secret",
      NEMOCLAW_INFERENCE_PROVIDER_ID: "openai",
    });
    try {
      expect(status).toBe(0);
      const mode = fs.statSync(authPath).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// openclaw.json baseline + recovery (#3118)
//
// Upstream OpenShell's `openshell inference set` (run inside the sandbox)
// truncates openclaw.json to 0 bytes when the write fails. We can't fix
// OpenShell from here, but we CAN recover from the result on next sandbox
// start: write_openclaw_config_baseline() captures a known-good copy on
// first successful start, and recover_openclaw_config_if_empty() restores
// from that baseline (or from OpenClaw's own openclaw.json.last-good if
// present) when the active config is empty/whitespace-only.
// ─────────────────────────────────────────────────────────────────────────────
describe("openclaw.json baseline + recovery (#3118)", () => {
  const src = readOpenClawStartupSource();

  function extractShellFunction(name: string): string {
    const match = src.match(new RegExp(`${name}\\(\\) \\{([\\s\\S]*?)^\\}`, "m"));
    if (!match) {
      throw new Error(`Expected ${name} in OpenClaw start.sh`);
    }
    return `${name}() {${match[1]}\n}`;
  }

  type RecoveryFixture = {
    configContent: string;
    baselineContent?: string;
    lastGoodContent?: string;
    hashContent?: string;
  };

  function runRecoverIfEmpty(fixture: RecoveryFixture) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-recover-"));
    const openclawDir = path.join(root, ".openclaw");
    fs.mkdirSync(openclawDir, { recursive: true });
    const configPath = path.join(openclawDir, "openclaw.json");
    const hashPath = path.join(openclawDir, ".config-hash");
    const baselinePath = path.join(openclawDir, "openclaw.json.nemoclaw-baseline");
    const lastGoodPath = path.join(openclawDir, "openclaw.json.last-good");

    fs.writeFileSync(configPath, fixture.configContent);
    if (fixture.hashContent !== undefined) fs.writeFileSync(hashPath, fixture.hashContent);
    if (fixture.baselineContent !== undefined) {
      fs.writeFileSync(baselinePath, fixture.baselineContent);
    }
    if (fixture.lastGoodContent !== undefined) {
      fs.writeFileSync(lastGoodPath, fixture.lastGoodContent);
    }

    const helperFns = extractShellFunction("normalize_mutable_config_perms").replace(
      'local config_dir="/sandbox/.openclaw"',
      `local config_dir=${JSON.stringify(openclawDir)}`,
    );
    const fn = extractShellFunction("recover_openclaw_config_if_empty").replaceAll(
      "/sandbox",
      root,
    );
    const wrapper = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `export NEMOCLAW_MUTABLE_CONFIG_NORMALIZER=${JSON.stringify(MUTABLE_CONFIG_NORMALIZER)}`,
      `${extractShellFunction("resolve_mutable_config_normalizer")}\n${helperFns}`,
      fn,
      "recover_openclaw_config_if_empty",
    ]
      .filter(Boolean)
      .join("\n");
    const script = path.join(root, "run.sh");
    fs.writeFileSync(script, wrapper, { mode: 0o700 });
    const result = spawnSync("bash", [script], { encoding: "utf-8" });
    const config = fs.readFileSync(configPath, "utf-8");
    const hash = fs.existsSync(hashPath) ? fs.readFileSync(hashPath, "utf-8") : "";
    fs.rmSync(root, { recursive: true, force: true });
    return { result, config, hash };
  }

  it("restores openclaw.json from .nemoclaw-baseline when current file is empty", () => {
    const baseline = JSON.stringify({ ok: true, source: "baseline" });
    const { result, config } = runRecoverIfEmpty({
      configContent: "",
      baselineContent: baseline,
    });
    expect(result.status).toBe(0);
    expect(config).toBe(baseline);
    expect(`${result.stdout}${result.stderr}`).toContain("restored");
  });

  it("restores from openclaw.json.last-good when present (preferred over baseline)", () => {
    const lastGood = JSON.stringify({ ok: true, source: "last-good" });
    const baseline = JSON.stringify({ ok: true, source: "baseline" });
    const { result, config } = runRecoverIfEmpty({
      configContent: "",
      baselineContent: baseline,
      lastGoodContent: lastGood,
    });
    expect(result.status).toBe(0);
    expect(config).toBe(lastGood);
  });

  it("treats whitespace-only config as empty and restores from baseline", () => {
    const baseline = JSON.stringify({ ok: true });
    const { result, config } = runRecoverIfEmpty({
      configContent: "   \n\t  \n",
      baselineContent: baseline,
    });
    expect(result.status).toBe(0);
    expect(config).toBe(baseline);
  });

  it("is a no-op when openclaw.json is non-empty", () => {
    const original = JSON.stringify({ ok: true, source: "original" });
    const baseline = JSON.stringify({ ok: true, source: "baseline" });
    const { result, config } = runRecoverIfEmpty({
      configContent: original,
      baselineContent: baseline,
    });
    expect(result.status).toBe(0);
    expect(config).toBe(original);
  });

  it("fails loudly and leaves file empty when no recovery source exists", () => {
    // Mutable mode + empty config + no baseline = recovery cannot proceed.
    // Soft-fail would let startup continue with the still-empty file and
    // crash later in a less obvious place; recover_openclaw_config_if_empty
    // returns non-zero so `set -e` aborts the entrypoint here.
    const { result, config } = runRecoverIfEmpty({ configContent: "" });
    expect(result.status).not.toBe(0);
    expect(config).toBe("");
    expect(result.stderr).toContain("#3118");
    expect(result.stderr).toContain("No baseline available");
  });

  it("recomputes .config-hash after restoring from baseline", () => {
    const baseline = JSON.stringify({ ok: true });
    const { result, hash } = runRecoverIfEmpty({
      configContent: "",
      baselineContent: baseline,
      hashContent: "stale-hash\n",
    });
    expect(result.status).toBe(0);
    expect(hash).toContain("openclaw.json");
    expect(hash).not.toContain("stale-hash");
  });

  // ── write_openclaw_config_baseline ────────────────────────────────────────
  function runNormalizeMutableConfigPermsWithBaseline(fixture: { symlinkBaseline?: boolean } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-baseline-lock-"));
    const openclawDir = path.join(root, ".openclaw");
    fs.mkdirSync(openclawDir, { recursive: true });
    const configPath = path.join(openclawDir, "openclaw.json");
    const hashPath = path.join(openclawDir, ".config-hash");
    const baselinePath = path.join(openclawDir, "openclaw.json.nemoclaw-baseline");
    fs.writeFileSync(configPath, "{}");
    fs.writeFileSync(hashPath, "oldhash\n");
    fs.writeFileSync(baselinePath, JSON.stringify({ source: "baseline" }));
    fs.chmodSync(openclawDir, 0o2770);
    fs.chmodSync(configPath, 0o660);
    fs.chmodSync(hashPath, 0o660);
    fs.chmodSync(baselinePath, 0o460);
    const protectedTarget = path.join(root, "protected-target");
    fs.writeFileSync(protectedTarget, "protected", { mode: 0o640 });
    fs.chmodSync(protectedTarget, 0o640);
    switch (fixture.symlinkBaseline) {
      case true:
        fs.rmSync(baselinePath);
        fs.symlinkSync(protectedTarget, baselinePath);
        break;
    }

    const wrapper = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `export NEMOCLAW_MUTABLE_CONFIG_NORMALIZER=${JSON.stringify(MUTABLE_CONFIG_NORMALIZER)}`,
      `${extractShellFunction("resolve_mutable_config_normalizer")}\n${extractShellFunction("normalize_mutable_config_perms").replaceAll("/sandbox", root)}`,
      "normalize_mutable_config_perms",
    ]
      .filter(Boolean)
      .join("\n");
    const script = path.join(root, "run.sh");
    fs.writeFileSync(script, wrapper, { mode: 0o700 });
    const result = spawnSync("bash", [script], { encoding: "utf-8" });
    const baselineIsSymlink = fs.lstatSync(baselinePath).isSymbolicLink();
    const baselineMode = baselineIsSymlink ? undefined : fs.statSync(baselinePath).mode & 0o777;
    const protectedMode = fs.statSync(protectedTarget).mode & 0o777;
    fs.rmSync(root, { recursive: true, force: true });
    return { result, baselineIsSymlink, baselineMode, protectedMode };
  }
  it("keeps the baseline read-only after mutable permission normalization", () => {
    const { result, baselineMode } = runNormalizeMutableConfigPermsWithBaseline();
    expect(result.status).toBe(0);
    expect(baselineMode).toBe(0o440);
  });

  it("fails closed when mutable permission normalization sees a symlinked baseline", () => {
    const outcome = runNormalizeMutableConfigPermsWithBaseline({ symlinkBaseline: true });
    const { result, baselineIsSymlink, protectedMode } = outcome;
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("descriptor-safe repair detected an unsafe link");
    expect(baselineIsSymlink).toBe(true);
    expect(protectedMode).toBe(0o640);
  });
  function runCaptureCandidate(
    configContent: string,
    options: { baselineContent?: string; json5Module?: string } = {},
  ) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-baseline-capture-"));
    const openclawDir = path.join(root, ".openclaw");
    const baselinePath = path.join(openclawDir, "openclaw.json.nemoclaw-baseline");
    fs.mkdirSync(openclawDir);
    fs.writeFileSync(path.join(openclawDir, "openclaw.json"), configContent);
    fs.writeFileSync(path.join(openclawDir, ".config-hash"), "hash\n");
    if (options.baselineContent !== undefined) {
      fs.writeFileSync(baselinePath, options.baselineContent, { mode: 0o460 });
    }
    fs.chmodSync(openclawDir, 0o2770);
    fs.chmodSync(path.join(openclawDir, "openclaw.json"), 0o660);
    fs.chmodSync(path.join(openclawDir, ".config-hash"), 0o660);
    const harness = [
      "import importlib.util, os, sys",
      "spec = importlib.util.spec_from_file_location('normalizer', sys.argv[1])",
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "root_fd, source_fd = module.normalize_owner_tree(sys.argv[2], os.geteuid(), os.getegid(), capture_baseline=True, node_binary=sys.argv[3], json5_module=sys.argv[4])",
      "try:",
      "    if source_fd is None:",
      "        print('NONE')",
      "    else:",
      "        os.lseek(source_fd, 0, os.SEEK_SET)",
      "        sys.stdout.buffer.write(b'SOURCE\\n' + os.read(source_fd, 16 * 1024 * 1024 + 1))",
      "finally:",
      "    if source_fd is not None: os.close(source_fd)",
      "    os.close(root_fd)",
    ].join("\n");
    const result = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        harness,
        MUTABLE_CONFIG_NORMALIZER,
        openclawDir,
        process.execPath,
        options.json5Module ?? JSON5_MODULE,
      ],
      { encoding: "utf-8" },
    );
    const baselineExists = fs.existsSync(baselinePath);
    const baselineContent = baselineExists ? fs.readFileSync(baselinePath, "utf-8") : "";
    const baselineMode = baselineExists ? fs.statSync(baselinePath).mode & 0o777 : undefined;
    fs.rmSync(root, { recursive: true, force: true });
    const sourceContent = result.stdout.startsWith("SOURCE\n")
      ? result.stdout.slice("SOURCE\n".length)
      : undefined;
    return { result, baselineExists, baselineContent, baselineMode, sourceContent };
  }

  it("captures a stable valid config through the owner-only helper", () => {
    const config = JSON.stringify({ agents: { defaults: { model: { primary: "x" } } } });
    const captured = runCaptureCandidate(config);
    expect(captured.result.status).toBe(0);
    expect(captured.sourceContent).toBe(config);
    expect(captured.baselineExists).toBe(false);
  });

  it("selects current config to replace a sandbox-owned baseline", () => {
    const stale = JSON.stringify({ stale: true });
    const captured = runCaptureCandidate(JSON.stringify({ current: true }), {
      baselineContent: stale,
    });
    expect(captured.result.status).toBe(0);
    expect(captured.sourceContent).toBe(JSON.stringify({ current: true }));
    expect(captured.baselineContent).toBe(stale);
    expect(captured.baselineMode).toBe(0o440);
  });

  it.each(["", "   \n\t", "not json"])("does not capture invalid content %j", (content) => {
    const captured = runCaptureCandidate(content);
    expect(captured.result.status).toBe(0);
    expect(captured.sourceContent).toBeUndefined();
    expect(captured.baselineExists).toBe(false);
  });

  it("captures JSON5 comments and trailing commas", () => {
    const config = "{ // model\n agents: { defaults: { model: { primary: 'x' } } },\n}";
    const captured = runCaptureCandidate(config);
    expect(captured.result.status).toBe(0);
    expect(captured.sourceContent).toBe(config);
  });

  it("fails closed when the packaged JSON5 parser is unavailable", () => {
    const captured = runCaptureCandidate(JSON.stringify({ ok: true }), {
      json5Module: "/does/not/exist/json5",
    });
    expect(captured.result.status).not.toBe(0);
    expect(captured.result.stderr).toContain("JSON5 baseline validator failed");
    expect(captured.baselineExists).toBe(false);
  });

  it("delegates root baseline capture to the descriptor-safe normalizer", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-baseline-delegate-"));
    const openclawDir = path.join(root, ".openclaw");
    fs.mkdirSync(openclawDir);
    fs.writeFileSync(path.join(openclawDir, "openclaw.json"), "{}\n");
    const fn = extractShellFunction("write_openclaw_config_baseline").replaceAll("/sandbox", root);
    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          "set -euo pipefail",
          "id() { echo 0; }",
          "normalize_mutable_config_perms() { printf 'operation=%s\\n' \"$1\"; }",
          fn,
          "write_openclaw_config_baseline",
        ].join("\n"),
      ],
      { encoding: "utf-8" },
    );
    fs.rmSync(root, { recursive: true, force: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("operation=capture");
  });
});
