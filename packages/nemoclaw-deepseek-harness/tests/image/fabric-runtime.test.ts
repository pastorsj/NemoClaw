// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");

describe("DeepSeek Harness image contract", () => {
  it("pins the published SDK and matching runtime in the hashed graph", () => {
    const requirements = fs.readFileSync(
      path.join(PACKAGE_ROOT, "fabric", "requirements.lock"),
      "utf8",
    );
    expect(requirements).toMatch(/^deepseek-harness-sdk==0\.1\.2rc1 \\/mu);
    expect(requirements).toMatch(/^deepseek-harness-runtime-bin==0\.1\.2rc1 \\/mu);
    expect(requirements).toMatch(/^nemo-fabric==0\.2\.0 \\/mu);
    expect(requirements).toContain("--hash=sha256:");
  });

  it("installs the generic runner and package adapter without a managed image claim", () => {
    const dockerfile = fs.readFileSync(path.join(PACKAGE_ROOT, "Dockerfile"), "utf8");
    const manifest = fs.readFileSync(path.join(PACKAGE_ROOT, "manifest.yaml"), "utf8");
    expect(dockerfile).toContain("/opt/nemoclaw-fabric-venv/bin/nemoclaw-fabric-run");
    expect(dockerfile).toContain("import nemoclaw_deepseek_fabric.adapter");
    expect(dockerfile).toContain("rm -rf /sandbox/.cache");
    expect(dockerfile).toContain("install -d -o sandbox -g sandbox -m 0700 /sandbox/.cache");
    expect(dockerfile).not.toMatch(/^\s*DEEPSEEK_MANAGED_INFERENCE_ROUTE=/mu);
    expect(manifest).toMatch(
      /version_command: "DSH_HOME=\/sandbox\/\.deepseek-harness \/opt\/nemoclaw-fabric-venv\/bin\/dsh --version"/u,
    );
    expect(manifest).toMatch(
      /- "DSH_HOME=\/sandbox\/\.deepseek-harness \/opt\/nemoclaw-fabric-venv\/bin\/dsh --version"/u,
    );
    expect(manifest).toMatch(/headless_command: "nemoclaw-fabric-run\b/u);
    expect(manifest).toMatch(
      /headless_environment:\n    DEEPSEEK_MANAGED_INFERENCE_ROUTE: nemoclaw-managed-inference/u,
    );
    expect(manifest).not.toMatch(/^managed_image:/mu);
    expect(manifest).toMatch(/mcp:\n  support: disabled/u);
  });

  it("uses only the SDK-minimal profile behind a separate process", () => {
    const processSource = fs.readFileSync(
      path.join(PACKAGE_ROOT, "fabric", "src", "nemoclaw_deepseek_fabric", "process.py"),
      "utf8",
    );
    expect(processSource).toContain('profile="sdk-minimal"');
    expect(processSource).toContain("request_timeout_seconds=60");
    expect(processSource).toContain("PR_SET_CHILD_SUBREAPER");
  });
});
