// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testTimeoutOptions } from "../../../test/helpers/timeouts";

const mocks = vi.hoisted(() => ({
  installBundledHarness: vi.fn(),
  promptForRuntimePackage: vi.fn(),
  refreshInstalledBundledHarnesses: vi.fn(),
}));

vi.mock("../../lib/harness/package-registry", () => ({
  installBundledHarness: mocks.installBundledHarness,
  refreshInstalledBundledHarnesses: mocks.refreshInstalledBundledHarnesses,
}));

vi.mock("../../lib/harness/install-command", () => ({
  promptForRuntimePackage: mocks.promptForRuntimePackage,
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
    mocks.refreshInstalledBundledHarnesses.mockReturnValue([]);
    mocks.promptForRuntimePackage.mockResolvedValue("openclaw");
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
    expect(mocks.refreshInstalledBundledHarnesses).not.toHaveBeenCalled();
  });

  it("requires a harness id when input is not a terminal", async () => {
    await expect(HarnessInstallCommand.run([], rootDir)).rejects.toThrow(
      /required when input is not a terminal/i,
    );

    expect(mocks.installBundledHarness).not.toHaveBeenCalled();
    expect(mocks.promptForRuntimePackage).not.toHaveBeenCalled();
  });

  it("installs the package selected by the interactive picker", async () => {
    const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    try {
      await HarnessInstallCommand.run([], rootDir);
    } finally {
      stdinTty
        ? Object.defineProperty(process.stdin, "isTTY", stdinTty)
        : Reflect.deleteProperty(process.stdin, "isTTY");
    }

    expect(mocks.promptForRuntimePackage).toHaveBeenCalledWith(expect.any(Function));
    expect(mocks.installBundledHarness).toHaveBeenCalledWith("openclaw");
  });

  it("returns without installation when the user chooses to install later", async () => {
    const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    mocks.promptForRuntimePackage.mockResolvedValueOnce(null);
    try {
      await HarnessInstallCommand.run([], rootDir);
    } finally {
      stdinTty
        ? Object.defineProperty(process.stdin, "isTTY", stdinTty)
        : Reflect.deleteProperty(process.stdin, "isTTY");
    }

    expect(mocks.installBundledHarness).not.toHaveBeenCalled();
  });

  it("refreshes only packages that were already installed when no harness is selected", async () => {
    const openclaw = mocks.installBundledHarness("openclaw");
    mocks.installBundledHarness.mockClear();
    mocks.refreshInstalledBundledHarnesses.mockReturnValue([openclaw]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await HarnessInstallCommand.run(["--refresh-installed"], rootDir);

    expect(mocks.installBundledHarness).not.toHaveBeenCalled();
    expect(mocks.refreshInstalledBundledHarnesses).toHaveBeenCalledWith(process.env);
    expect(log.mock.calls).toEqual([["Agent runtime package 'openclaw' is installed."]]);
  });

  it("refreshes existing bundled packages and installs a missing selection once", async () => {
    const hermes = mocks.installBundledHarness("hermes");
    mocks.installBundledHarness.mockClear();
    mocks.refreshInstalledBundledHarnesses.mockReturnValue([hermes]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await HarnessInstallCommand.run(["openclaw", "--refresh-installed"], rootDir);

    expect(mocks.installBundledHarness).toHaveBeenCalledTimes(1);
    expect(mocks.installBundledHarness).toHaveBeenCalledWith("openclaw");
    expect(mocks.refreshInstalledBundledHarnesses).toHaveBeenCalledWith(process.env, "openclaw");
    expect(log.mock.calls).toEqual([
      ["Agent runtime package 'openclaw' is installed."],
      ["Agent runtime package 'hermes' is installed."],
    ]);
  });

  it("reports the selected install before another installed package blocks refresh", async () => {
    mocks.refreshInstalledBundledHarnesses.mockImplementationOnce(() => {
      throw new Error("Installed harness 'hermes' has local changes");
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      HarnessInstallCommand.run(["openclaw", "--refresh-installed"], rootDir),
    ).rejects.toThrow("Installed harness 'hermes' has local changes");

    expect(log.mock.calls).toEqual([["Agent runtime package 'openclaw' is installed."]]);
  });
});
