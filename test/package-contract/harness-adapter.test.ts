// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadHarnessAdapter } from "../../dist/lib/agent-runtime/adapter/loader.js";
import { HARNESS_MCP_ADAPTER_CONTRACT } from "../../dist/lib/agent-runtime/adapter/mcp.js";
import { installHarnessPackage } from "../../dist/lib/agent-runtime/package/install.js";

const REPOSITORY_ROOT = path.join(import.meta.dirname, "..", "..");
const MCP_PACKAGE_IDS = ["openclaw", "hermes", "langchain-deepagents-code"] as const;
const TEST_PARENT = path.join(
  REPOSITORY_ROOT,
  "node_modules/.cache/nemoclaw-package-contract-adapter",
);
const SOURCE_IDENTITY = Object.freeze({
  kind: "bundled" as const,
  nemoclawBuildIdentity: Object.freeze({
    nemoclawVersion: "0.0.113",
    sourceRevision: "e".repeat(40),
  }),
});

fs.mkdirSync(TEST_PARENT, { recursive: true, mode: 0o700 });
fs.chmodSync(TEST_PARENT, 0o700);

describe("compiled harness adapter boundary", () => {
  it.each(MCP_PACKAGE_IDS)(
    "loads the %s MCP capability through its typed contract",
    (packageId) => {
      const fixtureRoot = fs.mkdtempSync(path.join(TEST_PARENT, "fixture-"));
      fs.chmodSync(fixtureRoot, 0o700);
      const storeRoot = path.join(fixtureRoot, "store");
      try {
        fs.mkdirSync(storeRoot, { mode: 0o700 });
        const packageRoot = path.join(
          REPOSITORY_ROOT,
          "dist",
          "harnesses",
          `nemoclaw-${packageId}`,
        );
        const installed = installHarnessPackage(
          { packageRoot, sourceIdentity: SOURCE_IDENTITY },
          { storeRoot },
        );
        const adapter = loadHarnessAdapter(installed.identity, HARNESS_MCP_ADAPTER_CONTRACT, {
          storeRoot,
        });
        const entry = {
          server: "docs",
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer openshell-placeholder" },
        };
        const registerCommand = adapter.register({
          entry,
          managedEntries: [],
          replaceExisting: false,
          teardownRollback: false,
          configRoot: `/sandbox/.${packageId}`,
        });
        const removeCommand = adapter.remove({
          entry,
          force: false,
          adaptiveTeardown: false,
          configRoot: `/sandbox/.${packageId}`,
        });

        expect(typeof registerCommand === "string" || Array.isArray(registerCommand)).toBe(true);
        expect(registerCommand).not.toHaveLength(0);
        expect(Object.isFrozen(registerCommand)).toBe(true);
        expect(typeof removeCommand === "string" || Array.isArray(removeCommand)).toBe(true);
        expect(removeCommand).not.toHaveLength(0);
        expect(Object.isFrozen(removeCommand)).toBe(true);
        expect(Object.keys(adapter).sort()).toEqual(["register", "remove"]);
      } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it("publishes the adapter declarations", () => {
    expect(
      fs.existsSync(path.join(REPOSITORY_ROOT, "dist/lib/agent-runtime/adapter/loader.d.ts")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(REPOSITORY_ROOT, "dist/lib/agent-runtime/adapter/mcp.d.ts")),
    ).toBe(true);
  });
});
