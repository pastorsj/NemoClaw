// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import type {
  HarnessDashboardUiDeclaration,
  HarnessProcessLifecycleDeclaration,
} from "@nvidia/nemoclaw-harness-contract";
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
      dashboard_ui?: HarnessDashboardUiDeclaration;
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
      port_resolution: "sandbox-secondary-forward",
      secondary_forward: {
        environment_variable: "NEMOCLAW_HERMES_API_PORT",
        preferred_port: 8642,
        range_start: 8642,
        range_end: 8652,
        label: "Hermes API",
        remedy:
          "Destroy a listed Hermes sandbox or stop a listed non-OpenShell listener, then rerun onboarding.",
      },
      timeout_seconds: 90,
      success_statuses: [200],
    });
    expect(manifest.forward_ports).toEqual([18789, 8642]);
    expect(manifest.dashboard_ui).toEqual({
      label: "Hermes dashboard",
      path: "/",
      port: 9119,
      enable_env: "NEMOCLAW_HERMES_DASHBOARD",
      port_env: "NEMOCLAW_HERMES_DASHBOARD_PORT",
      internal_port: 19119,
      internal_port_env: "NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT",
      tui_env: "NEMOCLAW_HERMES_DASHBOARD_TUI",
    });
    const startup = fs.readFileSync(
      path.join(PACKAGE_ROOT, "host", "source", "startup-adapter.cts"),
      "utf8",
    );
    for (const environmentName of [
      manifest.dashboard_ui?.enable_env,
      manifest.dashboard_ui?.port_env,
      manifest.dashboard_ui?.internal_port_env,
      manifest.dashboard_ui?.tui_env,
    ]) {
      expect(startup).toContain(environmentName);
    }
    const dockerfile = fs.readFileSync(path.join(PACKAGE_ROOT, "Dockerfile"), "utf8");
    expect(dockerfile).toContain(
      "COPY scripts/gateway-control.sh /usr/local/bin/nemoclaw-gateway-control",
    );
    expect(dockerfile).toContain("chmod 700 /usr/local/bin/nemoclaw-gateway-control");
  });
});
