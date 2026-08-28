// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type {
  AvailableHarnessPackageRecord,
  HarnessPackageInventory,
  InstalledHarnessPackageRecord,
} from "./package-catalog";
import { promptForHarnessPackage } from "./package-prompt";

const DIGEST = "a".repeat(64);

function available(id: string, displayName: string): AvailableHarnessPackageRecord {
  return {
    state: "available",
    id,
    displayName,
    description: `${displayName} adapter`,
    identity: {
      kind: "agent-runtime",
      id,
      packageVersion: "0.1.0",
      contractVersion: 1,
      contentDigest: DIGEST,
    },
    packageRoot: `/private/bundled/nemoclaw-${id}`,
  };
}

function installed(id: string, displayName: string): InstalledHarnessPackageRecord {
  return {
    state: "damaged",
    id,
    displayName,
    description: `${displayName} adapter`,
    reason: "installed-package-integrity-failed",
  };
}

function inventory(
  availableRecords: readonly AvailableHarnessPackageRecord[],
  installedRecords: readonly InstalledHarnessPackageRecord[] = [],
): HarnessPackageInventory {
  return { available: availableRecords, installed: installedRecords };
}

describe("promptForHarnessPackage", () => {
  it("offers only uninstalled reviewed packages with OpenClaw first", async () => {
    const log = vi.fn();
    const prompt = vi.fn().mockResolvedValue("1");

    const result = await promptForHarnessPackage({
      inventory: inventory(
        [
          available("hermes", "Hermes Agent"),
          available("langchain-deepagents-code", "LangChain Deep Agents Code"),
          available("openclaw", "OpenClaw"),
        ],
        [installed("langchain-deepagents-code", "LangChain Deep Agents Code")],
      ),
      log,
      prompt,
    });

    expect(result).toEqual({ kind: "selected", id: "openclaw" });
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      "Choose a harness package to install:",
      "  1) OpenClaw (openclaw)",
      "  2) Hermes Agent (hermes)",
      "  0) Exit",
    ]);
  });

  it("uses OpenClaw as the displayed default", async () => {
    const result = await promptForHarnessPackage({
      inventory: inventory([
        available("hermes", "Hermes Agent"),
        available("openclaw", "OpenClaw"),
      ]),
      log: vi.fn(),
      prompt: vi.fn().mockResolvedValue(""),
    });

    expect(result).toEqual({ kind: "selected", id: "openclaw" });
  });

  it("re-prompts after an invalid menu choice", async () => {
    const log = vi.fn();
    const prompt = vi.fn().mockResolvedValueOnce("hermes").mockResolvedValueOnce("2");

    const result = await promptForHarnessPackage({
      inventory: inventory([
        available("openclaw", "OpenClaw"),
        available("hermes", "Hermes Agent"),
      ]),
      log,
      prompt,
    });

    expect(result).toEqual({ kind: "selected", id: "hermes" });
    expect(log).toHaveBeenLastCalledWith("Choose a number from 1 to 2, or enter 0 to exit.");
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it.each(["0", "exit", "quit"])("returns an explicit operator exit for %s", async (answer) => {
    const result = await promptForHarnessPackage({
      inventory: inventory([available("openclaw", "OpenClaw")]),
      log: vi.fn(),
      prompt: vi.fn().mockResolvedValue(answer),
    });

    expect(result).toEqual({ kind: "exit", reason: "operator" });
  });

  it("returns an explicit EOF exit when input closes", async () => {
    const eof = Object.assign(new Error("input closed"), { code: "EOF" });
    const result = await promptForHarnessPackage({
      inventory: inventory([available("openclaw", "OpenClaw")]),
      log: vi.fn(),
      prompt: vi.fn().mockRejectedValue(eof),
    });

    expect(result).toEqual({ kind: "exit", reason: "eof" });
  });

  it("reports all installed without opening a prompt", async () => {
    const prompt = vi.fn();
    const result = await promptForHarnessPackage({
      inventory: inventory(
        [available("openclaw", "OpenClaw"), available("hermes", "Hermes Agent")],
        [installed("openclaw", "OpenClaw"), installed("hermes", "Hermes Agent")],
      ),
      log: vi.fn(),
      prompt,
    });

    expect(result).toEqual({ kind: "exit", reason: "all-installed" });
    expect(prompt).not.toHaveBeenCalled();
  });
});
