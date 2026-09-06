// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../../state/registry";

const mocks = vi.hoisted(() => ({
  readSandboxConfig: vi.fn(),
  resolveAgentConfig: vi.fn(),
  runOpenshell: vi.fn(),
  writeSandboxConfig: vi.fn(),
}));

vi.mock("../../adapters/openshell/runtime", () => ({ runOpenshell: mocks.runOpenshell }));
vi.mock("../../sandbox/config", () => ({
  readSandboxConfig: mocks.readSandboxConfig,
  resolveAgentConfig: mocks.resolveAgentConfig,
  writeSandboxConfig: mocks.writeSandboxConfig,
}));

import { prepareLegacyHermesLightSkin } from "./legacy-skin";

describe("legacy Hermes terminal skin", () => {
  it("does not inspect native Hermes state for a synthetic package receipt", () => {
    const entry = {
      name: "alpha",
      agent: "hermes",
      harnessPackage: {
        kind: "agent-runtime",
        id: "future-harness",
        packageVersion: "1.0.0",
        contentDigest: "a".repeat(64),
      },
    } as SandboxEntry;

    prepareLegacyHermesLightSkin(
      "alpha",
      entry,
      { name: "hermes" },
      { TERM_PROGRAM: "Apple_Terminal", COLORFGBG: "0;15" },
    );

    expect(mocks.resolveAgentConfig).not.toHaveBeenCalled();
    expect(mocks.readSandboxConfig).not.toHaveBeenCalled();
    expect(mocks.writeSandboxConfig).not.toHaveBeenCalled();
    expect(mocks.runOpenshell).not.toHaveBeenCalled();
  });
});
