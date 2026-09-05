// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createHarnessPackageFixture,
  type HarnessPackageFixture,
} from "../../../../test/helpers/harness-packages";
import { HarnessPackageRemovalBlockedError, removeHarnessPackage } from "./remove";

let fixture: HarnessPackageFixture;

beforeEach(() => {
  fixture = createHarnessPackageFixture();
});

afterEach(() => {
  fixture.cleanup();
});

describe("removeHarnessPackage", () => {
  it("reports an inactive package without creating or deleting store state", () => {
    const before = fs.readdirSync(fixture.storeRoot);

    expect(removeHarnessPackage("openclaw", { storeRoot: fixture.storeRoot })).toEqual({
      schemaVersion: 1,
      state: "already-inactive",
      id: "openclaw",
    });
    expect(fs.readdirSync(fixture.storeRoot)).toEqual(before);
  });

  it("refuses an active package and leaves its pointer and immutable history unchanged", () => {
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
    const pointerBytes = fs.readFileSync(pointerPath);
    const receiptBytes = fs.readFileSync(receiptPath);

    let failure: unknown;
    try {
      removeHarnessPackage("openclaw", { storeRoot: fixture.storeRoot });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(HarnessPackageRemovalBlockedError);
    expect((failure as HarnessPackageRemovalBlockedError).inspection).toEqual({
      status: "indeterminate",
      id: "openclaw",
      reason: "complete-owner-scan-unavailable",
      activeIdentity: installed.identity,
    });
    expect(fs.readFileSync(pointerPath)).toEqual(pointerBytes);
    expect(fs.readFileSync(receiptPath)).toEqual(receiptBytes);
    expect(fs.statSync(objectPath).isDirectory()).toBe(true);
    expect(JSON.stringify(failure)).not.toContain(fixture.fixtureRoot);
  });

  it("rejects a noncanonical id before consulting package state", () => {
    const readInstalledHarnessPackage = vi.fn();

    expect(() =>
      removeHarnessPackage(
        "OpenClaw",
        { storeRoot: fixture.storeRoot },
        { readInstalledHarnessPackage },
      ),
    ).toThrow("lowercase hyphen-separated identifier");
    expect(readInstalledHarnessPackage).not.toHaveBeenCalled();
    expect(fs.readdirSync(fixture.storeRoot)).toEqual([]);
  });

  it("propagates an indeterminate store read without attempting a mutation", () => {
    const readInstalledHarnessPackage = vi.fn(() => {
      throw new Error("store authority changed");
    });

    expect(() =>
      removeHarnessPackage(
        "openclaw",
        { storeRoot: fixture.storeRoot },
        { readInstalledHarnessPackage },
      ),
    ).toThrow("store authority changed");
    expect(readInstalledHarnessPackage).toHaveBeenCalledOnce();
    expect(fs.readdirSync(fixture.storeRoot)).toEqual([]);
  });
});
