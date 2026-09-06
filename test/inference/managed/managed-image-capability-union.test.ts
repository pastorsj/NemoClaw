// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { applyMessagingBuildPhase } from "../../../src/lib/messaging/applier/build/messaging-build-applier.mts";

describe("managed-image capability union", () => {
  it("emits no runtime activation artifact for a neutral capability union (#7744)", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-neutral-union-"));
    const runtimePlanPath = path.join(temporaryRoot, "messaging-runtime-plan.json");

    try {
      expect(
        applyMessagingBuildPhase(null, "runtime-setup", {
          NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "1",
          NEMOCLAW_MESSAGING_RUNTIME_PLAN_PATH: runtimePlanPath,
        }),
      ).toEqual([]);
      expect(fs.existsSync(runtimePlanPath)).toBe(false);
    } finally {
      fs.rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });
});
