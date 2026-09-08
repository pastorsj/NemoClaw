#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Materialize one reviewed, harness-neutral runtime artifact into a package checkout. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_ROOT = path.basename(TOOL_ROOT) === "dist" ? path.dirname(TOOL_ROOT) : TOOL_ROOT;
const RUNTIME_ROOT = path.join(CONTRACT_ROOT, "runtime");
const MAX_RUNTIME_BYTES = 4 * 1024 * 1024;
const RUNTIME_ARTIFACTS = Object.freeze({
  "managed-gateway": Object.freeze({ source: "gateway-runtime.py", mode: 0o755 }),
  "messaging-build": Object.freeze({ source: "messaging-build.mts", mode: 0o644 }),
});

export type HarnessRuntimeArtifact = keyof typeof RUNTIME_ARTIFACTS;

function fail(message: string): never {
  throw new Error(`Harness runtime materialization failed: ${message}`);
}

function isInsideRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function requireRegularFile(filePath: string, label: string): fs.Stats {
  const metadata = fs.lstatSync(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) fail(`${label} must be a regular file`);
  return metadata;
}

function requireSafeDestination(destination: string, workingDirectory: string): string {
  if (path.isAbsolute(destination)) fail("the destination must be relative to the package root");
  const outputPath = path.resolve(workingDirectory, destination);
  if (!isInsideRoot(outputPath, workingDirectory)) fail("the destination escapes the package root");
  const parent = path.dirname(outputPath);
  fs.mkdirSync(parent, { recursive: true });
  const canonicalParent = fs.realpathSync.native(parent);
  if (!isInsideRoot(canonicalParent, workingDirectory)) {
    fail("the destination parent escapes the package root");
  }
  if (fs.existsSync(outputPath)) requireRegularFile(outputPath, "the existing destination");
  return outputPath;
}

function runtimeSource(artifact: HarnessRuntimeArtifact): Buffer {
  const sourcePath = path.join(RUNTIME_ROOT, RUNTIME_ARTIFACTS[artifact].source);
  const metadata = requireRegularFile(sourcePath, `runtime artifact '${artifact}'`);
  if (metadata.size > MAX_RUNTIME_BYTES) fail(`runtime artifact '${artifact}' exceeds its limit`);
  return fs.readFileSync(sourcePath);
}

export function materializeHarnessRuntime(options: {
  readonly artifact: HarnessRuntimeArtifact;
  readonly destination: string;
  readonly check?: boolean;
  readonly workingDirectory?: string;
}): void {
  const workingDirectory = fs.realpathSync.native(path.resolve(options.workingDirectory ?? "."));
  const outputPath = requireSafeDestination(options.destination, workingDirectory);
  const expected = runtimeSource(options.artifact);
  const expectedMode = RUNTIME_ARTIFACTS[options.artifact].mode;
  if (options.check) {
    if (!fs.existsSync(outputPath) || !fs.readFileSync(outputPath).equals(expected)) {
      fail(`${options.destination} is stale; materialize '${options.artifact}' again`);
    }
    if ((fs.statSync(outputPath).mode & 0o777) !== expectedMode) {
      fail(`${options.destination} has a stale mode; materialize '${options.artifact}' again`);
    }
    return;
  }
  const temporaryPath = `${outputPath}.tmp-${String(process.pid)}`;
  try {
    fs.writeFileSync(temporaryPath, expected, { flag: "wx", mode: expectedMode });
    fs.chmodSync(temporaryPath, expectedMode);
    fs.renameSync(temporaryPath, outputPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function usage(): string {
  return "Usage: nemoclaw-materialize-runtime <managed-gateway|messaging-build> <relative-destination> [--check]";
}

function main(args: readonly string[]): void {
  const check = args.at(-1) === "--check";
  const positionals = check ? args.slice(0, -1) : args;
  if (positionals.length !== 2 || args.filter((value) => value === "--check").length > 1) {
    fail(usage());
  }
  const [artifact, destination] = positionals;
  if (!Object.hasOwn(RUNTIME_ARTIFACTS, artifact)) fail(usage());
  materializeHarnessRuntime({
    artifact: artifact as HarnessRuntimeArtifact,
    destination: destination!,
    check,
  });
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  main(process.argv.slice(2));
}
