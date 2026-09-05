// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createHarnessPackageFixture,
  type HarnessPackageFixture,
} from "../../../../test/helpers/harness-packages";
import { removeHarnessPackage } from "./remove";

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

  it("deactivates an active package and retains its immutable history", () => {
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

    expect(removeHarnessPackage("openclaw", { storeRoot: fixture.storeRoot })).toEqual({
      schemaVersion: 1,
      state: "deactivated",
      identity: installed.identity,
    });
    expect(fs.existsSync(pointerPath)).toBe(false);
    expect(fs.readFileSync(receiptPath)).toEqual(receiptBytes);
    expect(fs.statSync(objectPath).isDirectory()).toBe(true);
  });

  it("rejects a noncanonical id before consulting package state", () => {
    const deactivateHarnessPackage = vi.fn();

    expect(() =>
      removeHarnessPackage(
        "OpenClaw",
        { storeRoot: fixture.storeRoot },
        { deactivateHarnessPackage },
      ),
    ).toThrow("lowercase hyphen-separated identifier");
    expect(deactivateHarnessPackage).not.toHaveBeenCalled();
    expect(fs.readdirSync(fixture.storeRoot)).toEqual([]);
  });

  it("propagates an indeterminate store read without attempting a mutation", () => {
    const deactivateHarnessPackage = vi.fn(() => {
      throw new Error("store authority changed");
    });

    expect(() =>
      removeHarnessPackage(
        "openclaw",
        { storeRoot: fixture.storeRoot },
        { deactivateHarnessPackage },
      ),
    ).toThrow("store authority changed");
    expect(deactivateHarnessPackage).toHaveBeenCalledOnce();
    expect(fs.readdirSync(fixture.storeRoot)).toEqual([]);
  });
});
