#!/usr/bin/env -S npx tsx
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import path from "node:path";

const requireSource = createRequire(import.meta.url);
const {
  harnessPackageContentDigest,
  HarnessPackageReceiptMismatchError,
  verifyHarnessPackageInstallReceipt,
} = requireSource(
  "../../src/lib/harness/package-registry.ts",
) as typeof import("../../src/lib/harness/package-registry");

const verifyReceipt = process.argv[2] === "--verify-receipt";
const packageRoot = process.argv[verifyReceipt ? 3 : 2];
if (!packageRoot) {
  console.error("Usage: harness-package-digest.mts [--verify-receipt] <package-root>");
  process.exit(2);
}

try {
  const resolvedRoot = path.resolve(packageRoot);
  console.log(
    verifyReceipt
      ? verifyHarnessPackageInstallReceipt(resolvedRoot)
      : harnessPackageContentDigest(resolvedRoot),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(error instanceof HarnessPackageReceiptMismatchError ? 3 : 1);
}
