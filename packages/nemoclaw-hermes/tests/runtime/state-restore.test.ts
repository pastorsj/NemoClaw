// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { HarnessStateLifecycleDeclaration } from "@nvidia/nemoclaw-harness-contract";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");

describe("Hermes package state restore", () => {
  it("declares and materializes dashboard reconciliation as one fixed package command", () => {
    const manifest = parse(fs.readFileSync(path.join(PACKAGE_ROOT, "manifest.yaml"), "utf8")) as {
      state_lifecycle: HarnessStateLifecycleDeclaration;
    };
    expect(manifest.state_lifecycle.rebuild.post_restore).toMatchObject({
      kind: "managed",
      command: {
        command: ["/usr/local/bin/nemoclaw-state-restore"],
        timeout_seconds: 60,
      },
    });
    const script = path.join(PACKAGE_ROOT, "runtime/state-restore.sh");
    expect(spawnSync("sh", ["-n", script]).status).toBe(0);
    const dockerfile = fs.readFileSync(path.join(PACKAGE_ROOT, "Dockerfile"), "utf8");
    expect(dockerfile).toContain(
      "COPY packages/nemoclaw-hermes/runtime/state-restore.sh /usr/local/bin/nemoclaw-state-restore",
    );
    expect(dockerfile).toContain(
      "check_metadata /usr/local/bin/nemoclaw-state-restore 'root:root 555'",
    );
  });
});
