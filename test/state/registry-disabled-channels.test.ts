// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { makeMessagingPlan } from "../helpers/messaging-plan-fixtures";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-registry-channels-test-"));
process.env.HOME = tmpDir;

const require = createRequire(import.meta.url);
const registry = require("../../src/lib/state/registry");
const regFile = path.join(tmpDir, ".nemoclaw", "sandboxes.json");

beforeEach(() => {
  fs.existsSync(regFile) && fs.unlinkSync(regFile);
});

describe("registry disabled channels", () => {
  it("setChannelDisabled toggles a channel on and off for a sandbox", () => {
    registry.registerSandbox({
      name: "s1",
      messaging: {
        schemaVersion: 1,
        plan: makeMessagingPlan({ sandboxName: "s1", channels: ["telegram", "discord"] }),
      },
    });
    expect(registry.getDisabledChannels("s1")).toEqual([]);

    expect(registry.setChannelDisabled("s1", "telegram", true)).toBe(true);
    expect(registry.getDisabledChannels("s1")).toEqual(["telegram"]);

    expect(registry.setChannelDisabled("s1", "discord", true)).toBe(true);
    expect(registry.getDisabledChannels("s1")).toEqual(["discord", "telegram"]);

    registry.setChannelDisabled("s1", "telegram", false);
    expect(registry.getDisabledChannels("s1")).toEqual(["discord"]);
  });

  it("setChannelDisabled clears plan.disabledChannels when empty", () => {
    registry.registerSandbox({
      name: "s1",
      messaging: {
        schemaVersion: 1,
        plan: makeMessagingPlan({ sandboxName: "s1", channels: ["telegram"] }),
      },
    });
    registry.setChannelDisabled("s1", "telegram", true);
    registry.setChannelDisabled("s1", "telegram", false);
    const persisted = JSON.parse(fs.readFileSync(regFile, "utf-8"));
    expect(persisted.sandboxes.s1.messaging.plan.disabledChannels).toEqual([]);
    expect(persisted.sandboxes.s1.disabledChannels).toBeUndefined();
  });

  it("setChannelDisabled returns false when the channel is not configured in the plan", () => {
    registry.registerSandbox({
      name: "s1",
      messaging: {
        schemaVersion: 1,
        plan: makeMessagingPlan({ sandboxName: "s1", channels: ["telegram"] }),
      },
    });
    expect(registry.setChannelDisabled("s1", "discord", true)).toBe(false);
    expect(registry.getDisabledChannels("s1")).toEqual([]);
  });

  it("setChannelDisabled returns false when sandbox is missing", () => {
    expect(registry.setChannelDisabled("missing", "telegram", true)).toBe(false);
  });

  it("registerSandbox preserves disabledChannels when re-registering", () => {
    registry.registerSandbox({
      name: "s1",
      messaging: {
        schemaVersion: 1,
        plan: makeMessagingPlan({ sandboxName: "s1", channels: ["telegram"] }),
      },
    });
    registry.setChannelDisabled("s1", "telegram", true);
    registry.registerSandbox({
      name: "s1",
      messaging: registry.getSandbox("s1").messaging,
    });
    expect(registry.getDisabledChannels("s1")).toEqual(["telegram"]);
  });
});
