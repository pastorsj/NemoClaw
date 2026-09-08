// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runWithEnv, writeSandboxRegistry } from "./helpers";

describe("sandbox skill install CLI dispatch", () => {
  it("shows sandbox-first skill install usage when --help follows install", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-skill-help-"));
    writeSandboxRegistry(home);

    const r = runWithEnv("alpha skill install --help", { HOME: home }, 30_000);

    expect(r.code).toBe(0);
    expect(r.out).toContain("$ nemoclaw alpha skill install <path>");
    expect(r.out).not.toContain("$ nemoclaw sandbox skill install");
    expect(r.out).toContain("Deploy a skill directory");
    expect(r.out).not.toContain("No SKILL.md found");
  });

  it("requires a skill install path before action dispatch", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-skill-missing-path-"));
    writeSandboxRegistry(home);

    const r = runWithEnv("alpha skill install 2>&1", { HOME: home });

    expect(r.code).not.toBe(0);
    expect(r.out).toContain("path");
  });

  it("points non-skill directories to the selected agent's extension workflow", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-extension-hint-"));
    const extensionDir = path.join(home, "agent-extension");
    fs.mkdirSync(extensionDir, { recursive: true });
    writeSandboxRegistry(home);

    const r = runWithEnv(`alpha skill install ${JSON.stringify(extensionDir)}`, { HOME: home });

    expect(r.code).toBe(1);
    expect(r.out).toContain("No SKILL.md found in");
    expect(r.out).toContain("`skill install` accepts only agent skills");
    expect(r.out).toContain("selected agent's native plugin or extension workflow");
  });

  it("gives the same neutral guidance for a missing path", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-missing-skill-"));
    const missingPath = path.join(home, "missing-extension");
    writeSandboxRegistry(home);

    const r = runWithEnv(`alpha skill install ${JSON.stringify(missingPath)}`, { HOME: home });

    expect(r.code).toBe(1);
    expect(r.out).toContain("No SKILL.md found at");
    expect(r.out).toContain("selected agent's native plugin or extension workflow");
  });
});
