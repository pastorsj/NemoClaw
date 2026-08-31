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
