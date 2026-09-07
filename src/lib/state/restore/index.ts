// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** State restore operations consumed by the sandbox backup and restore workflow. */
export { listPackageConfigRestoreManagedChannelNames } from "./managed-channels.js";
export {
  buildManagedExtensionCleanupCommand,
  buildManagedExtensionRestoreTarArgs,
  buildRestoreCleanupCommand,
  buildRestoreTarArgs,
  discoverManagedImageExtensions,
  isAllowedManagedStateSymlink,
  isAllowedStateSymlink,
  migrateLegacyOpenClawImagePluginInstalls,
  parseManagedImageExtensions,
  planManagedExtensionRestore,
} from "../snapshot/extension-operations.js";
