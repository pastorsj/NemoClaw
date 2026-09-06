// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const FABRIC_RUNNER_SOURCE = "/opt/nemoclaw-fabric-venv/bin/nemoclaw-fabric-run";
const FABRIC_RUNNER_COMMAND = "/usr/local/bin/nemoclaw-fabric-run";
const FABRIC_BASE_CHECK = "/usr/local/lib/nemoclaw/checks/image-probe.py";

describe("Deep Agents Code Fabric runtime entrypoint", () => {
  it("exposes and probes the command declared by the package manifest", () => {
    const dockerfile = fs.readFileSync(path.join(PACKAGE_ROOT, "Dockerfile"), "utf8");
    const manifest = fs.readFileSync(path.join(PACKAGE_ROOT, "manifest.yaml"), "utf8");

    expect(manifest).toContain('interactive_command: "dcode"');
    expect(manifest).toMatch(/headless_command: "nemoclaw-fabric-run\b/);
    expect(manifest).toMatch(/prompt_transport: stdin/);
    expect(dockerfile).toContain(`ln -s ${FABRIC_RUNNER_SOURCE} ${FABRIC_RUNNER_COMMAND}`);
    expect(dockerfile).toContain(
      `test "$(readlink ${FABRIC_RUNNER_COMMAND})" = "${FABRIC_RUNNER_SOURCE}"`,
    );
    expect(dockerfile).toContain(`test -x ${FABRIC_RUNNER_COMMAND}`);
    expect(dockerfile).toContain(`${FABRIC_RUNNER_COMMAND} --help >/dev/null`);
    expect(manifest).toContain(
      `${FABRIC_RUNNER_COMMAND} --help >/dev/null && echo NEMOCLAW_FABRIC_RUNNER_OK`,
    );
  });

  it("installs the package-owned Fabric base-image check", () => {
    const dockerfile = fs.readFileSync(path.join(PACKAGE_ROOT, "Dockerfile.base"), "utf8");
    const manifest = fs.readFileSync(path.join(PACKAGE_ROOT, "manifest.yaml"), "utf8");
    const probe = fs.readFileSync(path.join(PACKAGE_ROOT, "checks/image-probe.py"), "utf8");

    expect(manifest).toMatch(/base_image:\n(?: {4}.+\n)* {4}package_probe: true/mu);
    expect(dockerfile).toContain(
      `COPY --chmod=0555 packages/nemoclaw-langchain-deepagents-code/checks/image-probe.py ${FABRIC_BASE_CHECK}`,
    );
    expect(dockerfile).toContain(`&& ${FABRIC_BASE_CHECK} >/dev/null`);
    expect(probe).toContain('EXPECTED_DCODE_VERSION = "0.1.55"');
    expect(probe).toContain('PROBE_OK = "nemoclaw-image-probe-ok"');
    expect(probe).toContain("hashlib.sha256(Path(__file__).read_bytes()).hexdigest()");
  });
});
