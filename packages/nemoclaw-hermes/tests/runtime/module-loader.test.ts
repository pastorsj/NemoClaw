// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { runHermesStartupLoader } from "../helpers/shell-harness";

describe("Hermes startup module loader", () => {
  it("loads every package module without mutating its readonly directory", () => {
    const result = runHermesStartupLoader();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("LOADED");
  });

  it.each(["missing", "symlink"] as const)("fails closed for a %s module", (mode) => {
    const result = runHermesStartupLoader(mode);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Required Hermes service-control module is missing or unsafe");
  });
});
