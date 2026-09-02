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
  readOpenClawStartupSource,
} from "../helpers/startup-suite";

describe("workspace seed step-down", () => {
  const src = readOpenClawStartupSource();

  function writeTemplates(templatesDir: string) {
    fs.mkdirSync(templatesDir, { recursive: true });
    for (const name of [
      "AGENTS.md",
      "SOUL.md",
      "IDENTITY.md",
      "USER.md",
      "TOOLS.md",
      "HEARTBEAT.md",
      "BOOTSTRAP.md",
    ]) {
      fs.writeFileSync(
        path.join(templatesDir, name),
        `---\nsummary: "${name} template"\n---\n# ${name} template content\n`,
      );
    }
  }

  it("seeds through the shared sandbox step-down prefix", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-seed-step-down-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    const templatesDir = path.join(tmpDir, "templates");
    const stepDownLog = path.join(tmpDir, "step-down.log");
    fs.mkdirSync(workspaceDir, { recursive: true });
    writeTemplates(templatesDir);
    const configPath = path.join(tmpDir, "openclaw.json");
    fs.writeFileSync(configPath, JSON.stringify({ agents: { defaults: { skipBootstrap: true } } }));
    const scriptPath = path.join(tmpDir, "seed-as-sandbox.sh");
    const runStepDown = [
      extractShellFunctionFromSource(src, "_step_down_extract_function"),
      extractShellFunctionFromSource(src, "run_step_down_as_sandbox"),
    ].join("\n");
    const seedAsSandbox = extractShellFunctionFromSource(
      src,
      "seed_default_workspace_templates_as_sandbox",
    ).replace(
      "seed_default_workspace_templates /sandbox/.openclaw/workspace '' /sandbox/.openclaw/openclaw.json",
      `seed_default_workspace_templates ${JSON.stringify(workspaceDir)} ${JSON.stringify(templatesDir)} ${JSON.stringify(configPath)}`,
    );
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `STEP_DOWN_LOG=${JSON.stringify(stepDownLog)}`,
        `STEP_DOWN_PREFIX_SANDBOX=(bash -c 'printf "%s\\n" "$0" >"$STEP_DOWN_LOG"; exec "$@"' sandbox-step-down)`,
        extractShellFunctionFromSource(src, "seed_default_workspace_templates"),
        runStepDown,
        seedAsSandbox,
        "seed_default_workspace_templates_as_sandbox",
      ].join("\n"),
      { mode: 0o700 },
    );
    try {
      const result = spawnSync("bash", [scriptPath], {
        encoding: "utf-8",
        env: { ...process.env, STEP_DOWN_LOG: stepDownLog },
        timeout: 5000,
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(fs.readFileSync(stepDownLog, "utf-8").trim()).toBe("sandbox-step-down");
      expect(fs.existsSync(path.join(workspaceDir, "AGENTS.md"))).toBe(true);
      expect(fs.existsSync(path.join(workspaceDir, "SOUL.md"))).toBe(true);
      expect(fs.existsSync(path.join(workspaceDir, "BOOTSTRAP.md"))).toBe(false);
      expect(result.stderr).toContain("seeded 6 default workspace template");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("run_step_down_as_sandbox", () => {
  const src = readOpenClawStartupSource();
  const helper = [
    extractShellFunctionFromSource(src, "_step_down_extract_function"),
    extractShellFunctionFromSource(src, "run_step_down_as_sandbox"),
  ].join("\n");

  it("dispatches via a temp script and cleans up after success", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-step-down-helper-"));
    const stepDownLog = path.join(tmpDir, "step-down.log");
    const marker = path.join(tmpDir, "marker");
    const scriptPath = path.join(tmpDir, "run.sh");
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `STEP_DOWN_PREFIX_SANDBOX=(bash -c 'printf "%s\\n" "$2" >${JSON.stringify(stepDownLog)}; exec "$@"' sandbox-step-down)`,
        `payload_fn() { printf 'ran\\n' >${JSON.stringify(marker)}; }`,
        helper,
        "run_step_down_as_sandbox 'payload_fn' payload_fn",
      ].join("\n"),
      { mode: 0o700 },
    );
    try {
      const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(fs.readFileSync(marker, "utf-8").trim()).toBe("ran");
      const tempScriptPath = fs.readFileSync(stepDownLog, "utf-8").trim();
      expect(tempScriptPath).toMatch(/^\/tmp\/nemoclaw-step-down-[A-Za-z0-9]{6}\.sh$/);
      expect(fs.existsSync(tempScriptPath)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("removes the temp script even when the step-down body fails", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-step-down-fail-"));
    const stepDownLog = path.join(tmpDir, "step-down.log");
    const scriptPath = path.join(tmpDir, "run.sh");
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        `STEP_DOWN_PREFIX_SANDBOX=(bash -c 'printf "%s\\n" "$2" >${JSON.stringify(stepDownLog)}; exec "$@"' sandbox-step-down)`,
        "failing_fn() { return 7; }",
        helper,
        "run_step_down_as_sandbox 'failing_fn' failing_fn",
        'printf "EXIT=%s\\n" "$?"',
      ].join("\n"),
      { mode: 0o700 },
    );
    try {
      const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("EXIT=7");
      const tempScriptPath = fs.readFileSync(stepDownLog, "utf-8").trim();
      expect(tempScriptPath).toMatch(/^\/tmp\/nemoclaw-step-down-[A-Za-z0-9]{6}\.sh$/);
      expect(fs.existsSync(tempScriptPath)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("survives a heredoc used as an if-condition's command without bash declare -f reordering the then-body into the heredoc", () => {
    // Regression: bash `declare -f` serialises a function whose `if`
    // condition is a heredoc-bearing command by placing the indented
    // `then`-body command BEFORE the heredoc closer. When the
    // step-down shell re-parses that output, it consumes the displaced
    // command as part of the heredoc body, leaves the `then` block
    // empty, and aborts on the closing `fi` with
    //   syntax error near unexpected token `fi'
    // (the exact text NV QA reported on v0.0.58 after the earlier fix
    // that handled only the heredoc-as-last-statement shape). The new
    // helper bypasses `declare -f` and reads the function source
    // verbatim from disk via `shopt -s extdebug` + `declare -F`, so
    // every here-doc placement survives intact.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-step-down-heredoc-if-"));
    const stepDownLog = path.join(tmpDir, "step-down.log");
    const sentinel = path.join(tmpDir, "ran.txt");
    const scriptPath = path.join(tmpDir, "run.sh");
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `STEP_DOWN_PREFIX_SANDBOX=(bash -c 'printf "%s\\n" "$2" >${JSON.stringify(stepDownLog)}; exec "$@"' sandbox-step-down)`,
        `SENTINEL=${JSON.stringify(sentinel)}`,
        // Mirror seed_default_workspace_templates' broken shape exactly:
        // a heredoc-bearing `node` invocation as the `if` condition,
        // with a `then`-body command, followed by `fi`. This is the
        // shape `declare -f` mangles in bash 5.x.
        "heredoc_in_if_condition() {",
        '  local marker="$1"',
        "  if ! node - \"$marker\" <<'NODE' >/dev/null 2>&1; then",
        'const fs = require("fs");',
        "const target = process.argv[2];",
        'fs.writeFileSync(target, "ran-via-heredoc-if\\n");',
        "process.exit(0);",
        "NODE",
        "    return 0",
        "  fi",
        "}",
        helper,
        "run_step_down_as_sandbox 'heredoc_in_if_condition \"$SENTINEL\"' heredoc_in_if_condition",
      ].join("\n"),
      { mode: 0o700 },
    );
    try {
      const result = spawnSync("bash", [scriptPath], {
        encoding: "utf-8",
        env: { ...process.env, SENTINEL: sentinel },
        timeout: 5000,
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stderr).not.toContain("syntax error near unexpected token `fi'");
      expect(result.stderr).not.toContain("bash -n syntax check");
      // The heredoc body ran in the step-down shell: it wrote the sentinel.
      expect(fs.existsSync(sentinel)).toBe(true);
      expect(fs.readFileSync(sentinel, "utf-8")).toBe("ran-via-heredoc-if\n");
      const tempScriptPath = fs.readFileSync(stepDownLog, "utf-8").trim();
      expect(tempScriptPath).toMatch(/^\/tmp\/nemoclaw-step-down-[A-Za-z0-9]{6}\.sh$/);
      expect(fs.existsSync(tempScriptPath)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("survives heredoc-bearing function bodies through the temp-script round-trip", () => {
    // The production caller passes functions whose bodies contain a
    // `<<'TAG'` heredoc (e.g. `python3 - <<'PYAUTH' ...`). This test
    // mirrors that shape with two adjacent heredocs to exercise the
    // declare-f → file → bash dispatch and assert both bodies run
    // end-to-end without the `syntax error near unexpected token 'fi'`
    // that the older `bash -c "$(declare -f ...) ..."` route reported.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-step-down-heredoc-"));
    const stepDownLog = path.join(tmpDir, "step-down.log");
    const outPath = path.join(tmpDir, "out.txt");
    const altPath = path.join(tmpDir, "alt.txt");
    const scriptPath = path.join(tmpDir, "run.sh");
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `STEP_DOWN_PREFIX_SANDBOX=(bash -c 'printf "%s\\n" "$2" >${JSON.stringify(stepDownLog)}; exec "$@"' sandbox-step-down)`,
        `OUT_PATH=${JSON.stringify(outPath)}`,
        `ALT_PATH=${JSON.stringify(altPath)}`,
        // Mimic write_auth_profile's `python3 - <<'PYAUTH'` shape, including
        // a second function with its own heredoc, to ensure declare -f
        // round-trips both bodies through the temp script intact.
        "heredoc_one() {",
        '  if [ -z "${OUT_PATH:-}" ]; then',
        "    return",
        "  fi",
        "  python3 - \"$OUT_PATH\" <<'PYONE'",
        "import sys",
        "with open(sys.argv[1], 'w') as fh:",
        "    fh.write('heredoc-one-ok\\n')",
        "PYONE",
        "}",
        "heredoc_two() {",
        '  if [ -z "${ALT_PATH:-}" ]; then',
        "    return",
        "  fi",
        "  python3 - \"$ALT_PATH\" <<'PYTWO'",
        "import sys",
        "with open(sys.argv[1], 'w') as fh:",
        "    fh.write('heredoc-two-ok\\n')",
        "PYTWO",
        "}",
        helper,
        "run_step_down_as_sandbox 'heredoc_one; heredoc_two' heredoc_one heredoc_two",
      ].join("\n"),
      { mode: 0o700 },
    );
    try {
      const result = spawnSync("bash", [scriptPath], {
        encoding: "utf-8",
        env: { ...process.env, OUT_PATH: outPath, ALT_PATH: altPath },
        timeout: 5000,
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(fs.readFileSync(outPath, "utf-8")).toBe("heredoc-one-ok\n");
      expect(fs.readFileSync(altPath, "utf-8")).toBe("heredoc-two-ok\n");
      const tempScriptPath = fs.readFileSync(stepDownLog, "utf-8").trim();
      expect(tempScriptPath).toMatch(/^\/tmp\/nemoclaw-step-down-[A-Za-z0-9]{6}\.sh$/);
      expect(fs.existsSync(tempScriptPath)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("setup_auth_profile_as_sandbox", () => {
  const src = readOpenClawStartupSource();
  const helper = [
    extractShellFunctionFromSource(src, "_step_down_extract_function"),
    extractShellFunctionFromSource(src, "run_step_down_as_sandbox"),
  ].join("\n");
  const setup = extractShellFunctionFromSource(src, "setup_auth_profile_as_sandbox");
  it("runs the auth-profile setup under HOME=/sandbox even when the parent env has HOME=/root", () => {
    // setpriv preserves the parent shell's environment, so the root
    // entrypoint's HOME=/root would otherwise leak into the step-down
    // shell and `write_auth_profile`'s `~/.openclaw/...` expansion
    // would target /root. Stub `write_auth_profile` to record the
    // HOME the step-down shell actually observed and assert it was
    // overridden to /sandbox.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-setup-auth-profile-"));
    const observedHome = path.join(tmpDir, "observed-home");
    const scriptPath = path.join(tmpDir, "run.sh");
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "export HOME=/root",
        "STEP_DOWN_PREFIX_SANDBOX=(env)",
        "openclaw_config_dir_owner() { echo sandbox; }",
        `write_auth_profile() { printf '%s\\n' "$HOME" >${JSON.stringify(observedHome)}; }`,
        "harden_auth_profiles() { :; }",
        helper,
        setup,
        "setup_auth_profile_as_sandbox",
      ].join("\n"),
      { mode: 0o700 },
    );
    try {
      const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(fs.readFileSync(observedHome, "utf-8").trim()).toBe("/sandbox");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("ensure_mutable_openclaw_config_hash root-mode step-down", () => {
  const src = readOpenClawStartupSource();
  const configHashRecord = /^[0-9a-f]{64}\s+openclaw\.json\n[0-9a-f]{64}\s+fabric\.json$/;

  function runHashRefresh(opts: { asRoot: boolean; preexistingHash?: string }) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hash-refresh-"));
    const configDir = path.join(tmpDir, "openclaw");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "openclaw.json");
    const hashPath = path.join(configDir, ".config-hash");
    fs.writeFileSync(configPath, "{}\n");
    fs.writeFileSync(path.join(configDir, "fabric.json"), "{}\n");
    if (opts.preexistingHash !== undefined) {
      fs.writeFileSync(hashPath, opts.preexistingHash);
    }
    const stepDownLog = path.join(tmpDir, "step-down.log");
    const scriptPath = path.join(tmpDir, "run.sh");
    const helperFn = extractShellFunctionFromSource(
      src,
      "ensure_mutable_openclaw_config_hash",
    ).replaceAll("/sandbox/.openclaw", configDir);
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        opts.asRoot
          ? 'id() { if [ "${1:-}" = "-u" ]; then printf "0"; else command id "$@"; fi; }'
          : 'id() { if [ "${1:-}" = "-u" ]; then printf "1000"; else command id "$@"; fi; }',
        'openclaw_config_dir_owner() { printf "sandbox"; }',
        `STEP_DOWN_PREFIX_SANDBOX=(bash -c 'printf "step-down\\n" >>${JSON.stringify(stepDownLog)}; exec "$@"' sandbox-step-down)`,
        helperFn,
        "ensure_mutable_openclaw_config_hash",
      ].join("\n"),
      { mode: 0o700 },
    );
    const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
    const hashAfter = fs.existsSync(hashPath) ? fs.readFileSync(hashPath, "utf-8").trim() : "";
    const stepDownInvocations = fs.existsSync(stepDownLog)
      ? fs.readFileSync(stepDownLog, "utf-8").trim().split("\n").filter(Boolean).length
      : 0;
    return { tmpDir, result, hashAfter, stepDownInvocations };
  }

  it("routes the sha256sum write through the sandbox step-down prefix when uid=0", () => {
    const { tmpDir, result, hashAfter, stepDownInvocations } = runHashRefresh({ asRoot: true });
    try {
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(stepDownInvocations).toBe(1);
      expect(hashAfter).toMatch(configHashRecord);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips the step-down prefix when already running as non-root", () => {
    const { tmpDir, result, hashAfter, stepDownInvocations } = runHashRefresh({ asRoot: false });
    try {
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(stepDownInvocations).toBe(0);
      expect(hashAfter).toMatch(configHashRecord);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("overwrites a stale hash without leaving the partial write behind", () => {
    const { tmpDir, result, hashAfter } = runHashRefresh({
      asRoot: true,
      preexistingHash: "stale-content\n",
    });
    try {
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(hashAfter).not.toContain("stale-content");
      expect(hashAfter).toMatch(configHashRecord);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Reproduces the production EACCES condition in-process. CI cannot drop
  // CAP_DAC_OVERRIDE on a real uid=0 entrypoint, so we substitute: a
  // pre-existing .config-hash that is read-only to its owner is the
  // closest single-uid analog of "root cannot bypass the write bit".
  // The first phase asserts the precondition (direct redirection
  // genuinely fails on the read-only file); the second runs the
  // production function under a step-down prefix that relaxes the
  // perms (mirroring how setpriv puts the write through the owner
  // uid with full DAC) and asserts the hash refresh now succeeds.
  it("the direct redirection fails on a read-only hash file but the step-down path recovers it", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hash-eacces-"));
    try {
      const configDir = path.join(tmpDir, "openclaw");
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = path.join(configDir, "openclaw.json");
      const hashPath = path.join(configDir, ".config-hash");
      fs.writeFileSync(configPath, "{}\n");
      fs.writeFileSync(path.join(configDir, "fabric.json"), "{}\n");
      fs.writeFileSync(hashPath, "placeholder\n");
      fs.chmodSync(hashPath, 0o444);

      // Phase 1: prove that a direct `>` redirection against the
      // read-only hash file genuinely fails (the surrogate for the
      // production EACCES).
      const directProbe = spawnSync(
        "sh",
        ["-c", `cd ${JSON.stringify(configDir)} && sha256sum openclaw.json >".config-hash"`],
        { encoding: "utf-8", timeout: 5000 },
      );
      const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;
      if (runningAsRoot && directProbe.status === 0) {
        // Some platform CI runners execute the WSL distro as uid 0 with DAC
        // override, so the single-uid chmod surrogate cannot prove EACCES.
        // Reset the fixture and still verify the production step-down path.
        fs.writeFileSync(hashPath, "placeholder\n");
        fs.chmodSync(hashPath, 0o444);
      } else {
        expect(directProbe.status).not.toBe(0);
        expect(directProbe.stderr.toLowerCase()).toContain("permission denied");
        expect(fs.readFileSync(hashPath, "utf-8")).toBe("placeholder\n");
      }

      // Phase 2: the production function runs the same redirection
      // through `STEP_DOWN_PREFIX_SANDBOX`, here stubbed to relax the
      // hash file so the inner sh can write (mirroring the production
      // owner-uid step-down restoring effective write access).
      const stepDownLog = path.join(tmpDir, "step-down.log");
      const scriptPath = path.join(tmpDir, "run.sh");
      const helperFn = extractShellFunctionFromSource(
        src,
        "ensure_mutable_openclaw_config_hash",
      ).replaceAll("/sandbox/.openclaw", configDir);
      fs.writeFileSync(
        scriptPath,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'id() { if [ "${1:-}" = "-u" ]; then printf "0"; else command id "$@"; fi; }',
          'openclaw_config_dir_owner() { printf "sandbox"; }',
          `export HASH_PATH=${JSON.stringify(hashPath)}`,
          `STEP_DOWN_PREFIX_SANDBOX=(bash -c 'printf "step-down\\n" >>${JSON.stringify(stepDownLog)}; chmod 0660 "$HASH_PATH"; exec "$@"' sandbox-step-down)`,
          helperFn,
          "ensure_mutable_openclaw_config_hash",
        ].join("\n"),
        { mode: 0o700 },
      );
      const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(fs.readFileSync(stepDownLog, "utf-8").trim().split("\n").filter(Boolean)).toHaveLength(
        1,
      );
      expect(fs.readFileSync(hashPath, "utf-8").trim()).toMatch(configHashRecord);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("direct-root entrypoint composition under CAP_DAC_OVERRIDE drop", () => {
  const src = readOpenClawStartupSource();

  it("runs the helper chain end-to-end against a simulated root entrypoint", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-direct-root-"));
    const configDir = path.join(tmpDir, "openclaw");
    const sandboxHome = path.join(tmpDir, "sandbox");
    const proxyEnvFile = path.join(tmpDir, "nemoclaw-proxy-env.sh");
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(sandboxHome, { recursive: true });

    const configPath = path.join(configDir, "openclaw.json");
    const hashPath = path.join(configDir, ".config-hash");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ gateway: { port: 18789, auth: {} } }, null, 2) + "\n",
    );
    fs.writeFileSync(path.join(configDir, "fabric.json"), "{}\n");
    fs.writeFileSync(hashPath, "placeholder\n");
    fs.chmodSync(hashPath, 0o444);

    const bashrcPath = path.join(sandboxHome, ".bashrc");
    const profilePath = path.join(sandboxHome, ".profile");
    fs.writeFileSync(bashrcPath, "# stub bashrc\n");
    fs.writeFileSync(profilePath, "# stub profile\n");

    const scriptPath = path.join(tmpDir, "run.sh");
    const ensureHash = extractShellFunctionFromSource(
      src,
      "ensure_mutable_openclaw_config_hash",
    ).replaceAll("/sandbox/.openclaw", configDir);
    const readToken = extractShellFunctionFromSource(src, "_read_gateway_token").replaceAll(
      "/sandbox/.openclaw/openclaw.json",
      configPath,
    );
    const ensureToken = extractShellFunctionFromSource(src, "ensure_gateway_token").replaceAll(
      "/sandbox/.openclaw",
      configDir,
    );
    const ensureTokenIfMissing = extractShellFunctionFromSource(
      src,
      "ensure_gateway_token_if_missing",
    );
    const needsToken = extractShellFunctionFromSource(
      src,
      "needs_gateway_token_for_current_command",
    );
    const prepareToken = extractShellFunctionFromSource(
      src,
      "prepare_gateway_token_for_current_command",
    );
    const exportToken = extractShellFunctionFromSource(src, "export_gateway_token");
    const writeRuntimeStart = src.indexOf("write_runtime_shell_env() {");
    const writeRuntimeEnd = src.indexOf("\nensure_runtime_shell_env_shim() {", writeRuntimeStart);
    if (writeRuntimeStart === -1 || writeRuntimeEnd === -1) {
      throw new Error("expected write_runtime_shell_env in OpenClaw start.sh");
    }
    const writeRuntimeEnv = src
      .slice(writeRuntimeStart, writeRuntimeEnd)
      .replaceAll("/tmp/nemoclaw-proxy-env.sh", proxyEnvFile);
    const helper = [
      extractShellFunctionFromSource(src, "_step_down_extract_function"),
      extractShellFunctionFromSource(src, "run_step_down_as_sandbox"),
    ].join("\n");
    const setupAuth = extractShellFunctionFromSource(src, "setup_auth_profile_as_sandbox");
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'id() { if [ "${1:-}" = "-u" ]; then printf "0"; else command id "$@"; fi; }',
        'openclaw_config_dir_owner() { printf "sandbox"; }',
        "prepare_openclaw_config_for_write() { :; }",
        "restore_openclaw_config_after_write() { :; }",
        "NEMOCLAW_CMD=()",
        '_PROXY_URL=""',
        '_NO_PROXY_VAL=""',
        `STEP_DOWN_PREFIX_SANDBOX=(bash -c 'chmod 0660 ${JSON.stringify(hashPath)} 2>/dev/null; exec "$@"' sandbox-step-down)`,
        "lock_rc_files() {",
        '  for rc in "${1}/.bashrc" "${1}/.profile"; do',
        '    [ -f "$rc" ] && chmod 0444 "$rc"',
        "  done",
        "}",
        'emit_sandbox_sourced_file() { local target="$1"; cat > "$target"; chmod 444 "$target"; }',
        "write_auth_profile() { :; }",
        "harden_auth_profiles() { :; }",
        '_SANDBOX_SAFETY_NET=""',
        '_PROXY_FIX_SCRIPT=""',
        '_NEMOTRON_FIX_SCRIPT=""',
        '_CIAO_GUARD_SCRIPT=""',
        "emit_messaging_connect_runtime_preload_exports() { :; }",
        '_TOOL_REDIRECTS=("NEMOCLAW_TEST_REDIRECT=/tmp/nemoclaw-test")',
        'NODE_USE_ENV_PROXY=""',
        readToken,
        ensureHash,
        ensureToken,
        ensureTokenIfMissing,
        needsToken,
        prepareToken,
        exportToken,
        writeRuntimeEnv,
        helper,
        setupAuth,
        "ensure_mutable_openclaw_config_hash",
        "prepare_gateway_token_for_current_command",
        "export_gateway_token",
        "write_runtime_shell_env",
        `lock_rc_files ${JSON.stringify(sandboxHome)}`,
        "setup_auth_profile_as_sandbox",
        'echo "CONTINUATION_REACHED"',
      ].join("\n"),
      { mode: 0o700 },
    );

    try {
      const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 10000 });

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain("CONTINUATION_REACHED");

      expect(result.stderr).not.toContain("Missing gateway auth token");
      expect(result.stderr).not.toMatch(/syntax error near unexpected token .?fi/);

      const hashContents = fs.readFileSync(hashPath, "utf-8").trim();
      expect(hashContents).toMatch(/^[0-9a-f]{64}\s+openclaw\.json\n[0-9a-f]{64}\s+fabric\.json$/);
      expect((fs.statSync(hashPath).mode & 0o777).toString(8)).toBe("660");

      expect(fs.existsSync(proxyEnvFile)).toBe(true);
      const proxyEnv = fs.readFileSync(proxyEnvFile, "utf-8");
      expect(proxyEnv).toMatch(/OPENCLAW_GATEWAY_TOKEN='[A-Za-z0-9_-]{20,}'/);
      expect(proxyEnv).toContain("export OPENCLAW_GATEWAY_TOKEN");

      expect((fs.statSync(bashrcPath).mode & 0o777).toString(8)).toBe("444");
      expect((fs.statSync(profilePath).mode & 0o777).toString(8)).toBe("444");

      const updatedConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      expect(updatedConfig.gateway?.auth?.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
      expect(proxyEnv).toContain(`OPENCLAW_GATEWAY_TOKEN='${updatedConfig.gateway.auth.token}'`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
