// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const PACKAGE_NAME = "@nvidia/nemoclaw-openclaw";
const HARNESS = {
  id: "openclaw",
  runtimeFile: "runtime/openclaw/package.json",
} as const;
const COMMON_PACKAGE_FILES = [
  "README.md",
  "package.json",
  "manifest.yaml",
  "Dockerfile.base",
  "Dockerfile",
  "start.sh",
  "policy-additions.yaml",
] as const;
const COMMON_WORKFLOW_DIRECTORIES = ["config", "runtime", "host", "compat", "plugin", "checks"];
const RUNTIME_CONTRACTS = [
  "host/config-adapter.cts",
  "host/mcp-adapter.cts",
  "host/cli-grammar.cts",
  "host/restore-adapter.cts",
  "host/config-runtime.cts",
  "host/startup-adapter.cts",
] as const;
const PUBLISHED_LOCKFILES = [
  "plugin/npm-shrinkwrap.json",
  "runtime/mcporter/npm-shrinkwrap.json",
  "runtime/messaging/npm-shrinkwrap.json",
  "runtime/openclaw/npm-shrinkwrap.json",
  "runtime/wechat/npm-shrinkwrap.json",
] as const;
const ARCHIVE_SETUP_TIMEOUT_MS = 3 * 60_000;
const PACK_REPORT_MAX_BUFFER = 64 * 1024 * 1024;

type PackedFile = { path?: string; mode?: number };
type PackReport = { filename?: string; files?: PackedFile[] };

let temporaryRoot: string;
let packedFiles: ReadonlyMap<string, PackedFile>;
let installedPackageRoot: string;

function loadInstalledModule<T>(relativePath: string): T {
  const modulePath = path.join(installedPackageRoot, relativePath);
  const moduleRecord: { exports: unknown } = { exports: {} };
  const execute = vm.compileFunction(
    readFileSync(modulePath, "utf8"),
    ["exports", "require", "module", "__filename", "__dirname"],
    { filename: modulePath },
  );
  execute(
    moduleRecord.exports,
    (specifier: string): never => {
      throw new Error(`Installed package runtime modules must be self-contained: ${specifier}`);
    },
    moduleRecord,
    modulePath,
    path.dirname(modulePath),
  );
  return moduleRecord.exports as T;
}

beforeAll(() => {
  temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-archive-"));
  const archiveDirectory = path.join(temporaryRoot, "archive");
  const consumerDirectory = path.join(temporaryRoot, "consumer");
  mkdirSync(archiveDirectory);
  mkdirSync(consumerDirectory);
  writeFileSync(path.join(consumerDirectory, "package.json"), '{"private":true}\n');

  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", archiveDirectory],
      {
        cwd: PACKAGE_ROOT,
        encoding: "utf8",
        maxBuffer: PACK_REPORT_MAX_BUFFER,
      },
    ),
  ) as PackReport[];
  packedFiles = new Map(
    (packed[0]?.files ?? [])
      .filter((entry): entry is PackedFile & { path: string } => typeof entry.path === "string")
      .map((entry) => [entry.path, entry]),
  );
  const filename = packed[0]?.filename;
  expect(filename, "npm pack did not report the OpenClaw archive filename").toBeDefined();

  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--no-save",
      "--offline",
      path.join(archiveDirectory, filename as string),
    ],
    { cwd: consumerDirectory, encoding: "utf8" },
  );
  const consumerRequire = createRequire(path.join(consumerDirectory, "package.json"));
  installedPackageRoot = path.dirname(consumerRequire.resolve(`${PACKAGE_NAME}/package.json`));
}, ARCHIVE_SETUP_TIMEOUT_MS);

afterAll(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
}, ARCHIVE_SETUP_TIMEOUT_MS);

describe("published OpenClaw package", () => {
  it.each([HARNESS])("ships the $id harness package metadata and runtime", (harness) => {
    expect(packedFiles.has("package.json"), "package.json").toBe(true);
    expect(packedFiles.has("manifest.yaml"), "manifest.yaml").toBe(true);
    expect(packedFiles.has(harness.runtimeFile), harness.runtimeFile).toBe(true);
  });

  it.each(COMMON_PACKAGE_FILES)("ships openclaw package workflow file %s", (artifact) => {
    expect(packedFiles.has(artifact)).toBe(true);
  });

  it.each(COMMON_WORKFLOW_DIRECTORIES)(
    "ships a %s responsibility in the openclaw package example",
    (directory) => {
      expect([...packedFiles.keys()].some((artifact) => artifact.startsWith(`${directory}/`))).toBe(
        true,
      );
    },
  );

  it.each(RUNTIME_CONTRACTS)("ships package-owned runtime contract %s", (artifact) => {
    expect(packedFiles.has(artifact)).toBe(true);
  });

  it.each(PUBLISHED_LOCKFILES)("ships production dependency lock %s", (artifact) => {
    expect(packedFiles.has(artifact), artifact).toBe(true);
  });

  it("ships the MCP adapter in the openclaw package", () => {
    expect(packedFiles.has("host/mcp-adapter.cts")).toBe(true);
  });

  it.each(["cli-grammar.cts", "restore-adapter.cts", "config-runtime.cts"])(
    "ships OpenClaw package runtime %s",
    (artifact) => {
      expect(packedFiles.has(`host/${artifact}`)).toBe(true);
    },
  );

  it("ships the openclaw configuration workflow command as executable", () => {
    const artifact = "runtime/generate-config.sh";
    expect((packedFiles.get(artifact)?.mode ?? 0) & 0o111).not.toBe(0);
    expect(statSync(path.join(installedPackageRoot, artifact)).mode & 0o111).not.toBe(0);
  });

  it.each(["runtime/backup-workspace.sh", "compat/npm-remediation.mts"])(
    "ships executable OpenClaw package helper %s",
    (artifact) => {
      expect((packedFiles.get(artifact)?.mode ?? 0) & 0o111).not.toBe(0);
      expect(statSync(path.join(installedPackageRoot, artifact)).mode & 0o111).not.toBe(0);
    },
  );

  it("loads package-owned runtime modules from a normal node_modules installation", () => {
    const configAdapter = loadInstalledModule<{
      prepareConfigUpdate(request: Record<string, unknown>): { kind: string; content?: string };
    }>("host/config-adapter.cts");
    const mcp = loadInstalledModule<{
      buildMcpRegistrationPlan(request: {
        entry: { server: string; url: string; headers: Record<string, string> };
        managedEntries: Array<{
          server: string;
          url: string;
          headers: Record<string, string>;
        }>;
        replaceExisting: boolean;
        teardownRollback: boolean;
        configDirectory: string | null;
      }): { execution: { command: string } };
      buildMcpRemovalPlan(request: {
        entry: { server: string; url: string; headers: Record<string, string> };
        force: boolean;
        adaptiveTeardown: boolean;
        configDirectory: string | null;
      }): { execution: { command: string } };
      buildInspectCommand(
        entry: { server: string; url: string; headers: Record<string, string> },
        failOnMismatch: boolean,
      ): string;
      buildMcpInspectionCommand(request: {
        entry: { server: string; url: string; headers: Record<string, string> };
        failOnMismatch: boolean;
        configDirectory: string | null;
      }): string;
      buildMcpRuntimePlan(request: { command: string[] }): {
        command: string[];
        environmentVariablesToRemove: string[];
      };
      describeMcpMutationCapability(request: { sandboxName: string }): {
        kind: string;
        command: string;
        success: { kind: string };
      };
      describeMcpTeardownCapability(request: { sandboxName: string }): { kind: string };
      describeMcpRuntimeIntentVerification(request: {
        entries: Array<{ server: string; url: string; headers: Record<string, string> }>;
        managedServerNames: string[];
      }): { kind: string };
      mcporterAvailabilityProbe(sandboxName: string): { command: string };
    }>("host/mcp-adapter.cts");
    const runtime = loadInstalledModule<{
      readonly DEFAULT_OPENCLAW_MAX_TOKENS: number;
      applyOpenClawAnthropicReplyBudget(config: Record<string, unknown>, inherited?: number): void;
    }>("host/config-runtime.cts");
    const restore = loadInstalledModule<{
      mergeConfigState(request: Record<string, unknown>): {
        kind: string;
        content?: string;
        write?: { kind: string };
      };
      mergeOpenClawRestoredConfig(backup: unknown, current: unknown): unknown;
    }>("host/restore-adapter.cts");
    const cli = loadInstalledModule<{
      buildOpenclawAgentDeleteArgs(id: string): string[];
    }>("host/cli-grammar.cts");
    const openClawModel: Record<string, unknown> = {};
    const mcpEntry = {
      server: "example",
      url: "https://example.test/mcp",
      headers: {},
    };

    expect(
      configAdapter.prepareConfigUpdate({
        config: {},
        serializedConfig: "{}",
        expectedConfigSha256: "a".repeat(64),
        target: {
          directory: "/sandbox/.openclaw",
          file: "openclaw.json",
          format: "json",
          sensitiveFiles: [],
        },
      }),
    ).toMatchObject({ kind: "transaction", content: "{}" });
    expect(mcp.buildInspectCommand(mcpEntry, true)).toContain("example");
    expect(
      mcp.buildMcpInspectionCommand({
        entry: mcpEntry,
        failOnMismatch: true,
        configDirectory: "/sandbox/.custom-openclaw",
      }),
    ).toContain("/sandbox/.custom-openclaw/workspace");
    expect(mcp.describeMcpMutationCapability({ sandboxName: "sandbox" })).toMatchObject({
      kind: "command",
      command: "command -v mcporter",
      success: { kind: "exit-zero" },
    });
    expect(mcp.describeMcpTeardownCapability({ sandboxName: "sandbox" })).toEqual({
      kind: "not-required",
    });
    expect(
      mcp.describeMcpRuntimeIntentVerification({
        entries: [mcpEntry],
        managedServerNames: ["example"],
      }),
    ).toEqual({ kind: "not-required" });
    expect(mcp.buildMcpRuntimePlan({ command: ["node", "probe.mjs"] }).command).toEqual(
      expect.arrayContaining(["nemoclaw-start", "node", "-e", "probe.mjs"]),
    );
    const optionPrefixedRuntime = mcp.buildMcpRuntimePlan({
      command: ["--require", "child.mjs"],
    }).command;
    expect(optionPrefixedRuntime.slice(0, 4)).toEqual([
      "nemoclaw-start",
      "node",
      "-e",
      expect.any(String),
    ]);
    expect(optionPrefixedRuntime.slice(4)).toEqual(["--", "--require", "child.mjs"]);
    expect(mcp.buildMcpRuntimePlan({ command: ["true"] }).environmentVariablesToRemove).toContain(
      "OPENCLAW_GATEWAY_TOKEN",
    );
    expect(mcp.mcporterAvailabilityProbe("sandbox").command).toBe("command -v mcporter");
    expect(
      mcp.buildMcpRegistrationPlan({
        entry: mcpEntry,
        managedEntries: [mcpEntry],
        replaceExisting: false,
        teardownRollback: false,
        configDirectory: null,
      }),
    ).toMatchObject({ execution: { command: expect.stringContaining("config") } });
    expect(
      mcp.buildMcpRemovalPlan({
        entry: mcpEntry,
        force: false,
        adaptiveTeardown: false,
        configDirectory: null,
      }),
    ).toMatchObject({ execution: { command: expect.stringContaining("example") } });
    runtime.applyOpenClawAnthropicReplyBudget(openClawModel, Number.NaN);
    expect(runtime.DEFAULT_OPENCLAW_MAX_TOKENS).toBe(4096);
    expect(openClawModel.maxTokens).toBe(4096);
    expect(restore.mergeOpenClawRestoredConfig({}, {})).toEqual({});
    expect(
      restore.mergeConfigState({
        backupContent: "{}",
        currentContent: "{}",
        managedChannelNames: [],
        previousImagePluginInstalls: null,
        freshImagePluginInstalls: null,
      }),
    ).toEqual({
      kind: "merged",
      content: "{}\n",
      write: {
        kind: "config-anchors",
        hashFiles: ["openclaw.json", "fabric.json"],
      },
    });
    expect(cli.buildOpenclawAgentDeleteArgs("example")).toEqual([
      "openclaw",
      "agents",
      "delete",
      "example",
      "--force",
    ]);
  });

  it("omits OpenClaw plugin dependencies from the published package", () => {
    expect(
      [...packedFiles.keys()].filter((candidate) => candidate.startsWith("plugin/node_modules/")),
    ).toEqual([]);
  });

  it("omits generated test evidence from published archives", () => {
    expect(
      [...packedFiles.keys()].filter(
        (candidate) =>
          candidate.startsWith(".e2e/") ||
          candidate.startsWith("coverage/") ||
          candidate === "coverage-threshold.json",
      ),
    ).toEqual([]);
  });

  it("omits openclaw package authoring files from archives", () => {
    const authoringPaths = [...packedFiles.keys()].filter(
      (candidate) =>
        candidate.startsWith("tests/") ||
        [
          "package-lock.json",
          "tsconfig.test.json",
          "vitest.config.ts",
          "vitest.nemoclaw.ts",
        ].includes(candidate) ||
        /^plugin\/src\/.+\.test\.ts$/u.test(candidate) ||
        [
          "plugin/tsconfig.test.json",
          "plugin/vitest.config.ts",
          "plugin/vitest.project.ts",
        ].includes(candidate),
    );

    expect(authoringPaths).toEqual([]);
    expect(packedFiles.has("package.json")).toBe(true);
  });

  it("omits generated Python caches", () => {
    expect(
      [...packedFiles.keys()].filter((candidate) =>
        /(?:^|\/)__pycache__(?:\/|$)|\.pyc$/u.test(candidate),
      ),
    ).toEqual([]);
  });
});
