// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testTimeoutOptions } from "../../../test/helpers/timeouts";

const mocks = vi.hoisted(() => ({
  installBundledHarness: vi.fn(),
}));

vi.mock("../../lib/harness/package-registry", () => ({
  installBundledHarness: mocks.installBundledHarness,
}));

import HarnessInstallCommand from "./install";

const rootDir = process.cwd();

describe("harness install oclif command", testTimeoutOptions(30_000), () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.installBundledHarness.mockImplementation((id: string) => ({
      id,
      packageName: `nemoclaw-${id}`,
      version: "0.1.0",
      rootDir: `/tmp/${id}`,
      manifestPath: `/tmp/${id}/manifest.yaml`,
      source: "installed",
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["openclaw", "hermes", "langchain-deepagents-code"])(
    "installs the bundled %s harness",
    async (id) => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

      await HarnessInstallCommand.run([id], rootDir);

      expect(mocks.installBundledHarness).toHaveBeenCalledWith(id);
      expect(log).toHaveBeenCalledWith(`Agent runtime package '${id}' is installed.`);
    },
  );

  it("prints the same result when the harness install repeats", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await HarnessInstallCommand.run(["openclaw"], rootDir);
    await HarnessInstallCommand.run(["openclaw"], rootDir);

    expect(mocks.installBundledHarness).toHaveBeenCalledTimes(2);
    expect(log.mock.calls).toEqual([
      ["Agent runtime package 'openclaw' is installed."],
      ["Agent runtime package 'openclaw' is installed."],
    ]);
  });

  it("lets the package registry validate a discovered harness id", async () => {
    mocks.installBundledHarness.mockImplementationOnce(() => {
      throw new Error("Bundled harness 'unknown' was not found");
    });

    await expect(HarnessInstallCommand.run(["unknown"], rootDir)).rejects.toThrow(
      "Bundled harness 'unknown' was not found",
    );

    expect(mocks.installBundledHarness).toHaveBeenCalledWith("unknown");
  });

  it("requires a harness id before installation", async () => {
    await expect(HarnessInstallCommand.run([], rootDir)).rejects.toThrow(/harness/i);

    expect(mocks.installBundledHarness).not.toHaveBeenCalled();
  });
});
