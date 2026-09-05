// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");

describe("DeepSeek Harness shell entry points", () => {
  it.each(["start.sh", "runtime/generate-config.sh"])("parses %s", (relativePath) => {
    const result = spawnSync("bash", ["-n", path.join(PACKAGE_ROOT, relativePath)], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });

  it("persists the managed route for later NemoClaw execs", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-deepseek-runtime-"));
    const runtimeEnvironment = path.join(temporaryRoot, "proxy-env.sh");
    const stateRoot = path.join(temporaryRoot, "state");
    const fixture = path.join(temporaryRoot, "start.sh");
    fs.mkdirSync(stateRoot, { mode: 0o700 });
    const source = fs
      .readFileSync(path.join(PACKAGE_ROOT, "start.sh"), "utf8")
      .replace(
        "export DSH_HOME=/sandbox/.deepseek-harness",
        `export DSH_HOME=${JSON.stringify(stateRoot)}`,
      )
      .replace('if [ "$(id -u)" -eq 0 ]; then', "if false; then")
      .replace(
        "local target=/tmp/nemoclaw-proxy-env.sh",
        `local target=${JSON.stringify(runtimeEnvironment)}`,
      )
      .replace(
        'staged="$(mktemp /tmp/nemoclaw-proxy-env.XXXXXX)"',
        `staged=\"$(mktemp ${JSON.stringify(`${temporaryRoot}/proxy-env.XXXXXX`)})\"`,
      );
    fs.writeFileSync(fixture, source, { mode: 0o755 });

    try {
      const result = spawnSync(
        fixture,
        ["/bin/bash", "-c", `. ${runtimeEnvironment}; /usr/bin/env`],
        {
          cwd: PACKAGE_ROOT,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH ?? "",
            HTTP_PROXY: "http://credential@untrusted.fixture:9999",
            HTTPS_PROXY: "http://credential@untrusted.fixture:9999",
            NEMOCLAW_PROXY_HOST: "proxy.fixture",
            NEMOCLAW_PROXY_PORT: "1234",
            NO_PROXY: "inference.local",
            no_proxy: "inference.local",
          },
        },
      );
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(fs.statSync(runtimeEnvironment).mode & 0o777).toBe(0o444);
      expect(result.stdout).toContain("HTTP_PROXY=http://proxy.fixture:1234");
      expect(result.stdout).toContain("NO_PROXY=localhost,127.0.0.1,::1,proxy.fixture");
      expect(fs.readFileSync(runtimeEnvironment, "utf8")).not.toMatch(
        /credential|inference[.]local|NEMOCLAW_PROXY_/u,
      );
    } finally {
      fs.rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });
});
