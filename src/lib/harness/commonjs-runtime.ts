// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import vm from "node:vm";

import {
  captureHarnessPackageText,
  type HarnessPackage,
  resolveHarnessPackage,
} from "./package-registry";

export { resolveHarnessPackage };

export type LoadedHarnessCommonJsModule = {
  readonly contentDigest: string;
  readonly exports: unknown;
};

/** Execute receipt-verified package bytes without reopening their mutable pathname. */
export function loadHarnessCommonJsModule(
  harnessPackage: HarnessPackage,
  relativePath: string,
  maxBytes: number,
): LoadedHarnessCommonJsModule {
  const snapshot = captureHarnessPackageText(harnessPackage, relativePath, maxBytes);
  if (snapshot.source === null) {
    throw new Error(`Harness package runtime module is unavailable: ${relativePath}`);
  }

  const modulePath = path.join(harnessPackage.rootDir, ...relativePath.split("/"));
  const moduleRecord: { exports: unknown } = { exports: {} };
  const unsupportedRequire = (specifier: string): never => {
    throw new Error(`Harness package runtime modules must be self-contained: ${specifier}`);
  };
  const execute = vm.compileFunction(
    snapshot.source,
    ["exports", "require", "module", "__filename", "__dirname"],
    { filename: modulePath },
  );
  execute(
    moduleRecord.exports,
    unsupportedRequire,
    moduleRecord,
    modulePath,
    path.dirname(modulePath),
  );
  return Object.freeze({
    contentDigest: snapshot.contentDigest,
    exports: moduleRecord.exports,
  });
}
