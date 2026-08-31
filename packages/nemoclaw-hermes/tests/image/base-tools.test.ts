// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");

function completedDockerStage(dockerfile: string): string {
  const start = dockerfile.lastIndexOf("\nFROM ");
  return start >= 0 ? dockerfile.slice(start) : dockerfile;
}

describe("sandbox provisioning: base runtime tools", () => {
  it("installs pinned nftables for OpenShell bypass enforcement in Hermes", () => {
    const dockerfile = completedDockerStage(
      fs.readFileSync(path.join(PACKAGE_ROOT, "Dockerfile.base"), "utf-8"),
    );
    const aptInstall = dockerfile.match(
      /^RUN apt-get update && apt-get install -y --no-install-recommends \\\n(?:.*\\\n)*.*$/m,
    )?.[0];
    expect(aptInstall).toBeDefined();
    expect(aptInstall).toContain("nftables=1.1.3-1");
  });
});
