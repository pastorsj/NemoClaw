// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildSync } from "esbuild";
import { format } from "oxfmt";

import formattingConfig from "../../oxfmt.config.ts";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE = path.join(
  REPOSITORY_ROOT,
  "src/lib/messaging/applier/build/messaging-build-applier.mts",
);
const TARGETS = [
  "harness-contract/runtime/messaging-build.mts",
  "packages/nemoclaw-openclaw/messaging/messaging-build.mts",
  "packages/nemoclaw-hermes/messaging/messaging-build.mts",
] as const;
const BANNER = [
  "// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.",
  "// SPDX-License-Identifier: Apache-2.0",
  "// Generated from the generic NemoClaw messaging build contract; do not edit by hand.",
].join("\n");

export async function buildPackageMessagingRuntime(): Promise<Buffer> {
  const result = buildSync({
    entryPoints: [SOURCE],
    bundle: true,
    treeShaking: false,
    platform: "node",
    format: "esm",
    target: "node22",
    legalComments: "inline",
    banner: { js: BANNER },
    write: false,
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error("Messaging runtime build produced no output");
  const { ignorePatterns: _ignorePatterns, ...formatOptions } = formattingConfig;
  const formatted = await format(
    "messaging-build.mts",
    Buffer.from(output.contents).toString("utf8"),
    formatOptions,
  );
  if (formatted.errors.length > 0) {
    throw new Error(`Messaging runtime formatting failed: ${JSON.stringify(formatted.errors)}`);
  }
  return Buffer.from(formatted.code);
}

export async function verifyPackageMessagingRuntime(write: boolean): Promise<void> {
  const expected = await buildPackageMessagingRuntime();
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
  await verifyPackageMessagingRuntime(process.argv.slice(2).includes("--write"));
}
