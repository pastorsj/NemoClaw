// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const PREVIOUS_COMMAND_ARTIFACT = "dist/commands/deploy.js";
const PREVIOUS_COMMAND_DECLARATION = "dist/commands/deploy.d.ts";
const PREVIOUS_COMMAND_SOURCE_MAP = "dist/commands/deploy.js.map";
const PREVIOUS_ACTION_ARTIFACT = "dist/lib/actions/deploy.js";
const PREVIOUS_ACTION_DECLARATION_MAP = "dist/lib/actions/deploy.d.ts.map";
const PREVIOUS_IMPLEMENTATION_ARTIFACT = "dist/lib/deploy/index.js";
const HARNESS_BUILD_MARKER = "dist/harnesses/.fixture-build-complete";

function writeHarnessBuildFixture(fixtureRoot: string): void {
  const scriptsRoot = path.join(fixtureRoot, "scripts");
  mkdirSync(scriptsRoot);
  writeFileSync(
    path.join(scriptsRoot, "build-harnesses.mts"),
    `import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

const fixtureRoot = realpathSync(path.resolve(import.meta.dirname, ".."));
if (realpathSync(process.cwd()) !== fixtureRoot) {
  throw new Error("Harness build fixture must run from its temporary source checkout");
}
const markerPath = path.join(fixtureRoot, ${JSON.stringify(HARNESS_BUILD_MARKER)});
mkdirSync(path.dirname(markerPath), { recursive: true });
writeFileSync(markerPath, "fixture harness build completed\\n");
`,
  );
}

describe("CLI source-checkout upgrade build", () => {
  it("prunes compiled deploy artifacts before the normal build (#10572)", () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "nemoclaw-cli-upgrade-build-"));
    try {
      copyFileSync(
        path.join(REPOSITORY_ROOT, "package.json"),
        path.join(fixtureRoot, "package.json"),
      );
      copyFileSync(
        path.join(REPOSITORY_ROOT, "tsconfig.src.json"),
        path.join(fixtureRoot, "tsconfig.src.json"),
      );
      copyFileSync(
        path.join(REPOSITORY_ROOT, "tsconfig.shared.json"),
        path.join(fixtureRoot, "tsconfig.shared.json"),
      );
      writeFileSync(path.join(fixtureRoot, ".source-revision"), `${"a".repeat(40)}\n`);
      // The harness builder has its own artifact contract tests. This fixture keeps the normal
      // build command intact and proves its final step runs without copying every harness source.
      writeHarnessBuildFixture(fixtureRoot);

      symlinkSync(path.join(REPOSITORY_ROOT, "bin"), path.join(fixtureRoot, "bin"), "junction");
      symlinkSync(
        path.join(REPOSITORY_ROOT, "managed-inference"),
        path.join(fixtureRoot, "managed-inference"),
        "junction",
      );
      symlinkSync(
        path.join(REPOSITORY_ROOT, "node_modules"),
        path.join(fixtureRoot, "node_modules"),
        "junction",
      );
      symlinkSync(path.join(REPOSITORY_ROOT, "src"), path.join(fixtureRoot, "src"), "junction");

      const blueprintRoot = path.join(fixtureRoot, "nemoclaw-blueprint");
      mkdirSync(blueprintRoot);
      copyFileSync(
        path.join(REPOSITORY_ROOT, "nemoclaw-blueprint", "tsconfig.json"),
        path.join(blueprintRoot, "tsconfig.json"),
      );
      symlinkSync(
        path.join(REPOSITORY_ROOT, "nemoclaw-blueprint", "scripts"),
        path.join(blueprintRoot, "scripts"),
        "junction",
      );

      const previousCommandPath = path.join(fixtureRoot, PREVIOUS_COMMAND_ARTIFACT);
      const previousCommandDeclarationPath = path.join(fixtureRoot, PREVIOUS_COMMAND_DECLARATION);
      const previousCommandSourceMapPath = path.join(fixtureRoot, PREVIOUS_COMMAND_SOURCE_MAP);
      const previousActionPath = path.join(fixtureRoot, PREVIOUS_ACTION_ARTIFACT);
      const previousActionDeclarationMapPath = path.join(
        fixtureRoot,
        PREVIOUS_ACTION_DECLARATION_MAP,
      );
      const previousImplementationPath = path.join(fixtureRoot, PREVIOUS_IMPLEMENTATION_ARTIFACT);
      mkdirSync(path.dirname(previousCommandPath), { recursive: true });
      mkdirSync(path.dirname(previousActionPath), { recursive: true });
      mkdirSync(path.dirname(previousImplementationPath), { recursive: true });
      writeFileSync(previousCommandPath, "module.exports = {};\n");
      writeFileSync(previousCommandDeclarationPath, "export {};\n");
      writeFileSync(previousCommandSourceMapPath, "{}\n");
      writeFileSync(previousActionPath, "module.exports = {};\n");
      writeFileSync(previousActionDeclarationMapPath, "{}\n");
      writeFileSync(previousImplementationPath, "module.exports = {};\n");

      const staleMetadataPath = path.join(
        fixtureRoot,
        "dist/lib/cli/oclif-command-metadata.generated.json",
      );
      mkdirSync(path.dirname(staleMetadataPath), { recursive: true });
      writeFileSync(
        staleMetadataPath,
        `${JSON.stringify({ deploy: { id: "deploy", summary: "Deprecated Brev command" } })}\n`,
      );

      const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
      const build = spawnSync(npmExecutable, ["run", "build:cli"], {
        cwd: fixtureRoot,
        encoding: "utf8",
        env: process.env,
        timeout: 120_000,
      });
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
      expect(existsSync(path.join(fixtureRoot, HARNESS_BUILD_MARKER))).toBe(true);

      expect(existsSync(previousCommandPath), PREVIOUS_COMMAND_ARTIFACT).toBe(false);
      expect(existsSync(previousCommandDeclarationPath), PREVIOUS_COMMAND_DECLARATION).toBe(false);
      expect(existsSync(previousCommandSourceMapPath), PREVIOUS_COMMAND_SOURCE_MAP).toBe(false);
      expect(existsSync(previousActionPath), PREVIOUS_ACTION_ARTIFACT).toBe(false);
      expect(existsSync(previousActionDeclarationMapPath), PREVIOUS_ACTION_DECLARATION_MAP).toBe(
        false,
      );
      expect(existsSync(previousImplementationPath), PREVIOUS_IMPLEMENTATION_ARTIFACT).toBe(false);
      const routing = spawnSync(
        process.execPath,
        [
          "-e",
          "const registry = require('./dist/lib/cli/command-registry'); process.stdout.write(String(registry.globalCommandTokens().has('deploy')))",
        ],
        { cwd: fixtureRoot, encoding: "utf8", env: process.env },
      );
      expect(routing.status, routing.stderr).toBe(0);
      expect(routing.stdout).toBe("false");

      const help = spawnSync(process.execPath, ["bin/nemoclaw.js", "deploy", "--help"], {
        cwd: fixtureRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: path.join(fixtureRoot, "home"),
          NEMOCLAW_DISABLE_GATEWAY_DRIFT_PREFLIGHT: "1",
        },
        timeout: 30_000,
      });
      expect(help.status, help.stderr).toBe(0);
      expect(help.stdout).toContain("Usage: nemoclaw deploy connect");
      expect(help.stdout).not.toContain("Brev-specific");
    } finally {
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  }, 150_000);
});
