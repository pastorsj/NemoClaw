// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import type { HarnessProcessLifecycleDeclaration } from "@nvidia/nemoclaw-harness-contract";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");

describe("Hermes process lifecycle declaration", () => {
  it("selects core rebuild and policy behavior as package data", () => {
    const manifest = parse(fs.readFileSync(path.join(PACKAGE_ROOT, "manifest.yaml"), "utf8")) as {
      managed_image?: { rebuild_base_image?: unknown };
      mcp?: { policy_presets?: unknown };
    };

    expect(manifest.managed_image?.rebuild_base_image).toBe("pinned-remote");
    expect(manifest.mcp?.policy_presets).toEqual([
      "nous-web",
      "nous-image",
      "nous-audio",
      "nous-browser",
      "nous-code",
    ]);
  });

  it("binds managed actions to the root-owned package image controller", () => {
    const manifest = parse(fs.readFileSync(path.join(PACKAGE_ROOT, "manifest.yaml"), "utf8")) as {
      runtime?: { process_lifecycle?: unknown };
      health_probe?: unknown;
      forward_ports?: unknown;
    };
    const expected = {
      support: "managed",
      command: ["/usr/local/bin/nemoclaw-gateway-control"],
      revalidate_running_gateway: true,
    } satisfies HarnessProcessLifecycleDeclaration;

    expect(manifest.runtime?.process_lifecycle).toEqual(expected);
    expect(manifest.health_probe).toEqual({
      url: "http://localhost:8642/health",
      port: 8642,
      timeout_seconds: 90,
    });
    expect(manifest.forward_ports).toEqual([18789, 8642]);
    const dockerfile = fs.readFileSync(path.join(PACKAGE_ROOT, "Dockerfile"), "utf8");
    expect(dockerfile).toContain(
      "COPY scripts/gateway-control.sh /usr/local/bin/nemoclaw-gateway-control",
    );
    expect(dockerfile).toContain("chmod 700 /usr/local/bin/nemoclaw-gateway-control");
  });
});
