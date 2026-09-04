// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const requireCache: Record<string, unknown> = require.cache as Record<string, unknown>;
const savedModules = new Map<string, unknown>();

const TARGET = Object.freeze({
  agentName: "future-harness",
  configDir: "/sandbox/.future",
  configPath: "/sandbox/.future/config.json",
  configFile: "config.json",
  format: "json",
  sensitiveFiles: ["/sandbox/.future/.config-hash"],
});
const IDENTITY = Object.freeze({
  kind: "agent-runtime" as const,
  id: "future-harness",
  packageVersion: "1.0.0",
  contentDigest: "a".repeat(64),
});

function replaceModule(modulePath: string, exports: Record<string, unknown>): void {
  const previous = savedModules.has(modulePath)
    ? savedModules.get(modulePath)
    : requireCache[modulePath];
  savedModules.set(modulePath, previous);
  requireCache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

afterEach(() => {
  for (const [modulePath, previous] of savedModules) {
    Reflect.deleteProperty(requireCache, modulePath);
    Object.assign(requireCache, previous === undefined ? {} : { [modulePath]: previous });
  }
  savedModules.clear();
  vi.restoreAllMocks();
});

interface PackageConfigScenario {
  readonly changeReceiptOnRecheck?: boolean;
  readonly changeWriteCommandOnRecheck?: boolean;
  readonly restartKind?: "managed" | "external";
}

async function runPackageConfigSet(scenario: PackageConfigScenario = {}) {
  const configPath = require.resolve("../../src/lib/sandbox/config");
  const configBoundaryPath = require.resolve("../../src/lib/sandbox/config-boundary");
  const agentConfigPath = require.resolve("../../src/lib/sandbox/agent-config");
  const packageConfigPath = require.resolve("../../src/lib/sandbox/package-config");
  const privilegedExecPath = require.resolve("../../src/lib/sandbox/privileged-exec");
  const openshellPath = require.resolve("../../src/lib/adapters/openshell/client");
  const lockPath = require.resolve("../../src/lib/state/mcp-lifecycle-lock");
  const auditPath = require.resolve("../../src/lib/state/audit/operational");
  savedModules.set(configPath, requireCache[configPath]);
  savedModules.set(configBoundaryPath, requireCache[configBoundaryPath]);
  Reflect.deleteProperty(requireCache, configPath);
  Reflect.deleteProperty(requireCache, configBoundaryPath);

  let persisted = '{"setting":"old"}\n';
  let planBuilds = 0;
  let receiptReads = 0;
  const commands: string[][] = [];
  const audit = vi.fn();
  const adapter = {
    classifyConfigUrl: vi.fn(() => ({
      allowPrivateUrls: false,
      allowOpenShellBridge: false,
    })),
    describeMutableConfig: vi.fn(() => ({ kind: "not-required", reason: "not needed" })),
    prepareConfigUpdate: vi.fn((request: { serializedConfig: string }) => {
      planBuilds += 1;
      return {
        kind: "transaction",
        content: request.serializedConfig,
        validation: {
          command: ["future-config", "validate"],
          timeoutSeconds: 10,
          failureMessage: "Future validation failed",
          success: { kind: "exit-zero" },
        },
        write: {
          command: [
            "future-config",
            scenario.changeWriteCommandOnRecheck && planBuilds > 1 ? "changed-write" : "write",
          ],
          timeoutSeconds: 10,
          failureMessage: "Future write failed",
          success: {
            kind: "config-transaction",
            action: "write-config",
            configDirectory: TARGET.configDir,
            protectedFiles: [TARGET.configFile],
          },
        },
        restart: {
          kind: scenario.restartKind ?? "managed",
          guidance: ["Follow the Future Harness restart procedure."],
        },
      };
    }),
  };
  const loadSelection = vi.fn(() => {
    receiptReads += 1;
    return {
      identity:
        scenario.changeReceiptOnRecheck && receiptReads > 1
          ? { ...IDENTITY, contentDigest: "b".repeat(64) }
          : IDENTITY,
      adapter,
    };
  });

  replaceModule(agentConfigPath, {
    DEFAULT_AGENT_CONFIG: TARGET,
    resolveAgentConfig: () => TARGET,
  });
  replaceModule(packageConfigPath, {
    loadInstalledConfigAdapter: loadSelection,
    toHarnessConfigTarget: () => ({
      directory: TARGET.configDir,
      file: TARGET.configFile,
      format: TARGET.format,
      sensitiveFiles: [],
    }),
  });
  replaceModule(privilegedExecPath, {
    capturePrivilegedSandboxCommand: () => Buffer.alloc(0),
    executePrivilegedSandboxCommand: (
      _sandboxName: string,
      command: readonly string[],
      options: { input?: string | Buffer },
    ) => {
      commands.push([...command]);
      persisted = command[1] === "write" ? String(options.input ?? "") : persisted;
      const digest = createHash("sha256")
        .update(String(options.input ?? ""))
        .digest("hex");
      return {
        status: 0,
        signal: null,
        stdout: Buffer.from(
          command[1] === "write"
            ? `${JSON.stringify({
                type: "result",
                action: "write-config",
                status: "ok",
                configDir: TARGET.configDir,
                files: [TARGET.configFile],
                configSha256: digest,
              })}\n`
            : "",
        ),
        stderr: Buffer.alloc(0),
      };
    },
    resolvePrivilegedSandboxTarget: () => ({ resourceHandle: "runtime-resource" }),
    withPrivilegedSandboxExecutionLease: <T>(_name: string, _operation: string, fn: () => T) =>
      fn(),
  });
  replaceModule(openshellPath, {
    captureOpenshellCommand: () => ({
      status: 0,
      signal: null,
      stdout: persisted,
      stderr: "",
      output: persisted.trim(),
    }),
    runOpenshellCommand: () => ({ status: 0 }),
    stripAnsi: (value: string) => value,
  });
  replaceModule(lockPath, {
    withSandboxMutationLock: async (_name: string, callback: () => unknown) => callback(),
  });
  replaceModule(auditPath, { appendAuditEntry: audit });

  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
  const { configSet } = require("../../src/lib/sandbox/config") as {
    configSet(name: string, options: Record<string, unknown>): Promise<void>;
  };
  const operation = configSet("future", { key: "setting", value: '"new"' });
  return { adapter, audit, commands, loadSelection, logs, operation, persisted };
}

describe("package-backed config set", () => {
  it("ends after the receipt-pinned transaction and exact readback", async () => {
    const result = await runPackageConfigSet();

    await expect(result.operation).resolves.toBeUndefined();
    expect(result.commands).toEqual([
      ["future-config", "validate"],
      ["future-config", "write"],
    ]);
    expect(result.adapter.prepareConfigUpdate).toHaveBeenCalledTimes(2);
    expect(result.loadSelection).toHaveBeenCalledTimes(2);
    expect(result.audit).toHaveBeenCalledOnce();
  });

  it("refuses a changed package receipt before executing the write", async () => {
    const result = await runPackageConfigSet({ changeReceiptOnRecheck: true });

    await expect(result.operation).rejects.toThrow(/package authority changed after validation/u);
    expect(result.commands).toEqual([["future-config", "validate"]]);
    expect(result.audit).not.toHaveBeenCalled();
  });

  it("refuses command drift even when the candidate content is unchanged", async () => {
    const result = await runPackageConfigSet({ changeWriteCommandOnRecheck: true });

    await expect(result.operation).rejects.toThrow(/candidate changed after validation/u);
    expect(result.commands).toEqual([["future-config", "validate"]]);
    expect(result.audit).not.toHaveBeenCalled();
  });

  it("prints external restart guidance without advertising the managed restart flag", async () => {
    const result = await runPackageConfigSet({ restartKind: "external" });

    await expect(result.operation).resolves.toBeUndefined();
    expect(result.logs.join("\n")).toContain("Follow the Future Harness restart procedure.");
    expect(result.logs.join("\n")).not.toContain("--restart");
    expect(result.logs.join("\n")).not.toContain("gateway restart");
  });
});
