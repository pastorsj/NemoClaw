// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");
const WRAPPER = path.join(REPOSITORY_ROOT, "scripts", "backup-workspace.sh");
const requireCompiled = createRequire(import.meta.url);
const registry = requireCompiled(
  path.join(REPOSITORY_ROOT, "dist", "lib", "harness", "package-registry.js"),
) as {
  installBundledHarness(id: string, env: NodeJS.ProcessEnv): { rootDir: string };
};
let home = "";

function installedBackupScript(homeDirectory: string): string {
  return path.join(
    homeDirectory,
    ".nemoclaw",
    "harnesses",
    "nemoclaw-openclaw",
    "scripts",
    "backup-workspace.sh",
  );
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-backup-wrapper-home-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("OpenClaw backup compatibility wrapper", () => {
  it("runs the helper from a qualified installed OpenClaw package", () => {
    registry.installBundledHarness("openclaw", { ...process.env, HOME: home });
    const helper = installedBackupScript(home);
    fs.writeFileSync(helper, "#!/bin/sh\nprintf 'installed:%s\\n' \"$1\"\n", { mode: 0o755 });

    const result = spawnSync(WRAPPER, ["probe"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("installed:probe\n");
  });

  it("rejects a helper-only installed directory before executing it", () => {
    const helper = installedBackupScript(home);
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.writeFileSync(helper, "#!/bin/sh\nprintf 'unqualified helper ran\\n'\n", { mode: 0o755 });

    const result = spawnSync(WRAPPER, ["probe"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("unqualified helper ran");
    expect(result.stderr).toContain("Installed OpenClaw harness package failed validation");
  });
});
