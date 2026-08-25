// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import HarnessCommand from "./harness";

const rootDir = process.cwd();

describe("harness oclif command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the list and install command syntax", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await HarnessCommand.run([], rootDir);

    expect(log).toHaveBeenNthCalledWith(1, "Usage: nemoclaw harness list");
    expect(log).toHaveBeenNthCalledWith(2, "       nemoclaw harness install [harness]");
  });
});
