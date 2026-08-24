// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  loadHarnessCommonJsModule,
  resolveHarnessPackage,
} from "../harness/commonjs-runtime";
import { listOpenClawManagedChannelNames } from "../messaging/channels/index";
import type { OpenClawImagePluginInstall } from "./openclaw-plugin-restore";

export interface OpenClawConfigMergeOptions {
  freshImagePluginInstalls?: readonly OpenClawImagePluginInstall[];
  previousImagePluginInstalls?: readonly OpenClawImagePluginInstall[];
}

type OpenClawConfigRestoreOwnership = {
  readonly runtimeSections: readonly string[];
  readonly managedChannels: readonly string[];
  readonly currentGeneratedEntryMaps: readonly string[];
  readonly managedWebSearchPluginEntries: readonly string[];
  readonly managedWebSearchConfigPaths: readonly string[];
  readonly providerRuntimeOwnedFields: readonly string[];
  readonly modelRuntimeOwnedFields: readonly string[];
  readonly backupDurableSections: readonly string[];
  readonly agentPrimaryModelPath: readonly string[];
  readonly currentGeneratedToolFields: readonly string[];
};

type RuntimeModule = {
  configRestoreOwnership(managedChannelNames: readonly string[]): OpenClawConfigRestoreOwnership;
  mergeOpenClawRestoredConfig(
    backedUpConfig: unknown,
    currentConfig: unknown,
    options: OpenClawConfigMergeOptions,
    managedChannelNames: readonly string[],
  ): unknown;
};

let cachedRuntime: {
  selectionKey: string;
  packageRoot: string;
  module: RuntimeModule;
} | null = null;

function loadOpenClawConfigRestoreModule(): RuntimeModule {
  const selectionKey = process.env.HOME?.trim() || "<default-home>";
  // A command captures verified helper bytes once. Harness installation takes effect in the next process.
  if (cachedRuntime?.selectionKey === selectionKey) return cachedRuntime.module;
  const harnessPackage = resolveHarnessPackage("openclaw");
  if (!harnessPackage) throw new Error("OpenClaw harness package is unavailable.");
  const loaded = loadHarnessCommonJsModule(
    harnessPackage,
    "host/config-restore.cts",
    256 * 1024,
  );
  const runtime = loaded.exports as Partial<RuntimeModule>;
  if (
    typeof runtime.configRestoreOwnership !== "function" ||
    typeof runtime.mergeOpenClawRestoredConfig !== "function"
  ) {
    throw new Error("OpenClaw harness config-restore module has an invalid contract.");
  }
  cachedRuntime = {
    selectionKey,
    packageRoot: harnessPackage.rootDir,
    module: runtime as RuntimeModule,
  };
  return cachedRuntime.module;
}

export function mergeOpenClawRestoredConfig(
  backedUpConfig: unknown,
  currentConfig: unknown,
  options: OpenClawConfigMergeOptions = {},
): unknown {
  return loadOpenClawConfigRestoreModule().mergeOpenClawRestoredConfig(
    backedUpConfig,
    currentConfig,
    options,
    listOpenClawManagedChannelNames(),
  );
}
