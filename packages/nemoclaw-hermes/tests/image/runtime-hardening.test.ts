// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(import.meta.dirname, "..", "..");

describe("cross-package runtime hardening", () => {
  it("keeps the OpenClaw EC2 metadata override out of Hermes", () => {
    const hermesBaseSource = fs.readFileSync(path.join(packageRoot, "Dockerfile.base"), "utf-8");
    const hermesRuntimeSource = fs.readFileSync(path.join(packageRoot, "Dockerfile"), "utf-8");
    const hermesStartSource = fs.readFileSync(path.join(packageRoot, "start.sh"), "utf-8");

    expect(hermesBaseSource).not.toContain("AWS_EC2_METADATA_DISABLED");
    expect(hermesRuntimeSource).not.toContain("AWS_EC2_METADATA_DISABLED");
    expect(hermesStartSource).not.toContain("AWS_EC2_METADATA_DISABLED");
  });
});
