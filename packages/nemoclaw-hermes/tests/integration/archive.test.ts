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
const PACKAGE_NAME = "@nvidia/nemoclaw-hermes";
const HARNESS = { id: "hermes", runtimeFile: "runtime/cli-wrapper.py" } as const;
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
  "host/managed-route.cts",
  "host/mcp-adapter.cts",
  "host/base-qualification.cts",
] as const;
const PROVIDER_PROFILES = [
  "provider-profiles/langfuse-hermes-v1.yaml",
  "provider-profiles/tavily-hermes-v1.yaml",
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
  temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-archive-"));
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
  expect(filename, "npm pack did not report the Hermes archive filename").toBeDefined();

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

describe("published Hermes package", () => {
  it.each([HARNESS])("ships the $id harness package metadata and runtime", (harness) => {
    expect(packedFiles.has("package.json"), "package.json").toBe(true);
    expect(packedFiles.has("manifest.yaml"), "manifest.yaml").toBe(true);
    expect(packedFiles.has(harness.runtimeFile), harness.runtimeFile).toBe(true);
  });

  it.each(COMMON_PACKAGE_FILES)("ships hermes package workflow file %s", (artifact) => {
    expect(packedFiles.has(artifact)).toBe(true);
  });

  it.each(COMMON_WORKFLOW_DIRECTORIES)(
    "ships a %s responsibility in the hermes package example",
    (directory) => {
      expect([...packedFiles.keys()].some((artifact) => artifact.startsWith(`${directory}/`))).toBe(
        true,
      );
    },
  );

  it.each(RUNTIME_CONTRACTS)("ships package-owned runtime contract %s", (artifact) => {
    expect(packedFiles.has(artifact)).toBe(true);
  });

  it.each(PROVIDER_PROFILES)("ships package-owned provider profile %s", (artifact) => {
    expect(packedFiles.has(artifact)).toBe(true);
  });

  it("ships the MCP adapter in the hermes package", () => {
    expect(packedFiles.has("host/mcp-adapter.cts")).toBe(true);
  });

  it("ships the hermes configuration workflow command as executable", () => {
    const artifact = "runtime/generate-config.sh";
    expect((packedFiles.get(artifact)?.mode ?? 0) & 0o111).not.toBe(0);
    expect(statSync(path.join(installedPackageRoot, artifact)).mode & 0o111).not.toBe(0);
  });

  it("loads package-owned runtime modules from a normal node_modules installation", () => {
    const configAdapter = loadInstalledModule<{
      prepareConfigUpdate(request: Record<string, unknown>): { kind: string; content?: string };
    }>("host/config-adapter.cts");
    const managedRoute = loadInstalledModule<{
      buildHermesUpstreamHeader(config: Record<string, unknown>): string;
      hermesProviderKey(provider: string): string;
    }>("host/managed-route.cts");
    const qualification = loadInstalledModule<{
      createHermesBaseImageQualificationProbe(imageRef: string): { args: string[] };
      parseHermesPinnedRemoteBaseRef(dockerfile: string): string | null;
    }>("host/base-qualification.cts");
    const mcp = loadInstalledModule<{
      buildMcpRegistrationPlan(request: {
        entry: { server: string; url: string; headers: Record<string, string> };
        managedEntries: Array<{ server: string; url: string; headers: Record<string, string> }>;
        replaceExisting: boolean;
        teardownRollback: boolean;
        configDirectory: string | null;
      }): { execution: { command: string[] } };
      buildMcpRemovalPlan(request: {
        entry: { server: string; url: string; headers: Record<string, string> };
        force: boolean;
        adaptiveTeardown: boolean;
        configDirectory: string | null;
      }): { execution: { command: string[] } };
      buildInspectCommand(payload: string): string[];
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
        command: string[];
        success: { kind: string };
        retry: {
          outputExact: string;
          initialAttempts: number;
          intervalMilliseconds: number;
          recovery: { kind: string; timeoutSeconds: number; postRecoveryAttempts: number };
        };
      };
      describeMcpTeardownCapability(request: { sandboxName: string }): {
        kind: string;
        command: string[];
        success: { kind: string };
      };
      describeMcpRuntimeIntentVerification(request: {
        entries: Array<{ server: string; url: string; headers: Record<string, string> }>;
        managedServerNames: string[];
      }): {
        kind: string;
        command: string[];
        success: { kind: string };
        retry: { outputExact: string; initialAttempts: number; intervalMilliseconds: number };
      };
    }>("host/mcp-adapter.cts");

    expect(
      configAdapter.prepareConfigUpdate({
        config: { _nemoclaw_upstream: { provider: "NVIDIA", model: "test/model" } },
        serializedConfig: "model: {}\n",
        expectedConfigSha256: "a".repeat(64),
        target: {
          directory: "/sandbox/.hermes",
          file: "config.yaml",
          format: "yaml",
          sensitiveFiles: [],
        },
      }),
    ).toMatchObject({
      kind: "transaction",
      content: expect.stringContaining("# Upstream provider: NVIDIA"),
    });

    expect(managedRoute.hermesProviderKey("NVIDIA NIM")).toBe("nvidia-nim");
    expect(
      managedRoute.buildHermesUpstreamHeader({
        _nemoclaw_upstream: { provider: "NVIDIA NIM", model: "test/model" },
      }),
    ).toContain("# Upstream provider: NVIDIA NIM\n# Upstream model: test/model\n");
    expect(qualification.createHermesBaseImageQualificationProbe("hermes:test").args).toContain(
      "hermes:test",
    );
    expect(
      qualification.parseHermesPinnedRemoteBaseRef(
        `ARG BASE_IMAGE=ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${"a".repeat(64)}\n`,
      ),
    ).toContain("hermes-sandbox-base@sha256:");
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
      command: ["/usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py", "probe"],
      success: { kind: "last-json-line-ok" },
      retry: {
        outputExact: "Hermes gateway is not running for managed MCP reload",
        initialAttempts: 3,
        intervalMilliseconds: 1000,
        recovery: {
          kind: "agent-gateway",
          timeoutSeconds: 210,
          postRecoveryAttempts: 90,
        },
      },
    });
    expect(mcp.describeMcpTeardownCapability({ sandboxName: "sandbox" })).toMatchObject({
      kind: "command",
      success: { kind: "last-json-line-ok" },
    });
    expect(
      mcp.describeMcpRuntimeIntentVerification({
        entries: [mcpEntry],
        managedServerNames: ["example", "removed"],
      }),
    ).toMatchObject({
      kind: "command",
      command: [
        "/usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py",
        "inspect",
        "--payload",
        expect.stringContaining('"absent":["removed"]'),
      ],
      success: { kind: "last-json-line-ok" },
      retry: {
        outputExact: "refusing raced Hermes MCP integrity snapshot",
        initialAttempts: 6,
        intervalMilliseconds: 500,
      },
    });
    expect(mcp.buildMcpRuntimeCommand({ command: ["python", "probe.py"] })).toEqual(
      expect.arrayContaining(["/opt/hermes/.venv/bin/python", "-I", "-c", "probe.py"]),
    );
    expect(mcp.buildInspectCommand("payload")).toEqual([
      "/usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py",
      "inspect",
      "--payload",
      "payload",
    ]);
    expect(
      mcp.buildMcpRegistrationPlan({
        entry: mcpEntry,
        managedEntries: [mcpEntry],
        replaceExisting: false,
        teardownRollback: false,
        configDirectory: null,
      }),
    ).toMatchObject({ execution: { command: expect.arrayContaining(["add", "--payload"]) } });
    expect(
      mcp.buildMcpRemovalPlan({
        entry: mcpEntry,
        force: false,
        adaptiveTeardown: false,
        configDirectory: null,
      }),
    ).toMatchObject({ execution: { command: expect.arrayContaining(["remove", "--payload"]) } });
  });

  it("omits hermes package authoring files from archives", () => {
    const authoringPaths = [...packedFiles.keys()].filter(
      (candidate) =>
        candidate.startsWith("tests/") ||
        [
          "package-lock.json",
          "tsconfig.test.json",
          "vitest.config.ts",
          "vitest.nemoclaw.ts",
        ].includes(candidate) ||
        /^plugin\/test_[^/]+\.py$/u.test(candidate),
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
