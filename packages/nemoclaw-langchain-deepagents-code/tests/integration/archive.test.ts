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
const PACKAGE_NAME = "@nvidia/nemoclaw-langchain-deepagents-code";
const HARNESS = {
  id: "langchain-deepagents-code",
  runtimeFile: "runtime/agent-wrapper.sh",
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
  "host/base-qualification.cts",
  "host/managed-identity.cts",
  "host/mcp-adapter.cts",
  "host/startup-adapter.cts",
] as const;

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
  temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-deepagents-archive-"));
  const archiveDirectory = path.join(temporaryRoot, "archive");
  const consumerDirectory = path.join(temporaryRoot, "consumer");
  mkdirSync(archiveDirectory);
  mkdirSync(consumerDirectory);
  writeFileSync(path.join(consumerDirectory, "package.json"), '{"private":true}\n');

  const dryRun = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
    }),
  ) as PackReport[];
  packedFiles = new Map(
    (dryRun[0]?.files ?? [])
      .filter((entry): entry is PackedFile & { path: string } => typeof entry.path === "string")
      .map((entry) => [entry.path, entry]),
  );

  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", archiveDirectory],
      { cwd: PACKAGE_ROOT, encoding: "utf8" },
    ),
  ) as PackReport[];
  const filename = packed[0]?.filename;
  expect(filename, "npm pack did not report the Deep Agents Code archive filename").toBeDefined();

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
}, 120_000);

afterAll(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
});

describe("published LangChain Deep Agents Code package", () => {
  it.each([HARNESS])("ships the $id harness package metadata and runtime", (harness) => {
    expect(packedFiles.has("package.json"), "package.json").toBe(true);
    expect(packedFiles.has("manifest.yaml"), "manifest.yaml").toBe(true);
    expect(packedFiles.has(harness.runtimeFile), harness.runtimeFile).toBe(true);
  });

  it.each(COMMON_PACKAGE_FILES)(
    "ships langchain-deepagents-code package workflow file %s",
    (artifact) => {
      expect(packedFiles.has(artifact)).toBe(true);
    },
  );

  it.each(COMMON_WORKFLOW_DIRECTORIES)(
    "ships a %s responsibility in the langchain-deepagents-code package example",
    (directory) => {
      expect([...packedFiles.keys()].some((artifact) => artifact.startsWith(`${directory}/`))).toBe(
        true,
      );
    },
  );

  it.each(RUNTIME_CONTRACTS)("ships package-owned runtime contract %s", (artifact) => {
    expect(packedFiles.has(artifact)).toBe(true);
  });

  it("ships the MCP adapter in the langchain-deepagents-code package", () => {
    expect(packedFiles.has("host/mcp-adapter.cts")).toBe(true);
  });

  it("ships the langchain-deepagents-code configuration workflow command as executable", () => {
    const artifact = "runtime/generate-config.sh";
    expect((packedFiles.get(artifact)?.mode ?? 0) & 0o111).not.toBe(0);
    expect(statSync(path.join(installedPackageRoot, artifact)).mode & 0o111).not.toBe(0);
  });

  it("loads package-owned runtime modules from a normal node_modules installation", () => {
    const configAdapter = loadInstalledModule<{
      prepareConfigUpdate(request: Record<string, unknown>): { kind: string; reason?: string };
    }>("host/config-adapter.cts");
    const identity = loadInstalledModule<{
      normalizeManagedDcodeModelName(model: string): string;
    }>("host/managed-identity.cts");
    const qualification = loadInstalledModule<{
      buildDcodeManagedExecLaunchArgs(args: string[]): string[];
      getDeepAgentsCodeBaseImageInputPaths(): string[];
    }>("host/base-qualification.cts");
    const mcp = loadInstalledModule<{
      buildMcpRegistrationPlan(request: {
        entry: { server: string; url: string; headers: Record<string, string> };
        managedEntries: Array<{ server: string; url: string; headers: Record<string, string> }>;
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
      buildStatusCommand(entry: {
        server: string;
        url: string;
        headers: Record<string, string>;
      }): string;
      buildMcpInspectionCommand(request: {
        entry: { server: string; url: string; headers: Record<string, string> };
        failOnMismatch: boolean;
        configDirectory: string | null;
      }): string;
      buildMcpRuntimeCommand(request: { command: string[] }): string[];
      describeMcpMutationCapability(request: { sandboxName: string }): {
        kind: string;
        command: string;
        success: { kind: string; value: string };
      };
      describeMcpTeardownCapability(request: { sandboxName: string }): { kind: string };
      describeMcpRuntimeIntentVerification(request: {
        entries: Array<{ server: string; url: string; headers: Record<string, string> }>;
        managedServerNames: string[];
      }): { kind: string };
      getMutationCapability(sandboxName: string): { command: string; marker: string };
    }>("host/mcp-adapter.cts");

    expect(configAdapter.prepareConfigUpdate({})).toMatchObject({
      kind: "immutable",
      reason: expect.stringContaining("Re-onboard"),
    });

    expect(identity.normalizeManagedDcodeModelName("openrouter:model")).toBe("model");
    expect(qualification.getDeepAgentsCodeBaseImageInputPaths()).toEqual([
      "manifest.yaml",
      "runtime/requirements.lock",
    ]);
    expect(qualification.buildDcodeManagedExecLaunchArgs(["true"])).toEqual(
      expect.arrayContaining(["/usr/local/lib/nemoclaw/dcode-managed-exec", "true"]),
    );
    const mcpEntry = { server: "example", url: "https://example.test/mcp", headers: {} };
    expect(mcp.buildStatusCommand(mcpEntry)).toContain("example");
    expect(
      mcp.buildMcpInspectionCommand({
        entry: mcpEntry,
        failOnMismatch: false,
        configDirectory: null,
      }),
    ).toContain("example");
    expect(mcp.describeMcpMutationCapability({ sandboxName: "sandbox" })).toMatchObject({
      kind: "command",
      command: "/usr/local/bin/deepagents-code --nemoclaw-mcp-capability",
      success: {
        kind: "stdout-trimmed-equals",
        value: "NEMOCLAW_DEEPAGENTS_MCP_CAPABILITY=2",
      },
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
    expect(mcp.buildMcpRuntimeCommand({ command: ["python3", "probe.py"] })).toEqual(
      expect.arrayContaining(["/opt/venv/bin/python3", "-I", "-c", "probe.py"]),
    );
    expect(mcp.getMutationCapability("sandbox")).toMatchObject({
      command: "/usr/local/bin/deepagents-code --nemoclaw-mcp-capability",
      marker: "NEMOCLAW_DEEPAGENTS_MCP_CAPABILITY=2",
    });
    expect(
      mcp.buildMcpRegistrationPlan({
        entry: mcpEntry,
        managedEntries: [mcpEntry],
        replaceExisting: false,
        teardownRollback: false,
        configDirectory: null,
      }),
    ).toMatchObject({ execution: { command: expect.stringContaining("expectedServers") } });
    expect(
      mcp.buildMcpRemovalPlan({
        entry: mcpEntry,
        force: false,
        adaptiveTeardown: false,
        configDirectory: null,
      }),
    ).toMatchObject({
      execution: { command: expect.stringContaining("NEMOCLAW_DEEPAGENTS_MCP_REMOVAL") },
    });
  });

  it("omits langchain-deepagents-code package authoring files from archives", () => {
    const authoringPaths = [...packedFiles.keys()].filter(
      (candidate) =>
        candidate.startsWith("tests/") ||
        [
          "package-lock.json",
          "tsconfig.test.json",
          "vitest.config.ts",
          "vitest.nemoclaw.ts",
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
