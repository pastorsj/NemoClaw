// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createHarnessPackageFixture,
  type HarnessPackageFixture,
} from "../../../test/helpers/harness-packages";
import { removeHarnessPackage } from "../../lib/actions/harness/remove";
import { readInstalledHarnessPackage } from "../../lib/agent-runtime/package/store";
import { PUBLIC_DISPLAY_ENTRIES } from "../../lib/cli/public-display-defaults";
import HarnessRemoveCommand, { harnessRemoveCommandDependencies } from "./remove";

let fixture: HarnessPackageFixture;

function wireFixtureStore(): void {
  vi.spyOn(harnessRemoveCommandDependencies, "readInstalledHarnessPackage").mockImplementation(
    (id) => readInstalledHarnessPackage(id, { storeRoot: fixture.storeRoot }),
  );
  vi.spyOn(harnessRemoveCommandDependencies, "removeHarnessPackage").mockImplementation(
    (id, options) =>
      removeHarnessPackage(id, {
        storeRoot: fixture.storeRoot,
        ...options,
      }),
  );
  vi.spyOn(harnessRemoveCommandDependencies, "isStdinTty").mockReturnValue(false);
  vi.spyOn(harnessRemoveCommandDependencies, "prompt").mockResolvedValue("");
}

beforeEach(() => {
  fixture = createHarnessPackageFixture();
  wireFixtureStore();
});

afterEach(() => {
  vi.restoreAllMocks();
  fixture.cleanup();
});

describe("harness remove oclif command", () => {
  it("publishes one explicit-confirmation public command row", () => {
    expect(PUBLIC_DISPLAY_ENTRIES["harness:remove"]).toEqual([
      {
        usage: "nemoclaw harness remove",
        description: "Deactivate a harness package for new sandboxes",
        flags: "<id> [--yes|-y] [--json]",
        group: "Getting Started",
        deprecated: undefined,
        hidden: undefined,
        scope: "global",
        order: 1.64,
      },
    ]);
  });

  it("returns a typed no-op for an already inactive package without confirmation", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await HarnessRemoveCommand.run(["openclaw", "--json"], process.cwd());
    const output = JSON.parse(String(log.mock.calls.at(-1)?.[0]));

    expect(result).toEqual({ schemaVersion: 1, state: "already-inactive", id: "openclaw" });
    expect(output).toEqual(result);
    expect(harnessRemoveCommandDependencies.prompt).not.toHaveBeenCalled();
    expect(fs.readdirSync(fixture.storeRoot)).toEqual([]);
  });

  it("requires --yes for a noninteractive active package without changing it", async () => {
    const installed = fixture.install("openclaw");
    const pointerPath = path.join(fixture.storeRoot, "active", "openclaw.json");
    const pointerBytes = fs.readFileSync(pointerPath);

    await expect(HarnessRemoveCommand.run(["openclaw"], process.cwd())).rejects.toThrow(
      "requires explicit confirmation",
    );

    expect(harnessRemoveCommandDependencies.removeHarnessPackage).not.toHaveBeenCalled();
    expect(fs.readFileSync(pointerPath)).toEqual(pointerBytes);
    expect(
      readInstalledHarnessPackage("openclaw", { storeRoot: fixture.storeRoot })?.identity,
    ).toEqual(installed.identity);
  });

  it("deactivates an active package after --yes and retains immutable history", async () => {
    const installed = fixture.install("openclaw");
    const pointerPath = path.join(fixture.storeRoot, "active", "openclaw.json");
    const receiptPath = path.join(
      fixture.storeRoot,
      "receipts",
      "openclaw",
      "sha256",
      `${installed.identity.contentDigest}.json`,
    );
    const objectPath = path.join(
      fixture.storeRoot,
      "objects",
      "sha256",
      installed.identity.contentDigest,
    );
    const receiptBytes = fs.readFileSync(receiptPath);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await HarnessRemoveCommand.run(["openclaw", "--yes"], process.cwd());

    expect(log).toHaveBeenCalledWith(
      "Deactivated harness package 'openclaw'. Immutable package history was retained.",
    );
    expect(harnessRemoveCommandDependencies.removeHarnessPackage).toHaveBeenCalledOnce();
    expect(fs.existsSync(pointerPath)).toBe(false);
    expect(fs.readFileSync(receiptPath)).toEqual(receiptBytes);
    expect(fs.statSync(objectPath).isDirectory()).toBe(true);
    expect(readInstalledHarnessPackage("openclaw", { storeRoot: fixture.storeRoot })).toBeNull();
  });

  it("cancels an interactive removal before deactivation", async () => {
    const installed = fixture.install("openclaw");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.mocked(harnessRemoveCommandDependencies.isStdinTty).mockReturnValue(true);
    vi.mocked(harnessRemoveCommandDependencies.prompt).mockResolvedValue("no");

    await HarnessRemoveCommand.run(["openclaw"], process.cwd());

    expect(log).toHaveBeenCalledWith("Removal cancelled.");
    expect(harnessRemoveCommandDependencies.removeHarnessPackage).not.toHaveBeenCalled();
    expect(
      readInstalledHarnessPackage("openclaw", { storeRoot: fixture.storeRoot })?.identity,
    ).toEqual(installed.identity);
  });

  it("fails closed on an unsafe active pointer without following or replacing it", async () => {
    fixture.install("openclaw");
    const pointerPath = path.join(fixture.storeRoot, "active", "openclaw.json");
    const external = path.join(fixture.fixtureRoot, "external-pointer.json");
    fs.writeFileSync(external, fs.readFileSync(pointerPath), { mode: 0o600 });
    fs.unlinkSync(pointerPath);
    fs.symlinkSync(external, pointerPath);

    await expect(HarnessRemoveCommand.run(["openclaw", "--yes"], process.cwd())).rejects.toThrow(
      "integrity validation failed",
    );

    expect(fs.lstatSync(pointerPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(external, "utf8")).toContain("openclaw");
    expect(harnessRemoveCommandDependencies.removeHarnessPackage).not.toHaveBeenCalled();
  });

  it("rejects a noncanonical id before invoking removal", async () => {
    await expect(HarnessRemoveCommand.run(["OpenClaw", "--yes"], process.cwd())).rejects.toThrow(
      "lowercase hyphen-separated identifier",
    );
    expect(harnessRemoveCommandDependencies.removeHarnessPackage).not.toHaveBeenCalled();
    expect(fs.readdirSync(fixture.storeRoot)).toEqual([]);
  });
});
