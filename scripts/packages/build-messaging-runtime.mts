// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { format } from "oxfmt";

import formattingConfig from "../../oxfmt.config.ts";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE = path.join(REPOSITORY_ROOT, "src/lib/messaging/applier/build/runtime-entry.mts");
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
  const result = await build({
    entryPoints: [SOURCE],
    bundle: true,
    treeShaking: true,
    minifySyntax: true,
    define: { "globalThis.NEMOCLAW_PACKAGE_MESSAGING_RUNTIME_BUILD": "true" },
    plugins: [
      {
        name: "package-messaging-credential-cleanup",
        setup(build) {
          build.onResolve({ filter: /^\.\.\/credential-env-cleanup\.ts$/ }, () => ({
            path: path.join(
              REPOSITORY_ROOT,
              "src/lib/messaging/applier/package-credential-cleanup.ts",
            ),
          }));
          build.onResolve({ filter: /^\.\.\/\.\.\/channels\/legacy-manifests\.ts$/ }, () => ({
            path: path.join(REPOSITORY_ROOT, "src/lib/messaging/channels/package-built-ins.ts"),
          }));
        },
      },
    ],
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
      writeFileSync(target, expected, { mode: 0o644 });
      chmodSync(target, 0o644);
      continue;
    }
    if (!readFileSync(target).equals(expected)) {
      throw new Error(`${relativeTarget} is stale; rerun this script with --write`);
    }
    if ((statSync(target).mode & 0o777) !== 0o644) {
      throw new Error(`${relativeTarget} must use mode 0644; rerun this script with --write`);
    }
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  await verifyPackageMessagingRuntime(process.argv.slice(2).includes("--write"));
}
