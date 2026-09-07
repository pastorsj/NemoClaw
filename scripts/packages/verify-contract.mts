#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONTRACT_NAME = "@nvidia/nemoclaw-harness-contract";
const PACKAGE_JSON_MAX_BYTES = 64 * 1024;
const REQUIRED_BINARIES = new Map([
  ["nemoclaw-build-adapters", "dist/build-adapters.mjs"],
  ["nemoclaw-build-package", "dist/build-package.mjs"],
  ["nemoclaw-materialize-runtime", "dist/materialize-runtime.mjs"],
  ["nemoclaw-validate-package", "dist/validate-package.mjs"],
] as const);

function fail(message: string): never {
  throw new Error(`Installed harness contract is not self-contained: ${message}`);
}

function requireRegularDirectory(directory: string): void {
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(directory);
  } catch {
    fail(`missing ${CONTRACT_NAME}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail(`${CONTRACT_NAME} must be a regular installed directory`);
  }
}

function readPackageMetadata(contractRoot: string): Record<string, unknown> {
  const packagePath = path.join(contractRoot, "package.json");
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(packagePath);
  } catch {
    fail("missing package.json");
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size < 1 ||
    metadata.size > PACKAGE_JSON_MAX_BYTES
  ) {
    fail("package.json must be a bounded regular file");
  }
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  } catch {
    fail("package.json is invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("package.json is invalid");
  }
  return value as Record<string, unknown>;
}

/** Reject a monorepo link that only appears installable inside its original checkout. */
export function verifyInstalledHarnessContract(packageRoot: string): void {
  const root = path.resolve(packageRoot);
  requireRegularDirectory(root);
  const rootRealPath = fs.realpathSync.native(root);
  const contractRoot = path.join(root, "node_modules", "@nvidia", "nemoclaw-harness-contract");
  requireRegularDirectory(contractRoot);
  const contractRealPath = fs.realpathSync.native(contractRoot);
  if (
    contractRealPath !==
    path.join(rootRealPath, "node_modules", "@nvidia", "nemoclaw-harness-contract")
  ) {
    fail(`${CONTRACT_NAME} must not traverse a linked parent directory`);
  }
  const metadata = readPackageMetadata(contractRoot);
  if (metadata.name !== CONTRACT_NAME || !metadata.bin || typeof metadata.bin !== "object") {
    fail("package identity or binary map is invalid");
  }
  const binaries = metadata.bin as Record<string, unknown>;
  for (const [name, expectedTarget] of REQUIRED_BINARIES) {
    const declaredTarget = binaries[name];
    if (
      typeof declaredTarget !== "string" ||
      declaredTarget.replace(/^\.\//u, "") !== expectedTarget
    ) {
      fail(`binary '${name}' is missing or has an unexpected target`);
    }
    const target = path.join(contractRoot, ...expectedTarget.split("/"));
    let targetMetadata: fs.Stats;
    try {
      targetMetadata = fs.lstatSync(target);
    } catch {
      fail(`binary '${name}' is missing`);
    }
    if (
      targetMetadata.isSymbolicLink() ||
      !targetMetadata.isFile() ||
      (targetMetadata.mode & 0o111) === 0
    ) {
      fail(`binary '${name}' must resolve inside the installed package`);
    }
    if (fs.realpathSync.native(target) !== path.join(contractRealPath, expectedTarget)) {
      fail(`binary '${name}' must not traverse a linked directory`);
    }
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const packageRoot = process.argv[2];
  if (!packageRoot || process.argv.length !== 3) {
    throw new Error("Usage: verify-contract.mts <package-root>");
  }
  verifyInstalledHarnessContract(packageRoot);
}
