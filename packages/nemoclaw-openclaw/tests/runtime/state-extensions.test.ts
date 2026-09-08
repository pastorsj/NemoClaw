// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const CONTROLLER = path.resolve(import.meta.dirname, "../../runtime/state-extensions.py");
const CREATE_INDEX = [
  "import json, sqlite3, sys",
  "db = sqlite3.connect(sys.argv[1])",
  'db.execute("CREATE TABLE installed_plugin_index (index_key TEXT PRIMARY KEY, install_records_json TEXT)")',
  'db.execute("INSERT INTO installed_plugin_index VALUES (?, ?)", ("installed-plugin-index", sys.argv[2]))',
  "db.commit()",
  "db.close()",
].join("\n");

function writeConfig(root: string, loadPaths: readonly string[] = []): void {
  fs.writeFileSync(
    path.join(root, "openclaw.json"),
    JSON.stringify({ plugins: { load: { paths: loadPaths } } }),
  );
}

function writeSqliteIndex(root: string, records: Readonly<Record<string, unknown>>): void {
  const database = path.join(root, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(database), { recursive: true });
  execFileSync("python3", ["-c", CREATE_INDEX, database, JSON.stringify(records)]);
}

function inspect(root: string): SpawnSyncReturns<string> {
  return spawnSync(CONTROLLER, [root, "inspect-managed-extensions"], {
    encoding: "utf8",
  });
}

describe("OpenClaw managed-extension controller", () => {
  it("projects SQLite install records into the harness-neutral response", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-extensions-"));
    try {
      const linked = "/opt/extensions/weather";
      writeConfig(root, [linked, "./user-owned"]);
      writeSqliteIndex(root, {
        weather: { source: "path", sourcePath: linked, installPath: linked },
        slack: {
          source: "npm",
          installPath: `${root}/extensions/slack`,
        },
      });

      const result = inspect(root);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        schemaVersion: 1,
        extensions: [
          { id: "slack", directory: "slack", configPaths: [] },
          { id: "weather", directory: null, configPaths: [linked] },
        ],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the legacy JSON index only when the SQLite index is absent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-extensions-"));
    try {
      writeConfig(root);
      fs.mkdirSync(path.join(root, "plugins"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "plugins", "installs.json"),
        JSON.stringify({
          installRecords: {
            weather: { source: "npm", installPath: `${root}/extensions/weather` },
          },
        }),
      );
      const result = inspect(root);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).extensions).toEqual([
        { id: "weather", directory: "weather", configPaths: [] },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed instead of masking a malformed SQLite index with legacy JSON", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-extensions-"));
    try {
      writeConfig(root);
      fs.mkdirSync(path.join(root, "state"), { recursive: true });
      fs.writeFileSync(path.join(root, "state", "openclaw.sqlite"), "not sqlite");
      fs.mkdirSync(path.join(root, "plugins"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "plugins", "installs.json"),
        JSON.stringify({ installRecords: {} }),
      );
      const result = inspect(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("managed-extension inspection failed");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["unknown operation", ["inspect-native-plugins"]],
    ["missing operation", []],
  ])("rejects an %s", (_name, arguments_) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-extensions-"));
    try {
      const result = spawnSync(CONTROLLER, [root, ...arguments_], {
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked native config", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-extensions-"));
    try {
      const outside = path.join(root, "outside.json");
      fs.writeFileSync(outside, JSON.stringify({ plugins: {} }));
      fs.symlinkSync(outside, path.join(root, "openclaw.json"));
      const result = inspect(root);
      expect(result.status).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a non-canonical native install path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-extensions-"));
    try {
      writeConfig(root);
      writeSqliteIndex(root, {
        weather: {
          source: "npm",
          installPath: `${root}/extensions/../outside`,
        },
      });
      expect(inspect(root).status).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects more than the bounded number of native records", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-extensions-"));
    try {
      writeConfig(root);
      writeSqliteIndex(
        root,
        Object.fromEntries(
          Array.from({ length: 129 }, (_, index) => [
            `extension-${String(index)}`,
            { source: "npm", installPath: `${root}/extensions/extension-${String(index)}` },
          ]),
        ),
      );
      expect(inspect(root).status).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
