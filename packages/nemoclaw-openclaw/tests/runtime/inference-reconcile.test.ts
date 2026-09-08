// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { autoPairPythonScript, readOpenClawStartupSource } from "../helpers/startup-suite";
import { createCanonicalCliPairingFixture } from "../helpers/pair-settlement";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const RECONCILE = path.join(PACKAGE_ROOT, "runtime", "inference-reconcile.py");

function runImported(source: string, input = "") {
  return spawnSync("python3", ["-c", source, RECONCILE], {
    encoding: "utf8",
    input,
    timeout: 5000,
  });
}

describe("OpenClaw inference reconciliation", () => {
  it("emits only the nonce-bound receipt after convergence", () => {
    const requestId = "a".repeat(64);
    const result = runImported(
      [
        "import importlib.util, sys",
        "spec = importlib.util.spec_from_file_location('reconcile', sys.argv[1])",
        "module = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(module)",
        "module.reconcile_pairing = lambda: True",
        "raise SystemExit(module.main())",
      ].join("\n"),
      `${JSON.stringify({ requestId })}\n`,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${JSON.stringify({ status: "converged", requestId })}\n`);
    expect(result.stderr).toBe("");
  });

  it("rejects malformed requests without executing the pairing workflow", () => {
    const result = runImported(
      [
        "import importlib.util, sys",
        "spec = importlib.util.spec_from_file_location('reconcile', sys.argv[1])",
        "module = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(module)",
        "module.reconcile_pairing = lambda: (_ for _ in ()).throw(RuntimeError('must not run'))",
        "raise SystemExit(module.main())",
      ].join("\n"),
      `${JSON.stringify({ requestId: "stale" })}\n`,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("invokes one fixed shell workflow with bounded, silent execution", () => {
    const result = runImported(
      [
        "import importlib.util, subprocess, sys",
        "spec = importlib.util.spec_from_file_location('reconcile', sys.argv[1])",
        "module = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(module)",
        "calls = []",
        "def fake_run(argv, **kwargs):",
        "    calls.append((argv, kwargs))",
        "    return subprocess.CompletedProcess(argv, 0)",
        "assert module.reconcile_pairing(fake_run)",
        "assert calls[0][0] == ['/bin/bash', '-c', module.RECONCILE_SHELL]",
        "assert calls[0][1]['timeout'] == module.RECONCILE_TIMEOUT_SECONDS",
        "assert calls[0][1]['stdout'] == subprocess.DEVNULL",
        "assert calls[0][1]['stderr'] == subprocess.DEVNULL",
        "assert calls[0][1]['start_new_session'] is True",
        "assert module.AUTO_PAIR_DEADLINE_SECONDS + module.AUTO_PAIR_RUN_TIMEOUT_SECONDS < module.RECONCILE_TIMEOUT_SECONDS",
        "assert f'NEMOCLAW_AUTO_PAIR_DEADLINE_SECS={module.AUTO_PAIR_DEADLINE_SECONDS}' in module.RECONCILE_SHELL",
        "assert f'NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS={module.AUTO_PAIR_RUN_TIMEOUT_SECONDS}' in module.RECONCILE_SHELL",
        "assert 'export HOME=/sandbox' in module.RECONCILE_SHELL",
        "assert 'export OPENCLAW_HOME=/sandbox' in module.RECONCILE_SHELL",
        "assert 'export OPENCLAW_STATE_DIR=/sandbox/.openclaw' in module.RECONCILE_SHELL",
        "assert 'export OPENCLAW_CONFIG_PATH=/sandbox/.openclaw/openclaw.json' in module.RECONCILE_SHELL",
        "assert 'export OPENCLAW_OAUTH_DIR=/sandbox/.openclaw/credentials' in module.RECONCILE_SHELL",
      ].join("\n"),
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(fs.readFileSync(RECONCILE, "utf8")).not.toContain("openclaw agent");
    expect(fs.readFileSync(RECONCILE, "utf8")).not.toContain("nemoclaw-inference-reconcile-");
  });

  it("makes auto-pair one-shot exit at canonical settlement without writing status state", () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reconcile-"));
    const stateDirectory = path.join(temporaryDirectory, "state");
    const fakeOpenClaw = path.join(temporaryDirectory, "openclaw");
    const statusPath = path.join(temporaryDirectory, "status.json");
    const canonical = createCanonicalCliPairingFixture(stateDirectory);
    fs.writeFileSync(
      fakeOpenClaw,
      `#!/usr/bin/env bash\nprintf '%s\\n' ${JSON.stringify(JSON.stringify({ pending: [], paired: [canonical] }))}\n`,
      { mode: 0o755 },
    );
    const source = autoPairPythonScript(readOpenClawStartupSource()).replace(
      "STATUS_PATH = '/tmp/nemoclaw-auto-pair-status.json'",
      `STATUS_PATH = ${JSON.stringify(statusPath)}`,
    );
    try {
      const result = spawnSync("python3", ["-c", source, "--once"], {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_BIN: fakeOpenClaw,
          OPENCLAW_STATE_DIR: stateDirectory,
        },
        timeout: 5000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("canonical CLI baseline settled");
      expect(fs.existsSync(statusPath)).toBe(false);
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("installs the exact manifest command as a root-owned read-only image artifact", () => {
    const manifest = fs.readFileSync(path.join(PACKAGE_ROOT, "manifest.yaml"), "utf8");
    const dockerfile = fs.readFileSync(path.join(PACKAGE_ROOT, "Dockerfile"), "utf8");

    expect(manifest).toContain("/usr/local/lib/nemoclaw/openclaw-startup/inference-reconcile.py");
    expect(dockerfile).toContain(
      "COPY --chmod=0444 packages/nemoclaw-openclaw/runtime/inference-reconcile.py /usr/local/lib/nemoclaw/openclaw-startup/inference-reconcile.py",
    );
    expect(dockerfile).toContain("inference-reconcile.py \\");
  });
});
