// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE = path.join(REPOSITORY_ROOT, "harness-contract/runtime/gateway-runtime.py");
const TARGETS = [
  "packages/nemoclaw-openclaw/runtime/managed-gateway-control.py",
  "packages/nemoclaw-hermes/runtime/managed-gateway-control.py",
] as const;

export function buildManagedGatewayRuntime(): Buffer {
  const source = readFileSync(SOURCE, "utf8");
  const licenseLine = "# SPDX-License-Identifier: Apache-2.0\n";
  if (!source.includes(licenseLine)) throw new Error("Managed gateway runtime has no SPDX header");
  return Buffer.from(source);
}

export function verifyManagedGatewayRuntime(write: boolean): void {
  const expected = buildManagedGatewayRuntime();
  for (const relativeTarget of TARGETS) {
    const target = path.join(REPOSITORY_ROOT, relativeTarget);
    if (write) {
      writeFileSync(target, expected, { mode: 0o755 });
      continue;
    }
    if (!readFileSync(target).equals(expected)) {
      throw new Error(`${relativeTarget} is stale; rerun this script with --write`);
    }
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  verifyManagedGatewayRuntime(process.argv.slice(2).includes("--write"));
}
