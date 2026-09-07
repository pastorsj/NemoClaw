// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Snapshot-facing extension operations, grouped behind one state-lifecycle boundary. */
export {
  buildRestoreCleanupCommand,
  buildRestoreTarArgs,
  isAllowedStateSymlink,
} from "../openclaw-managed-extensions.js";
export {
  buildManagedExtensionCleanupCommand,
  buildManagedExtensionRestoreTarArgs,
  discoverManagedImageExtensions,
  isAllowedManagedStateSymlink,
  parseManagedImageExtensions,
  planManagedExtensionRestore,
} from "./managed-extensions.js";
export { migrateLegacyOpenClawImagePluginInstalls } from "./legacy-extensions.js";
