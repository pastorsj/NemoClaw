// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listBundledHarnessPackages: vi.fn(),
  listInstalledHarnessPackages: vi.fn(),
}));

vi.mock("./package-registry", () => ({
  listBundledHarnessPackages: mocks.listBundledHarnessPackages,
  listInstalledHarnessPackages: mocks.listInstalledHarnessPackages,
}));

import {
  buildHarnessPackageList,
  printHarnessPackageList,
  renderHarnessPackageList,
} from "./list-command";

function harnessPackage(id: string, source: "bundled" | "installed", version = "1.0.0") {
  return {
    id,
    packageName: `nemoclaw-${id}`,
    version,
    rootDir: `/tmp/${source}/${id}`,
    manifestPath: `/tmp/${source}/${id}/manifest.yaml`,
    source,
  } as const;
}

describe("harness package list command support", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listBundledHarnessPackages.mockReturnValue([]);
    mocks.listInstalledHarnessPackages.mockReturnValue([]);
  });

  it("renders installed and available packages in separate sections", () => {
    expect(
      renderHarnessPackageList({
        installed: [harnessPackage("openclaw", "installed")],
        available: [harnessPackage("hermes", "bundled", "2.0.0")],
      }),
    ).toBe(
      [
        "Installed agent runtime packages:",
        "  openclaw  nemoclaw-openclaw@1.0.0  installed",
        "",
        "Available agent runtime packages:",
        "  hermes    nemoclaw-hermes@2.0.0    bundled",
      ].join("\n"),
    );
  });

  it("excludes an installed bundled package from the available list", () => {
    mocks.listInstalledHarnessPackages.mockReturnValue([harnessPackage("openclaw", "installed")]);
    mocks.listBundledHarnessPackages.mockReturnValue([
      harnessPackage("openclaw", "bundled"),
      harnessPackage("hermes", "bundled", "2.0.0"),
    ]);

    expect(buildHarnessPackageList()).toEqual({
      installed: [
        {
          id: "openclaw",
          packageName: "nemoclaw-openclaw",
          version: "1.0.0",
          source: "installed",
        },
      ],
      available: [
        {
          id: "hermes",
          packageName: "nemoclaw-hermes",
          version: "2.0.0",
          source: "bundled",
        },
      ],
    });
    expect(mocks.listInstalledHarnessPackages).toHaveBeenCalledOnce();
    expect(mocks.listBundledHarnessPackages).toHaveBeenCalledOnce();
  });

  it("prints both empty sections when the registry has no packages", () => {
    const log = vi.fn();

    printHarnessPackageList(log);

    expect(log).toHaveBeenCalledWith(
      [
        "Installed agent runtime packages:",
        "  No agent runtime packages are installed.",
        "",
        "Available agent runtime packages:",
        "  No bundled agent runtime packages are available to install.",
      ].join("\n"),
    );
  });
});
