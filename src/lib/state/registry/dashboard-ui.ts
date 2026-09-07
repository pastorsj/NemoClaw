// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isObjectRecord } from "../../shared/object-record";

/** Harness-neutral dashboard settings retained for one receipt-backed sandbox. */
export type SandboxDashboardUiState =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly publicPort: number;
      readonly internalPort: number;
      readonly tuiEnabled: boolean;
    };

function isDashboardPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65_535;
}

/** Validate and detach persisted dashboard state before core relies on it. */
export function cloneSandboxDashboardUiState(
  value: unknown,
  operation: "load" | "save",
): SandboxDashboardUiState | undefined {
  if (value === undefined) return undefined;
  if (!isObjectRecord(value) || typeof value.enabled !== "boolean") {
    throw new Error(`Cannot ${operation} a sandbox entry with invalid package dashboard state`);
  }
  const keys = Object.keys(value).sort();
  if (value.enabled === false) {
    if (keys.length !== 1 || keys[0] !== "enabled") {
      throw new Error(`Cannot ${operation} a sandbox entry with invalid package dashboard state`);
    }
    return { enabled: false };
  }
  if (
    keys.join(",") !== "enabled,internalPort,publicPort,tuiEnabled" ||
    !isDashboardPort(value.publicPort) ||
    !isDashboardPort(value.internalPort) ||
    value.publicPort === value.internalPort ||
    typeof value.tuiEnabled !== "boolean"
  ) {
    throw new Error(`Cannot ${operation} a sandbox entry with invalid package dashboard state`);
  }
  return {
    enabled: true,
    publicPort: value.publicPort,
    internalPort: value.internalPort,
    tuiEnabled: value.tuiEnabled,
  };
}

/** Decode transitional receipt rows without using their package identity. */
export function migrateLegacyDashboardUiState(value: {
  readonly hermesDashboardEnabled?: unknown;
  readonly hermesDashboardPort?: unknown;
  readonly hermesDashboardInternalPort?: unknown;
  readonly hermesDashboardTui?: unknown;
}): SandboxDashboardUiState | undefined {
  if (value.hermesDashboardEnabled === undefined) return undefined;
  if (value.hermesDashboardEnabled !== true) return { enabled: false };
  try {
    return cloneSandboxDashboardUiState(
      {
        enabled: true,
        publicPort: value.hermesDashboardPort,
        internalPort: value.hermesDashboardInternalPort,
        tuiEnabled: value.hermesDashboardTui ?? false,
      },
      "load",
    );
  } catch {
    throw new Error("Cannot migrate invalid legacy dashboard state");
  }
}
