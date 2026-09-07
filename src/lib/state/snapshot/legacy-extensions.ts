// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import type { HarnessManagedExtension } from "@nvidia/nemoclaw-harness-contract";

import { parseOpenClawImagePluginInstalls } from "../openclaw-plugin-restore.js";

/**
 * Translate the retired OpenClaw registry/snapshot shape into the generic
 * receipt-backed record. New state must never call or persist this format.
 */
export function migrateLegacyOpenClawImagePluginInstalls(
  value: unknown,
  stateRoot: string,
  stateDirectory: string,
): readonly HarnessManagedExtension[] | null {
  const parsed = parseOpenClawImagePluginInstalls(value, stateRoot);
  if (!parsed.ok) return null;
  const extensionRoot = `${stateRoot.replace(/\/+$/u, "")}/${stateDirectory}`;
  return parsed.pluginInstalls.map((install) => {
    const relative = path.posix.relative(extensionRoot, install.installPath);
    const directory =
      relative.length > 0 &&
      !relative.includes("/") &&
      relative !== "." &&
      relative !== ".." &&
      !path.posix.isAbsolute(relative)
        ? relative
        : null;
    return {
      id: install.id,
      directory,
      configPaths: [...(install.loadPaths ?? [])],
    };
  });
}
