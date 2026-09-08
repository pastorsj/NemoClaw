// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import type {
  HarnessDevicePairingSettlementDeclaration,
  HarnessProcessLifecycleDeclaration,
  HarnessSessionQualificationDeclaration,
} from "@nvidia/nemoclaw-harness-contract";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");

describe("OpenClaw process lifecycle declaration", () => {
  it("selects core rebuild and endpoint-smoke behavior as package data", () => {
    const manifest = parse(fs.readFileSync(path.join(PACKAGE_ROOT, "manifest.yaml"), "utf8")) as {
      managed_image?: { rebuild_base_image?: unknown };
      inference?: { sandbox_smoke?: unknown };
    };

    expect(manifest.managed_image?.rebuild_base_image).toBe("not-required");
    expect(manifest.inference?.sandbox_smoke).toEqual({
      kind: "compatible-endpoint",
      config_path: "/sandbox/.openclaw/openclaw.json",
    });
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
    } satisfies HarnessProcessLifecycleDeclaration;

    expect(manifest.runtime?.process_lifecycle).toEqual(expected);
    expect(manifest.health_probe).toEqual({
      url: "http://127.0.0.1:18789/health",
      port: 18789,
      timeout_seconds: 30,
      success_statuses: [200, 401],
    });
    expect(manifest.forward_ports).toEqual([18789]);
    const dockerfile = fs.readFileSync(path.join(PACKAGE_ROOT, "Dockerfile"), "utf8");
    expect(dockerfile).toContain(
      "COPY scripts/gateway-control.sh /usr/local/bin/nemoclaw-gateway-control",
    );
    expect(dockerfile).toContain("chmod 700 /usr/local/bin/nemoclaw-gateway-control");
  });
});

describe("OpenClaw device-pairing settlement declaration", () => {
  it("materializes the fixed package command in the managed image", () => {
    const manifest = parse(fs.readFileSync(path.join(PACKAGE_ROOT, "manifest.yaml"), "utf8")) as {
      runtime?: { device_pairing_settlement?: unknown; session_qualification?: unknown };
    };
    const expected = {
      command: ["/usr/local/bin/nemoclaw-device-pairing-settle"],
      timeout_seconds: 130,
    } satisfies HarnessDevicePairingSettlementDeclaration;

    expect(manifest.runtime?.device_pairing_settlement).toEqual(expected);
    expect(manifest.runtime?.session_qualification).toEqual({
      command: ["/usr/local/bin/nemoclaw-session-qualify"],
      timeout_seconds: 30,
    } satisfies HarnessSessionQualificationDeclaration);
    const dockerfile = fs.readFileSync(path.join(PACKAGE_ROOT, "Dockerfile"), "utf8");
    expect(dockerfile).toContain(
      "COPY --chmod=0555 packages/nemoclaw-openclaw/runtime/device-pairing-settle.sh /usr/local/bin/nemoclaw-device-pairing-settle",
    );
    expect(dockerfile).toContain(
      "check_metadata /usr/local/bin/nemoclaw-device-pairing-settle 'root:root:555'",
    );
    expect(dockerfile).toContain(
      "COPY --chmod=0555 packages/nemoclaw-openclaw/runtime/session-qualify.py /usr/local/bin/nemoclaw-session-qualify",
    );
    expect(
      fs.readFileSync(path.join(PACKAGE_ROOT, "runtime", "session-qualify.py"), "utf8"),
    ).toMatch(/^#!\/usr\/bin\/python3\n/u);
    expect(dockerfile).toContain(
      "check_metadata /usr/local/bin/nemoclaw-session-qualify 'root:root:555'",
    );
  });
});
