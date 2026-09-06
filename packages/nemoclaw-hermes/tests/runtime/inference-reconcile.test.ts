// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const RECONCILE = path.join(PACKAGE_ROOT, "runtime", "inference-reconcile.py");

function runImported(source: string, input = "") {
  return spawnSync("python3", ["-c", source, RECONCILE], {
    encoding: "utf8",
    input,
    timeout: 5000,
  });
}

describe("Hermes inference reconciliation", () => {
  it("emits only the nonce-bound receipt after convergence", () => {
    const requestId = "a".repeat(64);
    const result = runImported(
      [
        "import importlib.util, sys",
        "spec = importlib.util.spec_from_file_location('reconcile', sys.argv[1])",
        "module = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(module)",
        "module.reconcile_dashboard = lambda: True",
        "raise SystemExit(module.main())",
      ].join("\n"),
      `${JSON.stringify({ requestId })}\n`,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${JSON.stringify({ status: "converged", requestId })}\n`);
    expect(result.stderr).toBe("");
  });

  it("rejects malformed or extended requests without diagnostics", () => {
    const result = runImported(
      [
        "import importlib.util, sys",
        "spec = importlib.util.spec_from_file_location('reconcile', sys.argv[1])",
        "module = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(module)",
        "module.reconcile_dashboard = lambda: (_ for _ in ()).throw(RuntimeError('must not run'))",
        "raise SystemExit(module.main())",
      ].join("\n"),
      `${JSON.stringify({ requestId: "a".repeat(64), secret: "do-not-report" })}\n`,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("runs the fixed seeder command only for a safe dashboard directory", () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-reconcile-"));
    const currentHome = path.join(temporaryDirectory, "dashboard-home");
    fs.mkdirSync(currentHome);
    try {
      const result = runImported(
        [
          "import importlib.util, subprocess, sys",
          "spec = importlib.util.spec_from_file_location('reconcile', sys.argv[1])",
          "module = importlib.util.module_from_spec(spec)",
          "spec.loader.exec_module(module)",
          `module.CURRENT_DASHBOARD_HOME = ${JSON.stringify(currentHome)}`,
          `module.LEGACY_DASHBOARD_HOME = ${JSON.stringify(path.join(temporaryDirectory, "legacy"))}`,
          "destination = module.CURRENT_DASHBOARD_HOME + '/config.yaml'",
          "expected = ('[dashboard] seeded model routing and reviewed policy into ' + destination + '\\n').encode()",
          "calls = []",
          "def fake_run(argv, **kwargs):",
          "    calls.append((argv, kwargs))",
          "    return subprocess.CompletedProcess(argv, 0, b'', expected)",
          "assert module.reconcile_dashboard(fake_run)",
          "assert len(calls) == 1",
          "assert calls[0][0][0:3] == [module.PYTHON, '-I', module.SEEDER]",
          "assert calls[0][0][-1] == destination.replace('/config.yaml', '/.env')",
          "assert calls[0][1]['timeout'] == 20",
        ].join("\n"),
      );
      expect(result.status, result.stderr).toBe(0);
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("installs the exact manifest command as a root-owned read-only image artifact", () => {
    const manifest = fs.readFileSync(path.join(PACKAGE_ROOT, "manifest.yaml"), "utf8");
    const dockerfile = fs.readFileSync(path.join(PACKAGE_ROOT, "Dockerfile"), "utf8");

    expect(manifest).toContain("/usr/local/lib/nemoclaw/inference-reconcile.py");
    expect(dockerfile).toContain(
      "runtime/inference-reconcile.py /usr/local/lib/nemoclaw/inference-reconcile.py",
    );
    expect(dockerfile).toContain(
      "stat -c '%u:%g:%a' /usr/local/lib/nemoclaw/inference-reconcile.py)\" = '0:0:444'",
    );
  });
});
