// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadHarnessAdapter } from "../../dist/lib/agent-runtime/adapter/loader.js";
import {
  HARNESS_CONFIG_ADAPTER_CONTRACT,
  HARNESS_CONFIG_RESTORE_CONTRACT,
} from "../../dist/lib/agent-runtime/adapter/config.js";
import { HARNESS_MCP_ADAPTER_CONTRACT } from "../../dist/lib/agent-runtime/adapter/mcp.js";
import { installHarnessPackage } from "../../dist/lib/agent-runtime/package/install.js";

const REPOSITORY_ROOT = path.join(import.meta.dirname, "..", "..");
const MCP_PACKAGE_IDS = ["openclaw", "hermes", "langchain-deepagents-code"] as const;
const CONFIG_PACKAGES = [
  {
    id: "openclaw",
    target: { directory: "/sandbox/.openclaw", file: "openclaw.json", format: "json" },
    serializedConfig: "{}\n",
    inferenceKind: "mutable",
    updateKind: "transaction",
    mutableKind: "stat",
  },
  {
    id: "hermes",
    target: { directory: "/sandbox/.hermes", file: "config.yaml", format: "yaml" },
    serializedConfig: "model: {}\n",
    inferenceKind: "mutable",
    updateKind: "transaction",
    mutableKind: "probe",
  },
  {
    id: "langchain-deepagents-code",
    target: { directory: "/sandbox/.deepagents", file: "config.toml", format: "toml" },
    serializedConfig: "",
    inferenceKind: "immutable",
    updateKind: "immutable",
    mutableKind: "not-required",
  },
  {
    id: "pi",
    target: { directory: "/sandbox/.pi/agent", file: "models.json", format: "json" },
    serializedConfig: "{}\n",
    inferenceKind: "immutable",
    updateKind: "immutable",
    mutableKind: "not-required",
  },
  {
    id: "deepseek-harness",
    target: { directory: "/sandbox/.deepseek-harness", file: "fabric.json", format: "json" },
    serializedConfig: "{}\n",
    inferenceKind: "immutable",
    updateKind: "immutable",
    mutableKind: "not-required",
  },
  {
    id: "haystack-agent",
    target: { directory: "/sandbox/.haystack-agent", file: "fabric.json", format: "json" },
    serializedConfig: "{}\n",
    inferenceKind: "immutable",
    updateKind: "immutable",
    mutableKind: "not-required",
  },
] as const;
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
        const registrationPlan = adapter.register({
          entry,
          managedEntries: [],
          replaceExisting: false,
          teardownRollback: false,
          configDirectory: `/sandbox/.${packageId}`,
        });
        const removalPlan = adapter.remove({
          entry,
          force: false,
          adaptiveTeardown: false,
          configDirectory: `/sandbox/.${packageId}`,
        });
        const inspectCommand = adapter.inspect({
          entry,
          failOnMismatch: false,
          configDirectory: `/sandbox/.${packageId}`,
        });
        const mutationCapability = adapter.mutationCapability({ sandboxName: "contract-test" });
        const teardownCapability = adapter.teardownCapability({ sandboxName: "contract-test" });
        const runtimeIntent = (
          adapter as typeof adapter & {
            verifyRuntimeIntent(request: {
              entries: (typeof entry)[];
              managedServerNames: string[];
            }): { kind: string };
          }
        ).verifyRuntimeIntent({ entries: [entry], managedServerNames: [entry.server] });
        const runtimeCommand = adapter.runtime({ command: ["node", "probe.mjs"] });

        expect(
          typeof registrationPlan.execution.command === "string" ||
            Array.isArray(registrationPlan.execution.command),
        ).toBe(true);
        expect(registrationPlan.execution.command).not.toHaveLength(0);
        expect(Object.isFrozen(registrationPlan)).toBe(true);
        expect(
          typeof removalPlan.execution.command === "string" ||
            Array.isArray(removalPlan.execution.command),
        ).toBe(true);
        expect(removalPlan.execution.command).not.toHaveLength(0);
        expect(Object.isFrozen(removalPlan)).toBe(true);
        expect(inspectCommand.length).toBeGreaterThan(0);
        expect(Object.isFrozen(mutationCapability)).toBe(true);
        expect(["command", "not-required"]).toContain(mutationCapability.kind);
        expect(Object.isFrozen(teardownCapability)).toBe(true);
        expect(["command", "not-required"]).toContain(teardownCapability.kind);
        expect(Object.isFrozen(runtimeIntent)).toBe(true);
        expect(["command", "not-required"]).toContain(runtimeIntent.kind);
        expect(runtimeCommand.length).toBeGreaterThan(0);
        expect(Object.keys(adapter).sort()).toEqual([
          "inspect",
          "mutationCapability",
          "register",
          "remove",
          "runtime",
          "teardownCapability",
          "verifyRuntimeIntent",
        ]);
      } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it.each(CONFIG_PACKAGES)(
    "loads $id configuration through the same compiled contract",
    ({ id, target, serializedConfig, inferenceKind, updateKind, mutableKind }) => {
      const fixtureRoot = fs.mkdtempSync(path.join(TEST_PARENT, "fixture-"));
      fs.chmodSync(fixtureRoot, 0o700);
      const storeRoot = path.join(fixtureRoot, "store");
      try {
        fs.mkdirSync(storeRoot, { mode: 0o700 });
        const packageRoot = path.join(REPOSITORY_ROOT, "dist", "harnesses", `nemoclaw-${id}`);
        const installed = installHarnessPackage(
          { packageRoot, sourceIdentity: SOURCE_IDENTITY },
          { storeRoot },
        );
        const adapter = loadHarnessAdapter(installed.identity, HARNESS_CONFIG_ADAPTER_CONTRACT, {
          storeRoot,
        });
        const configTarget = { ...target, sensitiveFiles: [] };
        const inference = adapter.describeInference({ target: configTarget });
        const update = adapter.prepareUpdate({
          config: {},
          serializedConfig,
          expectedConfigSha256: "a".repeat(64),
          target: configTarget,
        });
        const urlPolicy = adapter.classifyUrl({
          config: {},
          key: "model.endpoint",
          relativePath: [],
        });
        const mutable = adapter.describeMutable({
          target: configTarget,
          sandboxUid: null,
          sandboxGid: null,
        });

        expect(inference.kind).toBe(inferenceKind);
        expect(update.kind).toBe(updateKind);
        expect(urlPolicy).toMatchObject({
          allowPrivateUrls: expect.any(Boolean),
          allowOpenShellBridge: expect.any(Boolean),
        });
        expect(mutable.kind).toBe(mutableKind);
        expect(Object.isFrozen(update)).toBe(true);
        expect(Object.isFrozen(inference)).toBe(true);
        expect(Object.isFrozen(mutable)).toBe(true);
      } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it("loads OpenClaw restore grammar through the compiled restore contract", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(TEST_PARENT, "fixture-"));
    fs.chmodSync(fixtureRoot, 0o700);
    const storeRoot = path.join(fixtureRoot, "store");
    try {
      fs.mkdirSync(storeRoot, { mode: 0o700 });
      const packageRoot = path.join(REPOSITORY_ROOT, "dist/harnesses/nemoclaw-openclaw");
      const installed = installHarnessPackage(
        { packageRoot, sourceIdentity: SOURCE_IDENTITY },
        { storeRoot },
      );
      const adapter = loadHarnessAdapter(installed.identity, HARNESS_CONFIG_RESTORE_CONTRACT, {
        storeRoot,
      });
      const result = adapter.mergeState({
        backupContent: "{}",
        currentContent: "{}",
        managedChannelNames: [],
        previousImagePluginInstalls: null,
        freshImagePluginInstalls: null,
      });

      expect(result).toMatchObject({ kind: "merged" });
      expect(Object.isFrozen(result)).toBe(true);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it("publishes the adapter declarations", () => {
    expect(
      fs.existsSync(path.join(REPOSITORY_ROOT, "dist/lib/agent-runtime/adapter/loader.d.ts")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(REPOSITORY_ROOT, "dist/lib/agent-runtime/adapter/mcp.d.ts")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(REPOSITORY_ROOT, "dist/lib/agent-runtime/adapter/config.d.ts")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(REPOSITORY_ROOT, "dist/lib/agent-runtime/adapter/contract.d.ts")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(REPOSITORY_ROOT, "dist/lib/agent-runtime/adapter/schema.d.ts")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(REPOSITORY_ROOT, "dist/lib/agent-runtime/config-module.d.ts")),
    ).toBe(true);
  });
});
