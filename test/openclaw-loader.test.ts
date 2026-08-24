// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { openClawStartupFiles, runOpenClawModuleLoaderFixture } from "./support/openclaw-startup";

describe("OpenClaw startup module loader", () => {
  it("loads the complete package-owned startup workflow", () => {
    const result = runOpenClawModuleLoaderFixture();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("LOADED");
  });

  it.each(openClawStartupFiles)("fails closed when %s is missing", (fileName) => {
    const result = runOpenClawModuleLoaderFixture(fileName, "missing");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `Required OpenClaw startup file is missing or unsafe: ${fileName}`,
    );
  });

  it("rejects a symbolic-link startup module", () => {
    const result = runOpenClawModuleLoaderFixture("model-routing.sh", "symlink");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("model-routing.sh");
  });

  it.skipIf((process.getuid?.() ?? -1) === 0)("rejects an unreadable startup module", () => {
    const result = runOpenClawModuleLoaderFixture("model-routing.sh", "unreadable");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("model-routing.sh");
  });
});
