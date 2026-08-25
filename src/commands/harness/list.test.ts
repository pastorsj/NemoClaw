// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { testTimeoutOptions } from "../../../test/helpers/timeouts";

const mocks = vi.hoisted(() => ({
  buildHarnessPackageList: vi.fn(),
  printHarnessPackageList: vi.fn(),
}));

vi.mock("../../lib/harness/list-command", () => ({
  buildHarnessPackageList: mocks.buildHarnessPackageList,
  printHarnessPackageList: mocks.printHarnessPackageList,
}));

import HarnessListCommand from "./list";

const rootDir = process.cwd();
const packageList = {
  installed: [
    {
      id: "openclaw",
      packageName: "nemoclaw-openclaw",
      version: "1.0.0",
      source: "installed",
    },
  ],
  available: [],
};

describe("harness list oclif command", testTimeoutOptions(30_000), () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildHarnessPackageList.mockReturnValue(packageList);
  });

  it("prints installed and available agent runtime packages", async () => {
    await HarnessListCommand.run([], rootDir);

    expect(mocks.printHarnessPackageList).toHaveBeenCalledWith(expect.any(Function), packageList);
  });

  it("returns exactly installed and available package lists in JSON mode", async () => {
    const result = await HarnessListCommand.run(["--json"], rootDir);

    expect(HarnessListCommand.enableJsonFlag).toBe(true);
    expect(result).toEqual(packageList);
    expect(Object.keys(result as object)).toEqual(["installed", "available"]);
    expect(mocks.printHarnessPackageList).not.toHaveBeenCalled();
  });

  it("rejects positional arguments", async () => {
    await expect(HarnessListCommand.run(["openclaw"], rootDir)).rejects.toThrow();

    expect(mocks.printHarnessPackageList).not.toHaveBeenCalled();
  });
});
