// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");

describe("inference provider route identifier rename (#7177)", () => {
  it("declares the non-secret route identifier and no secret-shaped name in packages/nemoclaw-hermes/Dockerfile", () => {
    const source = fs.readFileSync(path.join(PACKAGE_ROOT, "Dockerfile"), "utf-8");
    expect(source).toMatch(/^ARG NEMOCLAW_INFERENCE_PROVIDER_ID=/m);
    expect(source).toMatch(
      /^\s*NEMOCLAW_INFERENCE_PROVIDER_ID=\$\{NEMOCLAW_INFERENCE_PROVIDER_ID\}/m,
    );
    expect(source).not.toContain("NEMOCLAW_PROVIDER_KEY");
  });
});
