#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ADAPTER_FILE = /^[a-z][a-z0-9-]*-adapter\.cts$/u;
const SPDX_HEADER =
  "// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.\n" +
  "// SPDX-License-Identifier: Apache-2.0\n";

function fail(message: string): never {
  throw new Error(`Harness adapter build failed: ${message}`);
}

function containsRuntimeRequire(source: string): boolean {
  const sourceFile = ts.createSourceFile(
    "adapter.cjs",
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS,
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function compileAdapter(packageRoot: string, sourcePath: string): string {
  const compilerPath = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc");
  if (!fs.existsSync(compilerPath) || !fs.statSync(compilerPath).isFile()) {
    fail("package development dependencies must provide the TypeScript compiler");
  }
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-adapter-build-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        compilerPath,
        sourcePath,
        "--module",
        "Node16",
        "--moduleResolution",
        "Node16",
        "--target",
        "ES2022",
        "--strict",
        "--skipLibCheck",
        "--outDir",
        outputRoot,
        "--declaration",
        "false",
        "--sourceMap",
        "false",
        "--pretty",
        "false",
      ],
      { cwd: packageRoot, encoding: "utf8" },
    );
    if (result.error) fail(`${path.basename(sourcePath)} could not start TypeScript`);
    if (result.status !== 0) {
      fail((result.stdout || result.stderr || "TypeScript rejected the adapter source").trim());
    }
    const emittedPath = path.join(outputRoot, path.basename(sourcePath).replace(/\.cts$/u, ".cjs"));
    if (!fs.existsSync(emittedPath)) {
      fail(`${path.basename(sourcePath)} did not produce a CommonJS artifact`);
    }
    const emitted = fs.readFileSync(emittedPath, "utf8").replace(/\r\n/gu, "\n");
    const strictPrefix = `"use strict";\n${SPDX_HEADER}`;
    const output = emitted.startsWith(strictPrefix)
      ? `${SPDX_HEADER}"use strict";\n${emitted.slice(strictPrefix.length)}`
      : emitted;
    if (!output.includes("module.exports =") || containsRuntimeRequire(output)) {
      fail(`${path.basename(sourcePath)} did not compile to one self-contained CommonJS module`);
    }
    return output;
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
}

function writeAdapter(artifactPath: string, output: string): void {
  const temporaryPath = `${artifactPath}.tmp-${String(process.pid)}`;
  try {
    fs.writeFileSync(temporaryPath, output, { encoding: "utf8", mode: 0o644, flag: "wx" });
    fs.renameSync(temporaryPath, artifactPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

export function buildHarnessAdapterArtifacts(packageRootInput: string, check = false): void {
  const packageRoot = path.resolve(packageRootInput);
  const sourceRoot = path.join(packageRoot, "host", "source");
  if (
    !fs.existsSync(packageRoot) ||
    !fs.statSync(packageRoot).isDirectory() ||
    !fs.existsSync(sourceRoot) ||
    !fs.statSync(sourceRoot).isDirectory()
  ) {
    fail("package root must contain host/source");
  }
  const sourceFiles = fs
    .readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && ADAPTER_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (sourceFiles.length === 0) fail("host/source does not contain an adapter source");

  for (const fileName of sourceFiles) {
    const sourcePath = path.join(sourceRoot, fileName);
    const artifactPath = path.join(packageRoot, "host", fileName);
    const output = compileAdapter(packageRoot, sourcePath);
    if (check) {
      if (!fs.existsSync(artifactPath) || fs.readFileSync(artifactPath, "utf8") !== output) {
        fail(`${path.relative(packageRoot, artifactPath)} is stale; rebuild package adapters`);
      }
    } else {
      writeAdapter(artifactPath, output);
    }
  }
}

export function assertHarnessAdapterArtifactsCurrent(packageRoot: string): void {
  const sourceRoot = path.join(packageRoot, "host", "source");
  if (!fs.existsSync(sourceRoot)) return;
  buildHarnessAdapterArtifacts(packageRoot, true);
}

function main(): void {
  const arguments_ = process.argv.slice(2);
  const check = arguments_.includes("--check");
  const packageArguments = arguments_.filter((argument) => argument !== "--check");
  if (packageArguments.length !== 1) fail("provide exactly one package root");
  buildHarnessAdapterArtifacts(packageArguments[0], check);
}

function isMainModule(): boolean {
  const invokedPath = process.argv[1];
  if (!invokedPath) return false;
  try {
    return fs.realpathSync(invokedPath) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) main();
