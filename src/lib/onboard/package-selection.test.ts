// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createHarnessPackageFixture,
  type HarnessPackageFixture,
} from "../../../test/helpers/harness-packages";
import { listHarnessPackageInventory } from "../agent-runtime/package/catalog";
import {
  OnboardHarnessInstallRequiredError,
  OnboardHarnessIntegrityError,
  OnboardHarnessSelectionRequiredError,
  selectOnboardHarnessPackage,
  type SelectOnboardHarnessPackageInput,
} from "./package-selection";

let fixture: HarnessPackageFixture;

function selectionInput(
  overrides: Partial<SelectOnboardHarnessPackageInput> = {},
): SelectOnboardHarnessPackageInput {
  return {
    bundledRoot: fixture.bundledRoot,
    storeRoot: fixture.storeRoot,
    agentFlag: null,
    canPrompt: false,
    environment: {},
    log: vi.fn(),
    prompt: vi.fn(async () => "1"),
    ...overrides,
  };
}

beforeEach(() => {
  fixture = createHarnessPackageFixture();
});

afterEach(() => {
  fixture.cleanup();
});

describe("selectOnboardHarnessPackage", () => {
  it("returns actionable install guidance when no healthy harness is installed", async () => {
    const prompt = vi.fn(async () => "1");

    const result = await selectOnboardHarnessPackage(selectionInput({ prompt }));

    expect(result).toEqual({
      kind: "install-required",
      reason: "no-installed-harnesses",
      command: "nemoclaw harness install",
      message:
        "No harnesses are installed. Run 'nemoclaw harness install' to choose one, then retry onboarding.",
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(fs.readdirSync(fixture.storeRoot)).toEqual([]);
  });

  it("automatically selects one installed package with its exact definition authority", async () => {
    const installed = fixture.install("hermes");
    const prompt = vi.fn(async () => "1");

    const result = await selectOnboardHarnessPackage(selectionInput({ canPrompt: true, prompt }));

    assert.equal(result.kind, "package");
    expect(result.recordedAgent).toBe("hermes");
    expect(result.harnessPackage).toEqual(installed.identity);
    expect(result.resolvedPackage.identity).toEqual(installed.identity);
    expect(result.effectiveDefinition.name).toBe("hermes");
    expect(result.effectiveDefinition.packageRoot).toBe(installed.packageRoot);
    expect(result.effectiveDefinition.expectedVersion).toBeNull();
    expect(prompt).not.toHaveBeenCalled();
    expect(fs.existsSync(fixture.executionSentinel)).toBe(false);
  });

  it("uses the established numbered picker for multiple installed packages", async () => {
    fixture.installMany(["openclaw", "hermes"]);
    const log = vi.fn();
    const prompt = vi.fn(async () => "2");

    const result = await selectOnboardHarnessPackage(
      selectionInput({ canPrompt: true, log, prompt }),
    );

    assert.equal(result.kind, "package");
    expect(result.harnessPackage.id).toBe("hermes");
    const menu = log.mock.calls.map(([message]) => message).join("\n");
    expect(menu).toContain("1) OpenClaw");
    expect(menu).toContain("2) Hermes Agent");
    expect(menu).not.toContain("LangChain Deep Agents Code");
    expect(menu).not.toContain("Pi");
    expect(menu).not.toContain("NemoCUA");
  });

  it("uses the installed manifest default for non-interactive selection", async () => {
    fixture.installMany(["openclaw", "hermes"]);

    const result = await selectOnboardHarnessPackage(selectionInput());

    assert.equal(result.kind, "package");
    expect(result.recordedAgent).toBe("openclaw");
    expect(result.harnessPackage.id).toBe("openclaw");
  });

  it("requires --agent for multiple non-interactive packages without OpenClaw", async () => {
    fixture.installMany(["hermes", "langchain-deepagents-code"]);

    await expect(selectOnboardHarnessPackage(selectionInput())).rejects.toThrowError(
      OnboardHarnessSelectionRequiredError,
    );
    await expect(selectOnboardHarnessPackage(selectionInput())).rejects.toThrow("--agent <id>");
  });

  it("gives canonical install guidance for an explicitly requested uninstalled alias", async () => {
    fixture.install("openclaw");

    await expect(
      selectOnboardHarnessPackage(selectionInput({ agentFlag: "nemohermes" })),
    ).rejects.toThrowError(OnboardHarnessInstallRequiredError);
    await expect(
      selectOnboardHarnessPackage(selectionInput({ agentFlag: "nemohermes" })),
    ).rejects.toThrow("nemoclaw harness install hermes");
  });

  it.each([
    ["nemohermes", "hermes"],
    ["dcode", "langchain-deepagents-code"],
  ] as const)("preserves the public alias %s", async (selector, expectedId) => {
    fixture.install(expectedId);

    const result = await selectOnboardHarnessPackage(
      selectionInput({ environment: { NEMOCLAW_AGENT: selector } }),
    );

    assert.equal(result.kind, "package");
    expect(result.harnessPackage.id).toBe(expectedId);
  });

  it("re-reads the selected digest when the active pointer advances", async () => {
    const originallyInstalled = fixture.install("openclaw");
    let advancedDigest = "";

    const result = await selectOnboardHarnessPackage(selectionInput(), {
      listHarnessPackageInventory: (options) => {
        const inventory = listHarnessPackageInventory(options);
        advancedDigest = fixture.advanceActivePointer("openclaw").identity.contentDigest;
        return inventory;
      },
    });

    assert.equal(result.kind, "package");
    expect(result.harnessPackage).toEqual(originallyInstalled.identity);
    expect(result.harnessPackage.contentDigest).not.toBe(advancedDigest);
    expect(result.effectiveDefinition.packageRoot).toBe(originallyInstalled.packageRoot);
  });

  it("fails closed when the only installed package is damaged", async () => {
    fixture.install("openclaw");
    fixture.damageActivePointer("openclaw");

    await expect(selectOnboardHarnessPackage(selectionInput())).rejects.toThrowError(
      OnboardHarnessIntegrityError,
    );
  });

  it("does not silently select healthy Hermes when installed OpenClaw is damaged", async () => {
    fixture.installMany(["openclaw", "hermes"]);
    fixture.damageActivePointer("openclaw");
    const prompt = vi.fn(async () => "1");

    await expect(
      selectOnboardHarnessPackage(selectionInput({ canPrompt: true, prompt })),
    ).rejects.toMatchObject({
      name: "OnboardHarnessIntegrityError",
      harnessIds: ["openclaw"],
    });
    expect(prompt).not.toHaveBeenCalled();
  });
});
