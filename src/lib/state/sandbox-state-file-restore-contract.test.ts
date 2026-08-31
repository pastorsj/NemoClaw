// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { restoreEnv } from "../../../test/helpers/env-test-helpers";
import { loadAgent, type AgentDefinition } from "../agent/defs";
import {
  SCHEMA_V2_SNAPSHOT_RESTORE_AUTHORITY_ERROR,
  restoreRecreatedSandboxState,
  type StateFileSpec,
} from "./sandbox";

const fixtures: string[] = [];

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}

function writeBackup(options: {
  agentType?: string;
  dir?: string;
  stateFiles: StateFileSpec[];
}): string {
  const backupPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-state-contract-"));
  fixtures.push(backupPath);
  for (const stateFile of options.stateFiles) {
    const target = path.join(backupPath, stateFile.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "backed-up state\n");
  }
  fs.writeFileSync(
    path.join(backupPath, "rebuild-manifest.json"),
    JSON.stringify({
      version: 1,
      sandboxName: "alpha",
      timestamp: "2026-07-09T00:00:00.000Z",
      agentType: options.agentType ?? "langchain-deepagents-code",
      agentVersion: null,
      expectedVersion: null,
      stateDirs: [],
      backedUpDirs: [],
      stateFiles: options.stateFiles,
      dir: options.dir ?? "/sandbox/.deepagents",
      backupPath,
      blueprintDigest: null,
    }),
  );
  return backupPath;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

describe("state-file restore target contract", () => {
  it.each([
    {
      description: "identical paths",
      stateFiles: [
        { path: "config.toml", strategy: "copy" as const },
        { path: "config.toml", strategy: "copy" as const },
      ],
    },
    {
      description: "normalized path aliases",
      stateFiles: [
        { path: "config.toml", strategy: "copy" as const },
        { path: "./config.toml", strategy: "copy" as const },
      ],
    },
  ])("rejects repeated backup state-file $description", ({ stateFiles }) => {
    const backupPath = writeBackup({ stateFiles });

    const result = restoreRecreatedSandboxState("alpha", backupPath, {
      targetAgentType: "langchain-deepagents-code",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Backup manifest repeats state file 'config.toml'");
    expect(result.failedFiles).toContain("config.toml");
  });

  it("rejects a backup agent that does not match the recreated target", () => {
    const backupPath = writeBackup({
      stateFiles: [{ path: "config.toml", strategy: "copy" }],
    });

    const result = restoreRecreatedSandboxState("alpha", backupPath, {
      targetAgentType: "openclaw",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("does not match target agent");
    expect(result.failedFiles).toEqual(["config.toml"]);
  });

  it("rejects a stale backup file that the target manifest does not declare", () => {
    const backupPath = writeBackup({
      stateFiles: [{ path: "stale.toml", strategy: "copy" }],
    });

    const result = restoreRecreatedSandboxState("alpha", backupPath, {
      targetAgentType: "langchain-deepagents-code",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("is not declared by target agent");
    expect(result.failedFiles).toEqual(["stale.toml"]);
  });

  it("rejects a backup state-file strategy that differs from the target manifest", () => {
    const backupPath = writeBackup({
      stateFiles: [{ path: "config.toml", strategy: "sqlite_backup" }],
    });

    const result = restoreRecreatedSandboxState("alpha", backupPath, {
      targetAgentType: "langchain-deepagents-code",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("does not match target strategy 'copy'");
    expect(result.failedFiles).toEqual(["config.toml"]);
  });

  it("rejects a backup state directory that differs from the current target manifest", () => {
    const backupPath = writeBackup({
      dir: "/sandbox/.unexpected",
      stateFiles: [{ path: "config.toml", strategy: "copy" }],
    });

    const result = restoreRecreatedSandboxState("alpha", backupPath, {
      targetAgentType: "langchain-deepagents-code",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("does not match target directory");
    expect(result.failedFiles).toEqual(["config.toml"]);
  });

  it("uses the pinned package definition instead of the checkout definition", () => {
    const checkoutDefinition = loadAgent("langchain-deepagents-code");
    const packageDefinition = Object.freeze({
      ...checkoutDefinition,
      packageRoot: "/installed/package-a",
      configPaths: { ...checkoutDefinition.configPaths, dir: "/sandbox/.package-a" },
      stateFiles: [{ path: "package-a.db", strategy: "sqlite_backup" as const }],
    }) satisfies AgentDefinition;
    const backupPath = writeBackup({
      dir: packageDefinition.configPaths.dir,
      stateFiles: [{ path: "package-a.db", strategy: "sqlite_backup" }],
    });
    // The declaration remains in the manifest so restore validates its path
    // and strategy, but no remote SSH mutation is needed for this contract test.
    fs.rmSync(path.join(backupPath, "package-a.db"));
    const validateBeforeMutation = vi.fn();

    const result = restoreRecreatedSandboxState("alpha", backupPath, {
      targetAgentType: "langchain-deepagents-code",
      agentDefinition: packageDefinition,
      validateBeforeMutation,
    });

    expect(checkoutDefinition.configPaths.dir).not.toBe(packageDefinition.configPaths.dir);
    expect(checkoutDefinition.stateFiles).not.toContainEqual({
      path: "package-a.db",
      strategy: "sqlite_backup",
    });
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(validateBeforeMutation).toHaveBeenCalledOnce();
  });

  it("restores staged state-file bytes when the backup path changes after the mutation fence", () => {
    const packageDefinition = Object.freeze({
      ...loadAgent("langchain-deepagents-code"),
      packageRoot: "/installed/package-a",
      stateFiles: [{ path: "state.bin", strategy: "copy" as const }],
    }) satisfies AgentDefinition;
    const backupPath = writeBackup({
      stateFiles: [{ path: "state.bin", strategy: "copy" }],
    });
    const statePath = path.join(backupPath, "state.bin");
    const selectedContents = fs.readFileSync(statePath);
    const runtimeFixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-state-runtime-"));
    fixtures.push(runtimeFixture);
    const binDir = path.join(runtimeFixture, "bin");
    const restoredInputPath = path.join(runtimeFixture, "restored-input.bin");
    fs.mkdirSync(binDir, { recursive: true });
    const openshellPath = path.join(binDir, "openshell");
    writeExecutable(
      openshellPath,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("ssh-config")) {
  process.stdout.write("Host openshell-alpha\\n  HostName 127.0.0.1\\n  User sandbox\\n");
}
process.exit(0);
`,
    );
    writeExecutable(
      path.join(binDir, "ssh"),
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(restoredInputPath)}, fs.readFileSync(0));
process.exit(0);
`,
    );
    const previousOpenshellBinary = process.env.NEMOCLAW_OPENSHELL_BIN;
    const previousPath = process.env.PATH;
    process.env.NEMOCLAW_OPENSHELL_BIN = openshellPath;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    const validateBeforeMutation = vi.fn(() => {
      fs.writeFileSync(statePath, "changed after validation\n");
    });

    try {
      const result = restoreRecreatedSandboxState("alpha", backupPath, {
        targetAgentType: "langchain-deepagents-code",
        agentDefinition: packageDefinition,
        validateBeforeMutation,
      });

      expect(result).toMatchObject({ success: true, restoredFiles: ["state.bin"] });
      expect(validateBeforeMutation).toHaveBeenCalledOnce();
      expect(fs.readFileSync(restoredInputPath)).toEqual(selectedContents);
      expect(fs.readFileSync(statePath, "utf8")).toBe("changed after validation\n");
    } finally {
      restoreEnv("NEMOCLAW_OPENSHELL_BIN", previousOpenshellBinary);
      restoreEnv("PATH", previousPath);
    }
  });

  it("rejects a declared backup state-file symlink before target mutation", () => {
    const packageDefinition = Object.freeze({
      ...loadAgent("langchain-deepagents-code"),
      packageRoot: "/installed/package-a",
      stateFiles: [{ path: "nested/state.bin", strategy: "copy" as const }],
    }) satisfies AgentDefinition;
    const backupPath = writeBackup({
      stateFiles: [{ path: "nested/state.bin", strategy: "copy" }],
    });
    const externalFixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-external-state-"));
    fixtures.push(externalFixture);
    const externalState = path.join(externalFixture, "sentinel.bin");
    const sentinel = "external sentinel must not be restored\n";
    fs.writeFileSync(externalState, sentinel);
    const statePath = path.join(backupPath, "nested/state.bin");
    fs.rmSync(statePath);
    fs.symlinkSync(externalState, statePath);

    const runtimeFixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-state-runtime-"));
    fixtures.push(runtimeFixture);
    const openshellPath = path.join(runtimeFixture, "openshell");
    writeExecutable(
      openshellPath,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("ssh-config")) {
  process.stdout.write("Host openshell-alpha\\n  HostName 127.0.0.1\\n  User sandbox\\n");
}
process.exit(0);
`,
    );
    const previousOpenshellBinary = process.env.NEMOCLAW_OPENSHELL_BIN;
    process.env.NEMOCLAW_OPENSHELL_BIN = openshellPath;
    const validateBeforeMutation = vi.fn();

    try {
      const result = restoreRecreatedSandboxState("alpha", backupPath, {
        targetAgentType: "langchain-deepagents-code",
        agentDefinition: packageDefinition,
        validateBeforeMutation,
      });

      expect(result).toMatchObject({
        success: false,
        failedFiles: ["nested/state.bin"],
        error: expect.stringContaining("Could not stage backup state files safely"),
      });
      expect(validateBeforeMutation).not.toHaveBeenCalled();
      expect(fs.readFileSync(externalState, "utf8")).toBe(sentinel);
    } finally {
      restoreEnv("NEMOCLAW_OPENSHELL_BIN", previousOpenshellBinary);
    }
  });

  it.each([
    ["definition, content authority, and mutation fence", false, false, false],
    ["content authority and mutation fence", true, false, false],
    ["mutation fence", true, true, false],
    ["content authority", true, false, true],
  ] as const)(
    "rejects schema v2 package state without %s",
    (_missing, includeDefinition, includeAuthority, includeMutationFence) => {
      const backupPath = writeBackup({ stateFiles: [] });
      const manifestPath = path.join(backupPath, "rebuild-manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({
          ...manifest,
          version: 2,
          harnessPackage: {
            kind: "agent-runtime",
            id: "langchain-deepagents-code",
            packageVersion: "1.2.3",
            contentDigest: "a".repeat(64),
          },
        }),
      );
      const definition = loadAgent("langchain-deepagents-code");
      const authority = {
        schemaVersion: 1 as const,
        backupPath,
        contentSha256: "b".repeat(64),
      };
      expect(
        restoreRecreatedSandboxState("alpha", backupPath, {
          targetAgentType: "langchain-deepagents-code",
          ...(includeDefinition ? { agentDefinition: definition } : {}),
          ...(includeAuthority ? { authority } : {}),
          ...(includeMutationFence ? { validateBeforeMutation: vi.fn() } : {}),
        }),
      ).toMatchObject({
        success: false,
        error: SCHEMA_V2_SNAPSHOT_RESTORE_AUTHORITY_ERROR,
      });
    },
  );

  it("rejects schema v2 candidate state before raw compatibility can load it", () => {
    const backupPath = writeBackup({ stateFiles: [] });
    const manifestPath = path.join(backupPath, "rebuild-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        ...manifest,
        version: 2,
        agentType: "pi",
        harnessPackage: null,
      }),
    );

    expect(
      restoreRecreatedSandboxState("alpha", backupPath, { targetAgentType: "pi" }),
    ).toMatchObject({
      success: false,
      error: SCHEMA_V2_SNAPSHOT_RESTORE_AUTHORITY_ERROR,
    });
  });
});
