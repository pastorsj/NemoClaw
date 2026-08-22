// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  printHarnessPackageList: vi.fn(),
}));

vi.mock("../../lib/harness/list-command", () => ({
  printHarnessPackageList: mocks.printHarnessPackageList,
}));

import HarnessListCommand from "./list";

const rootDir = process.cwd();

describe("harness list oclif command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prints harness packages", async () => {
    await HarnessListCommand.run([], rootDir);

    expect(mocks.printHarnessPackageList).toHaveBeenCalledWith(expect.any(Function));
  });

  it("rejects positional arguments", async () => {
    await expect(HarnessListCommand.run(["openclaw"], rootDir)).rejects.toThrow();

    expect(mocks.printHarnessPackageList).not.toHaveBeenCalled();
  });
});
