// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
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
    const result = spawnSync(path.join(PACKAGE_ROOT, "start.sh"), ["/usr/bin/env"], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HTTP_PROXY: "http://proxy.fixture:1234",
        HTTPS_PROXY: "http://proxy.fixture:1234",
        NO_PROXY: "inference.local",
        no_proxy: "inference.local",
        ALL_PROXY: "http://untrusted.fixture:9999",
        all_proxy: "http://untrusted.fixture:9999",
        OPENAI_PROXY: "http://untrusted.fixture:9999",
      },
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const environment = Object.fromEntries(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => line.split(/=(.*)/su).slice(0, 2) as [string, string]),
    );
    expect(environment.HTTP_PROXY).toBe("http://proxy.fixture:1234");
    expect(environment.HTTPS_PROXY).toBe("http://proxy.fixture:1234");
    expect(environment.NO_PROXY).toBe("localhost,127.0.0.1,::1");
    expect(environment.no_proxy).toBe("localhost,127.0.0.1,::1");
    expect(environment).not.toHaveProperty("ALL_PROXY");
    expect(environment).not.toHaveProperty("all_proxy");
    expect(environment).not.toHaveProperty("OPENAI_PROXY");
  });
});
