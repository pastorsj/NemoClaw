// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const HERMES_PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const patcher = path.join(HERMES_PACKAGE_ROOT, "compat", "cron-execution.py");
const probes = path.join(HERMES_PACKAGE_ROOT, "checks", "image-probes.py");
const dockerfile = fs.readFileSync(path.join(HERMES_PACKAGE_ROOT, "Dockerfile"), "utf8");
const imageBuildProbes = fs.readFileSync(probes, "utf8");
const fixtures: string[] = [];

const upstreamExecutions = `\
import sqlite3
from hermes_constants import get_hermes_home

EXECUTIONS_FILE = None

def _connect():
    path = EXECUTIONS_FILE or (get_hermes_home().resolve() / "cron" / "executions.db")
    path.parent.mkdir(parents=True, exist_ok=True)
    return sqlite3.connect(path)
`;

const upstreamBackup = `\
_QUICK_STATE_FILES = (
    "state.db",
    "cron/jobs.json",
    "cron/executions.db",
)
`;

function fixtureFiles() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-cron-runtime-"));
  fixtures.push(fixture);
  const executions = path.join(fixture, "executions.py");
  const backup = path.join(fixture, "backup.py");
  fs.writeFileSync(executions, upstreamExecutions);
  fs.writeFileSync(backup, upstreamBackup);
  return { executions, backup };
}

function runPatcher(executions: string, backup: string) {
  return spawnSync("python3", ["-I", patcher, "--executions", executions, "--backup", backup], {
    encoding: "utf8",
    timeout: 5000,
  });
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

describe("Hermes cron execution runtime patch", () => {
  it("opens the ledger in writable runtime state and snapshots that path", () => {
    const files = fixtureFiles();

    const result = runPatcher(files.executions, files.backup);
    expect(result.status, result.stderr).toBe(0);
    const fixture = path.dirname(files.executions);
    const probe = `\
import importlib.util
import json
import pathlib
import sys
import types

home = pathlib.Path(sys.argv[3]).resolve()
constants = types.ModuleType("hermes_constants")
constants.get_hermes_home = lambda: home
sys.modules["hermes_constants"] = constants

def load(name, source):
    spec = importlib.util.spec_from_file_location(name, source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

executions = load("patched_executions", sys.argv[1])
backup = load("patched_backup", sys.argv[2])
connection = executions._connect()
database_path = pathlib.Path(connection.execute("PRAGMA database_list").fetchone()[2])
connection.close()
print(json.dumps({"database": str(database_path.relative_to(home)), "snapshot": list(backup._QUICK_STATE_FILES)}))
`;
    const probeResult = spawnSync(
      "python3",
      ["-I", "-c", probe, files.executions, files.backup, fixture],
      { encoding: "utf8", timeout: 5000 },
    );
    expect(probeResult.status, probeResult.stderr).toBe(0);
    expect(JSON.parse(probeResult.stdout)).toEqual({
      database: "runtime/cron-executions.db",
      snapshot: ["state.db", "cron/jobs.json", "runtime/cron-executions.db"],
    });
    expect(fs.existsSync(path.join(fixture, "cron", "executions.db"))).toBe(false);
  });

  function runCronRuntimeProbe(databasePath: string) {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-cron-probe-"));
    fixtures.push(fixture);
    const script = String.raw`
import importlib.util
import sqlite3
import sys
import types
from pathlib import Path

home = Path(sys.argv[2])

cron = types.ModuleType("cron")
cron.__path__ = []
executions = types.ModuleType("cron.executions")
executions.EXECUTIONS_FILE = None

def connect():
    path = executions.EXECUTIONS_FILE or (
        get_hermes_home().resolve() / sys.argv[3]
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    return sqlite3.connect(path)

executions._connect = connect
cron.executions = executions
sys.modules["cron"] = cron
sys.modules["cron.executions"] = executions

hermes_cli = types.ModuleType("hermes_cli")
hermes_cli.__path__ = []
backup = types.ModuleType("hermes_cli.backup")
backup._QUICK_STATE_FILES = (
    "state.db",
    "cron/jobs.json",
    "runtime/cron-executions.db",
)
hermes_cli.backup = backup
sys.modules["hermes_cli"] = hermes_cli
sys.modules["hermes_cli.backup"] = backup

constants = types.ModuleType("hermes_constants")
def get_hermes_home():
    return home
constants.get_hermes_home = get_hermes_home
sys.modules["hermes_constants"] = constants

spec = importlib.util.spec_from_file_location("image_build_probes", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.verify_cron_runtime_source()
`;

    const result = spawnSync("python3", ["-I", "-c", script, probes, fixture, databasePath], {
      encoding: "utf8",
      timeout: 5000,
    });

    return { fixture, result };
  }

  it("probes the resolved SQLite ledger path instead of the optional override", () => {
    const { fixture, result } = runCronRuntimeProbe("runtime/cron-executions.db");

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(fixture, "runtime", "cron-executions.db"))).toBe(true);
  });

  it("rejects the old cron ledger path even when the optional override stays empty", () => {
    const { fixture, result } = runCronRuntimeProbe("cron/executions.db");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("AssertionError");
    expect(fs.existsSync(path.join(fixture, "cron", "executions.db"))).toBe(true);
  });

  // source-shape-contract: security -- Exact hashes and installed probes bind the reviewed upstream patch to the shipped image
  it("hash-binds both upstream modules and requires installed-path build probes", () => {
    const digest = createHash("sha256").update(fs.readFileSync(patcher)).digest("hex");

    expect(dockerfile).toContain(`ARG NEMOCLAW_HERMES_CRON_RUNTIME_PATCHER_SHA256=${digest}`);
    expect(dockerfile).toContain(
      "ARG NEMOCLAW_HERMES_CRON_EXECUTIONS_SOURCE_SHA256=" +
        "b4a685a901abdffe2d1232099b3c27391775775a7011d52c90276cb15d3fd75d",
    );
    expect(dockerfile).toContain(
      "ARG NEMOCLAW_HERMES_BACKUP_SOURCE_SHA256=" +
        "b0838c1f2e120d8f97076c6321297077edc1f150dc6d4b84ba3d13327fcbb156",
    );
    expect(dockerfile).toContain(
      "COPY packages/nemoclaw-hermes/compat/cron-execution.py " +
        "/opt/nemoclaw-hermes-config/patch-cron-execution-runtime.py",
    );
    expect(dockerfile).toMatch(
      /patch-cron-execution-runtime[.]py \\\n\s+--executions \/opt\/hermes\/cron\/executions[.]py \\\n\s+--backup \/opt\/hermes\/hermes_cli\/backup[.]py/u,
    );
    expect(imageBuildProbes).toContain(
      'expected = get_hermes_home().resolve() / "runtime" / "cron-executions.db"',
    );
    expect(imageBuildProbes).toContain('assert "cron/executions.db" not in _QUICK_STATE_FILES');
  });
});
