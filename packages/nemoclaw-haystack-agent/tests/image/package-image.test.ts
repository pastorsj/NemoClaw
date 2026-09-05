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
});
