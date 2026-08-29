// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { INSTALLER_PAYLOAD, TEST_SYSTEM_PATH } from "../helpers/installer-sourced-env";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const STATION_REVISION = "a".repeat(40);
const STATION_GENERATION = "0123456789abcdef0123456789abcdef";

function runSourced(script: string, body: string, extraEnv: Record<string, string> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-host-"));
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-c", `source "$SCRIPT_UNDER_TEST" >/dev/null\n${body}`],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        HOME: home,
        PATH: TEST_SYSTEM_PATH,
        SCRIPT_UNDER_TEST: script,
        ...extraEnv,
      },
      timeout: 15_000,
      killSignal: "SIGKILL",
    },
  );
  return { home, result, output: `${result.stdout}${result.stderr}` };
}

describe("DGX Station express resume compatibility", () => {
  it("rejects resume under a different installer revision with exact rerun guidance", () => {
    const savedRevision = "b".repeat(40);
    const currentRevision = "c".repeat(40);
    const { result, output } = runSourced(
      INSTALLER_PAYLOAD,
      `
mkdir -p "$HOME/.nemoclaw"
chmod 0700 "$HOME/.nemoclaw"
printf 'revision=${savedRevision}\nmodel=nemotron-3-ultra-550b-a55b\ngeneration=${STATION_GENERATION}\n' >"$HOME/.nemoclaw/station-express-resume"
chmod 0600 "$HOME/.nemoclaw/station-express-resume"
station_installer_revision() { printf '${currentRevision}'; }
load_station_express_resume
`,
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toContain(`requires NemoClaw revision ${savedRevision}`);
    expect(output).toContain(`NEMOCLAW_INSTALL_TAG=${savedRevision}`);
  });
});
