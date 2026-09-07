// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");

describe("Haystack Agent POC image", () => {
  it("installs the typed Fabric path and exact Haystack release", () => {
    const dockerfile = fs.readFileSync(path.join(PACKAGE_ROOT, "Dockerfile"), "utf8");
    const base = fs.readFileSync(path.join(PACKAGE_ROOT, "Dockerfile.base"), "utf8");
    const manifest = fs.readFileSync(path.join(PACKAGE_ROOT, "manifest.yaml"), "utf8");
    const lock = fs.readFileSync(path.join(PACKAGE_ROOT, "fabric", "requirements.lock"), "utf8");
    expect(base).toContain('haystack-ai": "3.1.1');
    expect(base).toContain("iproute2=6.15.0-1");
    expect(base).toContain("iptables=1.8.11-2");
    expect(base).toContain("nftables=1.1.3-1");
    expect(lock).toMatch(/^haystack-ai==3\.1\.1 /mu);
    expect(lock).toMatch(/^nemo-fabric==0\.2\.0 /mu);
    expect(dockerfile).toContain("/usr/local/share/nemoclaw/haystack-agent.fabric-adapter.json");
    expect(dockerfile).toContain("nemoclaw_haystack_fabric.adapter");
    expect(dockerfile).toContain("nemoclaw-fabric-run --help >/dev/null");
    expect(dockerfile).toContain("'export NO_PROXY=localhost,127.0.0.1,::1'");
    expect(dockerfile).toContain("'unset ALL_PROXY all_proxy OPENAI_PROXY'");
    expect(dockerfile).toContain("COPY nemoclaw-blueprint/ /opt/nemoclaw-blueprint/");
    expect(dockerfile).toContain("/sandbox/.nemoclaw/blueprints/0.1.0");
    expect(dockerfile).toContain("test -s /sandbox/.nemoclaw/blueprints/0.1.0/blueprint.yaml");
    expect(manifest).toMatch(/headless_command: "nemoclaw-fabric-run\b/u);
    expect(manifest).toMatch(/prompt_transport: stdin/u);
    expect(manifest).toMatch(
      /headless_environment:\n    HAYSTACK_MANAGED_INFERENCE_ROUTE: nemoclaw-managed-inference/u,
    );
  });

  it("does not add excluded services or integration surfaces", () => {
    const packageText = [
      "Dockerfile",
      "Dockerfile.base",
      "manifest.yaml",
      "policy-additions.yaml",
      "start.sh",
    ]
      .map((file) => fs.readFileSync(path.join(PACKAGE_ROOT, file), "utf8"))
      .join("\n")
      .toLowerCase();
    for (const excluded of ["hayhooks", "telegram", "discord", "whatsapp", "mcp-haystack"]) {
      expect(packageText).not.toContain(excluded);
    }
    expect(packageText).not.toContain("managed-startup");
  });

  it("allows the shared NemoClaw curl probe through managed inference policy", () => {
    const policy = YAML.parse(
      fs.readFileSync(path.join(PACKAGE_ROOT, "policy-additions.yaml"), "utf8"),
    ) as {
      network_policies?: {
        managed_inference?: { binaries?: Array<{ path?: string }> };
      };
    };

    expect(policy.network_policies?.managed_inference?.binaries).toContainEqual({
      path: "/usr/bin/curl",
    });
  });

  it("provides the fixed curl executable used by the shared inference probe", () => {
    const dockerfile = fs.readFileSync(path.join(PACKAGE_ROOT, "Dockerfile"), "utf8");
    const base = fs.readFileSync(path.join(PACKAGE_ROOT, "Dockerfile.base"), "utf8");
    const pinnedCurl = "curl=8.14.1-2+deb13u4";

    expect(base).toContain(pinnedCurl);
    expect(dockerfile).toContain("if [ ! -x /usr/bin/curl ]");
    expect(dockerfile).toContain(pinnedCurl);
    expect(dockerfile).toContain("test -x /usr/bin/curl");
  });

  it("implements the generic source-build startup boundary", () => {
    const dockerfile = fs.readFileSync(path.join(PACKAGE_ROOT, "Dockerfile"), "utf8");
    const start = fs.readFileSync(path.join(PACKAGE_ROOT, "start.sh"), "utf8");

    expect(dockerfile).toMatch(/^ARG NEMOCLAW_CORPORATE_CA_B64=$/mu);
    expect(dockerfile).toContain("ARG NEMOCLAW_BUILD_ID=default");
    expect(dockerfile).toContain("NEMOCLAW_BUILD_ID=${NEMOCLAW_BUILD_ID}");
    expect(dockerfile).toContain("/usr/local/share/nemoclaw/haystack-proxy-host");
    expect(dockerfile).toContain("/usr/local/share/nemoclaw/haystack-proxy-port");
    expect(dockerfile).toContain("update-ca-certificates");
    expect(dockerfile).toMatch(
      /ARG NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER=root[\s\S]*USER \$\{NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER\}\nENTRYPOINT \["\/usr\/local\/bin\/nemoclaw-start"\]/u,
    );
    expect(start).toContain("setpriv --reuid=sandbox --regid=sandbox --init-groups");
    expect(start).toContain(
      'readonly MANAGED_PROXY_HOST_FILE="/usr/local/share/nemoclaw/haystack-proxy-host"',
    );
  });
});
