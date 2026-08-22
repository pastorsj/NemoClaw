// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listHarnessPackages: vi.fn(),
}));

vi.mock("./package-registry", () => ({
  listHarnessPackages: mocks.listHarnessPackages,
}));

import { printHarnessPackageList, renderHarnessPackageList } from "./list-command";

describe("harness package list command support", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listHarnessPackages.mockReturnValue([]);
  });

  it("renders package identity and source in aligned columns", () => {
    expect(
      renderHarnessPackageList([
        {
          id: "openclaw",
          packageName: "nemoclaw-openclaw",
          version: "1.0.0",
          source: "installed",
        },
        {
          id: "hermes",
          packageName: "nemoclaw-hermes",
          version: "2.0.0",
          source: "bundled",
        },
      ]),
    ).toBe(
      [
        "openclaw  nemoclaw-openclaw@1.0.0  installed",
        "hermes    nemoclaw-hermes@2.0.0    bundled",
      ].join("\n"),
    );
  });

  it("renders the packages returned by the registry", () => {
    mocks.listHarnessPackages.mockReturnValue([
      {
        id: "openclaw",
        packageName: "nemoclaw-openclaw",
        version: "1.0.0",
        rootDir: "/tmp/openclaw",
        manifestPath: "/tmp/openclaw/manifest.yaml",
        source: "bundled",
      },
    ]);

    expect(renderHarnessPackageList()).toBe("openclaw  nemoclaw-openclaw@1.0.0  bundled");
    expect(mocks.listHarnessPackages).toHaveBeenCalledOnce();
  });

  it("prints a fallback when the registry has no packages", () => {
    const log = vi.fn();

    printHarnessPackageList(log);

    expect(log).toHaveBeenCalledWith("No harness packages are available.");
  });
});
