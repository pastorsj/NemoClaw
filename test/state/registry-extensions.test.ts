// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-registry-extension-test-"));
process.env.HOME = tmpDir;

const require = createRequire(import.meta.url);
const registry = require("../../src/lib/state/registry");
const regFile = path.join(tmpDir, ".nemoclaw", "sandboxes.json");

beforeEach(() => {
  fs.existsSync(regFile) && fs.unlinkSync(regFile);
});

describe("registry extensions", () => {
  it("addCustomPolicy persists name, content, and sourcePath", () => {
    registry.registerSandbox({ name: "cp1" });
    const added = registry.addCustomPolicy("cp1", {
      name: "my-api",
      content: "preset:\n  name: my-api\nnetwork_policies: {}\n",
      sourcePath: "/tmp/my-api.yaml",
    });
    expect(added).toBe(true);
    const list = registry.getCustomPolicies("cp1");
    expect(list.length).toBe(1);
    expect(list[0].name).toBe("my-api");
    expect(list[0].content).toMatch(/name: my-api/);
    expect(list[0].sourcePath).toBe("/tmp/my-api.yaml");
    expect(typeof list[0].appliedAt).toBe("string");
  });

  it("addCustomPolicy replaces an existing entry with the same name", () => {
    registry.registerSandbox({ name: "cp2" });
    registry.addCustomPolicy("cp2", { name: "dup", content: "v1" });
    registry.addCustomPolicy("cp2", { name: "dup", content: "v2" });
    const list = registry.getCustomPolicies("cp2");
    expect(list.length).toBe(1);
    expect(list[0].content).toBe("v2");
  });

  it("removeCustomPolicyByName removes an entry and returns true", () => {
    registry.registerSandbox({ name: "cp3" });
    registry.addCustomPolicy("cp3", { name: "a", content: "x" });
    registry.addCustomPolicy("cp3", { name: "b", content: "y" });
    expect(registry.removeCustomPolicyByName("cp3", "a")).toBe(true);
    const list = registry.getCustomPolicies("cp3");
    expect(list.length).toBe(1);
    expect(list[0].name).toBe("b");
  });

  it("removeCustomPolicyByName returns false when the entry is missing", () => {
    registry.registerSandbox({ name: "cp4" });
    expect(registry.removeCustomPolicyByName("cp4", "nope")).toBe(false);
  });

  it("getCustomPolicies returns [] for unknown or fresh sandboxes", () => {
    expect(registry.getCustomPolicies("nonexistent")).toEqual([]);
    registry.registerSandbox({ name: "cp5" });
    expect(registry.getCustomPolicies("cp5")).toEqual([]);
  });

  describe("extra providers", () => {
    it("starts with an empty extra-provider list", () => {
      expect(registry.listExtraProviders()).toEqual([]);
    });

    it("addExtraProvider persists a sorted, deduplicated list", () => {
      expect(registry.addExtraProvider("tavily-search")).toBe(true);
      expect(registry.addExtraProvider("custom-provider")).toBe(true);
      expect(registry.addExtraProvider("tavily-search")).toBe(false);
      expect(registry.listExtraProviders()).toEqual(["custom-provider", "tavily-search"]);
    });

    it("removeExtraProvider clears the entry and drops the field when empty", () => {
      registry.addExtraProvider("tavily-search");
      expect(registry.removeExtraProvider("tavily-search")).toBe(true);
      expect(registry.listExtraProviders()).toEqual([]);
      const raw = JSON.parse(fs.readFileSync(regFile, "utf-8"));
      expect("extraProviders" in raw).toBe(false);
      expect(registry.removeExtraProvider("tavily-search")).toBe(false);
    });

    it("survives a registry round-trip through disk", () => {
      registry.addExtraProvider("tavily-search");
      expect(registry.listExtraProviders()).toEqual(["tavily-search"]);
    });
  });
});
