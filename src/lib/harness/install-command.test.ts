// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  listRuntimeInstallChoices,
  selectAgentRuntimePackage,
  type AgentRuntimeInstallChoice,
} from "./install-command";
import type { HarnessPackage } from "./package-registry";

function harnessPackage(id: string, source: "bundled" | "installed"): HarnessPackage {
  return {
    id,
    packageName: `@nvidia/nemoclaw-${id}`,
    version: "0.1.0",
    rootDir: `/tmp/${source}/${id}`,
    manifestPath: `/tmp/${source}/${id}/manifest.yaml`,
    source,
  };
}

function selectionDeps(options: {
  bundled?: HarnessPackage[];
  installed?: HarnessPackage[];
  answers?: string[];
}) {
  const answers = [...(options.answers ?? [])];
  return {
    listBundledPackages: vi.fn(() => options.bundled ?? []),
    listInstalledPackages: vi.fn(() => options.installed ?? []),
    log: vi.fn((_message?: string) => undefined),
    prompt: vi.fn(async (_question: string) => answers.shift() ?? ""),
  };
}

describe("agent runtime package install selection", () => {
  it("excludes packages that are already installed", () => {
    const bundled: AgentRuntimeInstallChoice[] = [
      harnessPackage("openclaw", "bundled"),
      harnessPackage("hermes", "bundled"),
    ];

    expect(
      listRuntimeInstallChoices(bundled, [harnessPackage("openclaw", "installed")]).map(
        ({ id }) => id,
      ),
    ).toEqual(["hermes"]);
  });

  it("returns the selected available package", async () => {
    const deps = selectionDeps({
      bundled: [harnessPackage("hermes", "bundled"), harnessPackage("openclaw", "bundled")],
      answers: ["2"],
    });

    await expect(selectAgentRuntimePackage(deps)).resolves.toBe("hermes");
    expect(deps.log.mock.calls.flat().join("\n")).toContain(
      "Select an agent runtime package to install",
    );
  });

  it("uses the first package when the user accepts the displayed default", async () => {
    const deps = selectionDeps({
      bundled: [harnessPackage("openclaw", "bundled")],
      answers: [""],
    });

    await expect(selectAgentRuntimePackage(deps)).resolves.toBe("openclaw");
  });

  it("asks again after an invalid selection", async () => {
    const deps = selectionDeps({
      bundled: [harnessPackage("openclaw", "bundled")],
      answers: ["5", "1abc", "1"],
    });

    await expect(selectAgentRuntimePackage(deps)).resolves.toBe("openclaw");
    expect(deps.prompt).toHaveBeenCalledTimes(3);
    expect(deps.log).toHaveBeenCalledWith("Choose a number from 1 to 1, or enter 'exit'.");
  });

  it("returns without installation when the user chooses to install later", async () => {
    const deps = selectionDeps({
      bundled: [harnessPackage("openclaw", "bundled")],
      answers: ["exit"],
    });

    await expect(selectAgentRuntimePackage(deps)).resolves.toBeNull();
    expect(deps.log).toHaveBeenCalledWith("No agent runtime package was installed.");
  });

  it("returns without prompting when all bundled packages are installed", async () => {
    const openclaw = harnessPackage("openclaw", "bundled");
    const deps = selectionDeps({
      bundled: [openclaw],
      installed: [harnessPackage("openclaw", "installed")],
    });

    await expect(selectAgentRuntimePackage(deps)).resolves.toBeNull();
    expect(deps.prompt).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith("All bundled agent runtime packages are installed.");
  });
});
