// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");

describe("Haystack Agent shell entry points", () => {
  it.each(["start.sh", "runtime/generate-config.sh"])("parses %s", (relativePath) => {
    const result = spawnSync("bash", ["-n", path.join(PACKAGE_ROOT, relativePath)], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });

  it("routes inference through OpenShell's HTTP proxy", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-haystack-runtime-"));
    const runtimeEnvironment = path.join(temporaryRoot, "proxy-env.sh");
    const stateRoot = path.join(temporaryRoot, "state");
    const proxyHost = path.join(temporaryRoot, "proxy-host");
    const proxyPort = path.join(temporaryRoot, "proxy-port");
    const fixture = path.join(temporaryRoot, "start.sh");
    fs.mkdirSync(stateRoot, { mode: 0o700 });
    fs.writeFileSync(proxyHost, "proxy.fixture\n", { mode: 0o444 });
    fs.writeFileSync(proxyPort, "1234\n", { mode: 0o444 });
    fs.chmodSync(proxyHost, 0o444);
    fs.chmodSync(proxyPort, 0o444);
    const source = fs
      .readFileSync(path.join(PACKAGE_ROOT, "start.sh"), "utf8")
      .replace(
        'readonly HAYSTACK_STATE_ROOT="/sandbox/.haystack-agent"',
        `readonly HAYSTACK_STATE_ROOT=${JSON.stringify(stateRoot)}`,
      )
      .replace(
        'readonly MANAGED_PROXY_HOST_FILE="/usr/local/share/nemoclaw/haystack-proxy-host"',
        `readonly MANAGED_PROXY_HOST_FILE=${JSON.stringify(proxyHost)}`,
      )
      .replace(
        'readonly MANAGED_PROXY_PORT_FILE="/usr/local/share/nemoclaw/haystack-proxy-port"',
        `readonly MANAGED_PROXY_PORT_FILE=${JSON.stringify(proxyPort)}`,
      )
      .replace(
        "readonly MANAGED_FILE_OWNER_UID=0",
        `readonly MANAGED_FILE_OWNER_UID=${String(process.getuid?.() ?? 0)}`,
      )
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
            NEMOCLAW_PROXY_HOST: "environment-override.fixture",
            NEMOCLAW_PROXY_PORT: "9999",
            NO_PROXY: "inference.local",
            no_proxy: "inference.local",
            ALL_PROXY: "http://untrusted.fixture:9999",
            all_proxy: "http://untrusted.fixture:9999",
            OPENAI_PROXY: "http://untrusted.fixture:9999",
          },
        },
      );
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(fs.statSync(runtimeEnvironment).mode & 0o777).toBe(0o444);
      const environment = Object.fromEntries(
        result.stdout
          .trim()
          .split("\n")
          .map((line) => line.split(/=(.*)/su).slice(0, 2) as [string, string]),
      );
      expect(environment.HTTP_PROXY).toBe("http://proxy.fixture:1234");
      expect(environment.HTTPS_PROXY).toBe("http://proxy.fixture:1234");
      expect(environment.NO_PROXY).toBe("localhost,127.0.0.1,::1,proxy.fixture");
      expect(environment.no_proxy).toBe("localhost,127.0.0.1,::1,proxy.fixture");
      expect(environment).not.toHaveProperty("ALL_PROXY");
      expect(environment).not.toHaveProperty("all_proxy");
      expect(environment).not.toHaveProperty("OPENAI_PROXY");
      expect(fs.readFileSync(runtimeEnvironment, "utf8")).not.toMatch(
        /credential|inference[.]local|NEMOCLAW_PROXY_/u,
      );

      fs.chmodSync(proxyHost, 0o600);
      const tampered = spawnSync(fixture, ["/usr/bin/true"], {
        cwd: PACKAGE_ROOT,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "" },
      });
      expect(tampered.status).not.toBe(0);
      expect(tampered.stderr).toContain("Unsafe ownership or mode");
    } finally {
      fs.rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });
});
