#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const CONTRACT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_ROOT = path.join(CONTRACT_ROOT, "dist");
const TOOL_SOURCES = Object.freeze([
  "build-adapters.mts",
  "validate-package.mts",
  "build-package.mts",
]);
const JAVASCRIPT_SHEBANG = "#!/usr/bin/env node";

function fail(message: string): never {
  throw new Error(`Harness contract tool build failed: ${message}`);
}

function resolveTypeScriptCompiler(): string {
  const require = createRequire(import.meta.url);
  const libraryPath = require.resolve("typescript");
  const compilerPath = path.resolve(path.dirname(libraryPath), "../bin/tsc");
  if (!fs.existsSync(compilerPath) || !fs.statSync(compilerPath).isFile()) {
    fail("development dependencies must provide the TypeScript compiler");
  }
  return compilerPath;
}

function resolveNodeTypeRoot(): string {
  const require = createRequire(import.meta.url);
  return path.dirname(path.dirname(require.resolve("@types/node/package.json")));
}

function compiledToolName(sourceName: string): string {
  return sourceName.replace(/\.mts$/u, ".mjs");
}

function normalizeCompiledTool(contents: string): string {
  const normalized = contents.replace(/\r\n/gu, "\n");
  return normalized.replace(/^#![^\n]*/u, JAVASCRIPT_SHEBANG);
}

function writeTool(outputPath: string, contents: string): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${String(process.pid)}`;
  try {
    fs.writeFileSync(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o755 });
    fs.chmodSync(temporaryPath, 0o755);
    fs.renameSync(temporaryPath, outputPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

export function buildHarnessContractTools(check = false): void {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-contract-tools-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        resolveTypeScriptCompiler(),
        "--ignoreConfig",
        ...TOOL_SOURCES,
        "--module",
        "Node16",
        "--moduleResolution",
        "Node16",
        "--target",
        "ES2022",
        "--strict",
        "--skipLibCheck",
        "--types",
        "node",
        "--typeRoots",
        resolveNodeTypeRoot(),
        "--rewriteRelativeImportExtensions",
        "--outDir",
        temporaryRoot,
        "--declaration",
        "false",
        "--sourceMap",
        "false",
        "--pretty",
        "false",
      ],
      { cwd: CONTRACT_ROOT, encoding: "utf8" },
    );
    if (result.error) fail("TypeScript could not start");
    if (result.status !== 0) {
      fail((result.stdout || result.stderr || "TypeScript rejected the contract tools").trim());
    }

    for (const sourceName of TOOL_SOURCES) {
      const outputName = compiledToolName(sourceName);
      const temporaryPath = path.join(temporaryRoot, outputName);
      if (!fs.existsSync(temporaryPath)) fail(`${sourceName} did not produce ${outputName}`);
      const expected = normalizeCompiledTool(fs.readFileSync(temporaryPath, "utf8"));
      const outputPath = path.join(OUTPUT_ROOT, outputName);
      if (check) {
        if (
          !fs.existsSync(outputPath) ||
          fs.readFileSync(outputPath, "utf8") !== expected ||
          (fs.statSync(outputPath).mode & 0o111) === 0
        ) {
          fail(`${path.relative(CONTRACT_ROOT, outputPath)} is stale; rebuild contract tools`);
        }
      } else {
        writeTool(outputPath, expected);
      }
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function main(): void {
  const arguments_ = process.argv.slice(2);
  if (arguments_.some((argument) => argument !== "--check") || arguments_.length > 1) {
    fail("the only supported option is --check");
  }
  buildHarnessContractTools(arguments_[0] === "--check");
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  main();
}
