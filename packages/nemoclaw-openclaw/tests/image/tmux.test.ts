// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(import.meta.dirname, "../..");

describe("sandbox ships tmux for the bundled tmux-session flow (#4513)", () => {
  it("base image installs a pinned tmux in the apt package list", () => {
    const source = fs.readFileSync(path.join(packageRoot, "Dockerfile.base"), "utf-8");
    // Pinned (DL3008) tmux must be part of the single base apt-get install
    // layer so fresh builds ship it without a runtime apt round-trip.
    expect(source).toMatch(/tmux=[0-9]/);
  });

  it("runtime image repairs tmux on stale bases and asserts it at build time", () => {
    const source = fs.readFileSync(path.join(packageRoot, "Dockerfile"), "utf-8");
    // Stale GHCR bases predating the tmux addition must still converge: the
    // hardening layer detects a missing tmux, installs a pinned version, and
    // fails the build if tmux is still absent afterwards.
    expect(source).toContain("needs_tmux=1");
    expect(source).toMatch(/apt-get install -y --no-install-recommends tmux=[0-9]/);
    expect(source).toContain("command -v tmux >/dev/null");
  });

  it("base and runtime images pin tmux to the same version", () => {
    const baseSource = fs.readFileSync(path.join(packageRoot, "Dockerfile.base"), "utf-8");
    const runtimeSource = fs.readFileSync(path.join(packageRoot, "Dockerfile"), "utf-8");
    const baseVersion = baseSource.match(/tmux=([0-9][^\s\\]*)/)?.[1];
    const runtimeVersion = runtimeSource.match(
      /apt-get install -y --no-install-recommends tmux=([0-9][^\s\\;]*)/,
    )?.[1];
    expect(baseVersion).toBeDefined();
    expect(runtimeVersion).toBeDefined();
    expect(runtimeVersion).toBe(baseVersion);
  });
});
