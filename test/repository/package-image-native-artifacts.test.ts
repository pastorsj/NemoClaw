// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { materializeHarnessRuntime } from "../../harness-contract/materialize-runtime.mts";

describe("publishable package image native artifacts", () => {
  it.each([
    ["managed-gateway", "runtime/managed-gateway-control.py"],
    ["messaging-build", "messaging/messaging-build.mts"],
  ] as const)(
    "materializes %s from the published contract into each package",
    (artifact, target) => {
      const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-package-"));
      try {
        materializeHarnessRuntime({ artifact, destination: target, workingDirectory: packageRoot });
        ["nemoclaw-hermes", "nemoclaw-openclaw"].forEach((packageName) => {
          expect(fs.readFileSync(path.join(packageRoot, target))).toEqual(
            fs.readFileSync(path.join("packages", packageName, target)),
          );
        });
      } finally {
        fs.rmSync(packageRoot, { force: true, recursive: true });
      }
    },
  );

  it("keeps the published gateway controller ID-neutral", () => {
    const source = fs
      .readFileSync(path.resolve("harness-contract/runtime/gateway-runtime.py"), "utf8")
      .toLowerCase();
    expect(source).not.toContain("openclaw");
    expect(source).not.toContain("hermes");
  });

  it("loads a synthetic future package profile through the fixed trusted path", () => {
    const systemRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-future-profile-"));
    const profile = path.join(systemRoot, "usr/local/lib/nemoclaw/managed-gateway-profile.py");
    fs.mkdirSync(path.dirname(profile), { recursive: true });
    fs.writeFileSync(
      profile,
      [
        "DIAGNOSTIC_PATTERNS = ()",
        "def agent_spec(environment): return {'name':'future','port':19444,'readiness_checks':()}",
        "def gateway_matches(argv, port): return argv == (b'future-gateway',) and port == 19444",
        "def preflight(environment, timeout, system_root): return None",
      ].join("\n"),
      { mode: 0o600 },
    );
    try {
      const source = path.resolve("harness-contract/runtime/gateway-runtime.py");
      const output = execFileSync(
        "python3",
        [
          "-c",
          [
            "import importlib.util,json,os,sys",
            "os.environ['NEMOCLAW_MANAGED_CONTROL_ALLOW_NONROOT_TEST']='1'",
            "os.environ['NEMOCLAW_MANAGED_CONTROL_SYSTEM_ROOT']=sys.argv[2]",
            "s=importlib.util.spec_from_file_location('runtime',sys.argv[1])",
            "m=importlib.util.module_from_spec(s);sys.modules[s.name]=m;s.loader.exec_module(m)",
            "p=m._load_profile();v=p.agent_spec({})",
            "print(json.dumps({'spec':v,'matches':p.gateway_matches((b'future-gateway',),19444)}))",
          ].join(";"),
          source,
          systemRoot,
        ],
        { encoding: "utf8" },
      );
      expect(JSON.parse(output)).toEqual({
        spec: { name: "future", port: 19444, readiness_checks: [] },
        matches: true,
      });
    } finally {
      fs.rmSync(systemRoot, { force: true, recursive: true });
    }
  });
});
