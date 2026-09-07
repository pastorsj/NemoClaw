// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createHarnessPackageFixture,
  type HarnessPackageFixture,
} from "../../../test/helpers/harness-packages";
import { activateHarnessPackage } from "../../lib/agent-runtime/package/activation";
import { readInstalledHarnessPackage } from "../../lib/agent-runtime/package/store";
import { PUBLIC_DISPLAY_ENTRIES } from "../../lib/cli/public-display-defaults";
import HarnessActivateCommand, { harnessActivateCommandDependencies } from "./activate";

let fixture: HarnessPackageFixture;

function wireFixtureStore(): void {
  vi.spyOn(harnessActivateCommandDependencies, "activateHarnessPackage").mockImplementation(
    (id, digest) => activateHarnessPackage(id, digest, { storeRoot: fixture.storeRoot }),
  );
}

beforeEach(() => {
  fixture = createHarnessPackageFixture();
  wireFixtureStore();
});

afterEach(() => {
  vi.restoreAllMocks();
  fixture.cleanup();
});

describe("harness activate oclif command", () => {
  it("publishes one path-free public command row", () => {
    expect(PUBLIC_DISPLAY_ENTRIES["harness:activate"]).toEqual([
      {
        usage: "nemoclaw harness activate",
        description: "Activate an installed harness package revision",
        flags: "<id> --digest <sha256> [--json]",
        group: "Getting Started",
        deprecated: undefined,
        hidden: undefined,
        scope: "global",
        order: 1.62,
      },
    ]);
  });

  it("rolls the active pointer back to an exact existing digest", async () => {
    const first = fixture.install("openclaw");
    fixture.advanceActivePointer("openclaw");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await HarnessActivateCommand.run(
      ["openclaw", "--digest", first.identity.contentDigest],
      process.cwd(),
    );

    expect(
      readInstalledHarnessPackage("openclaw", { storeRoot: fixture.storeRoot })?.identity,
    ).toEqual(first.identity);
    expect(log).toHaveBeenCalledWith(
      `Activated harness package 'openclaw' (${first.identity.packageVersion}, sha256:${first.identity.contentDigest}).`,
    );
  });

  it("accepts the displayed sha256 prefix and returns a path-free typed result", async () => {
    const first = fixture.install("openclaw");
    fixture.advanceActivePointer("openclaw");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await HarnessActivateCommand.run(
      ["openclaw", "--digest", `sha256:${first.identity.contentDigest}`, "--json"],
      process.cwd(),
    );
    const output = JSON.parse(String(log.mock.calls.at(-1)?.[0]));

    expect(result).toEqual({
      schemaVersion: 1,
      state: "active",
      identity: first.identity,
    });
    expect(output).toEqual(result);
    expect(JSON.stringify(output)).not.toContain(fixture.fixtureRoot);
    expect(JSON.stringify(output)).not.toContain("sourceIdentity");
  });

  it.each([
    "A".repeat(64),
    `SHA256:${"a".repeat(64)}`,
    `sha256:${"A".repeat(64)}`,
    `sha512:${"a".repeat(64)}`,
    `${"a".repeat(64)} `,
  ])("rejects noncanonical digest %j without changing the active pointer", async (digest) => {
    fixture.install("openclaw");
    const active = fixture.advanceActivePointer("openclaw");

    await expect(
      HarnessActivateCommand.run(["openclaw", "--digest", digest], process.cwd()),
    ).rejects.toThrow("lowercase SHA-256 digest");
    expect(harnessActivateCommandDependencies.activateHarnessPackage).not.toHaveBeenCalled();
    expect(
      readInstalledHarnessPackage("openclaw", { storeRoot: fixture.storeRoot })?.identity,
    ).toEqual(active.identity);
  });

  it("rejects a missing receipt without changing the active pointer", async () => {
    const active = fixture.install("openclaw");

    await expect(
      HarnessActivateCommand.run(["openclaw", "--digest", "f".repeat(64)], process.cwd()),
    ).rejects.toThrow("integrity validation failed");
    expect(
      readInstalledHarnessPackage("openclaw", { storeRoot: fixture.storeRoot })?.identity,
    ).toEqual(active.identity);
  });

  it("rejects missing arguments and a noncanonical id before package mutation", async () => {
    const active = fixture.install("openclaw");

    await expect(HarnessActivateCommand.run(["openclaw"], process.cwd())).rejects.toThrow();
    await expect(
      HarnessActivateCommand.run(
        ["OpenClaw", "--digest", active.identity.contentDigest],
        process.cwd(),
      ),
    ).rejects.toThrow("lowercase hyphen-separated identifier");
    expect(
      readInstalledHarnessPackage("openclaw", { storeRoot: fixture.storeRoot })?.identity,
    ).toEqual(active.identity);
  });
});
