// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolvePublicNemoClawVersion, type VersionOptions } from "./build-identity";

export {
  getBuildIdentity,
  resolveSourceBuildIdentity,
  validateBuildIdentity,
  type BuildIdentity,
  type VersionOptions,
} from "./build-identity";

/**
 * Resolve the NemoClaw version from (in order):
 *   1. the compiled build identity         — exact running CLI build
 *   2. `git describe --tags --match "v*"` — works in dev / source checkouts
 *   3. `.version` file at repo root        — stamped at publish time
 *   4. `package.json` version              — hard-coded fallback
 */
export function getVersion(opts: VersionOptions = {}): string {
  return resolvePublicNemoClawVersion(opts);
}
