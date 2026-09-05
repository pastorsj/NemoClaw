// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import path from "node:path";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const HOST_MODULE_NAME = /^[a-z][a-z0-9-]*\.cts$/u;
const requireForTest = createRequire(import.meta.url);

/** Load one self-contained package host module through its CommonJS boundary. */
export function loadPackageHostModule<Module>(fileName: string): Module {
  if (!HOST_MODULE_NAME.test(fileName)) {
    throw new Error(`Invalid package host module name: ${fileName}`);
  }
  return requireForTest(path.join(PACKAGE_ROOT, "host", fileName)) as Module;
}
