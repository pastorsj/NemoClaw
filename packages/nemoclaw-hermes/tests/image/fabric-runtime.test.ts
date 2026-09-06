// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const FABRIC_RUNNER_SOURCE = "/opt/nemoclaw-fabric-venv/bin/nemoclaw-fabric-run";
const FABRIC_RUNNER_COMMAND = "/usr/local/bin/nemoclaw-fabric-run";
const BASE_IMAGE_PROBE = "/usr/local/lib/nemoclaw/checks/image-probe.py";

describe("Hermes Fabric runtime entrypoint", () => {
  it("exposes and probes the command declared by the package manifest", () => {
    const dockerfile = fs.readFileSync(path.join(PACKAGE_ROOT, "Dockerfile"), "utf8");
    const manifest = fs.readFileSync(path.join(PACKAGE_ROOT, "manifest.yaml"), "utf8");

    expect(manifest).toContain('interactive_command: "hermes"');
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

  it("installs the proxy with the runner and keeps the released adapter with Hermes", () => {
    const dockerfile = fs.readFileSync(path.join(PACKAGE_ROOT, "Dockerfile"), "utf8");
    const proxyInstall = [
      "/opt/nemoclaw-fabric-venv/bin/pip3 install --no-index --no-cache-dir --no-deps \\",
      '        "$runner_wheel" "$proxy_wheel"',
    ].join("\n");

    expect(dockerfile).toContain("ENV NEMOCLAW_HERMES_ADAPTER_PYTHON=/opt/hermes/.venv/bin/python");
    expect(dockerfile).not.toContain("ENV ADAPTER_PYTHON=");
    expect(dockerfile).toContain(proxyInstall);
    expect(dockerfile).toContain(
      'expected = {"nemoclaw-fabric": "0.1.2", "nemoclaw-hermes-fabric": "0.1.0",',
    );
    expect(dockerfile).toContain("import nemoclaw_hermes_fabric.adapter");
    expect(dockerfile).toContain(
      "/opt/hermes/.venv/bin/python -I -c 'from importlib.metadata import distribution, distributions, version;",
    );
    expect(dockerfile).toContain("import nemo_fabric_adapters.hermes.adapter");
    expect(dockerfile).toContain('assert "nemoclaw-hermes-fabric" not in names');
    expect(dockerfile).toContain('assert "nemo-fabric-adapters-hermes" not in names');
  });

  it("owns the managed base-image runtime probe selected by its manifest", () => {
    const dockerfile = fs.readFileSync(path.join(PACKAGE_ROOT, "Dockerfile.base"), "utf8");
    const manifest = fs.readFileSync(path.join(PACKAGE_ROOT, "manifest.yaml"), "utf8");
    const probe = fs.readFileSync(path.join(PACKAGE_ROOT, "checks/image-probe.py"), "utf8");

    expect(manifest).toMatch(/base_image:\n(?: {4}.+\n)* {4}package_probe: true/mu);
    expect(dockerfile).toContain(
      `COPY --chmod=0555 packages/nemoclaw-hermes/checks/image-probe.py ${BASE_IMAGE_PROBE}`,
    );
    expect(dockerfile).toContain(`${BASE_IMAGE_PROBE} >/dev/null`);
    expect(probe).toContain('PROBE_OK = "nemoclaw-image-probe-ok"');
    expect(probe).toContain('metadata.version("agent-client-protocol") == "0.9.0"');
    expect(probe).toContain("hashlib.sha256(Path(__file__).read_bytes()).hexdigest()");
  });
});
