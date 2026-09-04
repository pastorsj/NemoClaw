// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  loadHarnessConfigAdapterHostModule,
  type HarnessConfigAdapterHostModule,
  type HarnessConfigTarget,
} from "../agent-runtime/config-module";
import type { HarnessPackageIdentity } from "../agent-runtime/package/types";
import { getAgentConfigPackageIdentity, type AgentConfigTarget } from "./agent-config";

export function toHarnessConfigTarget(target: AgentConfigTarget): HarnessConfigTarget {
  return Object.freeze({
    directory: target.configDir,
    file: target.configFile,
    format: target.format,
    sensitiveFiles: Object.freeze([...(target.sensitiveFiles ?? [])]),
  });
}

export interface InstalledConfigAdapterSelection {
  readonly identity: HarnessPackageIdentity;
  readonly adapter: HarnessConfigAdapterHostModule;
}

/** Resolve package configuration behavior only from the sandbox's exact receipt. */
export function loadInstalledConfigAdapter(
  sandboxName: string,
  target: AgentConfigTarget,
): InstalledConfigAdapterSelection | null {
  const identity = getAgentConfigPackageIdentity(sandboxName);
  if (!identity) return null;
  if (identity.id !== target.agentName) {
    throw new Error(
      `Installed configuration adapter for sandbox '${sandboxName}' does not match its package agent`,
    );
  }
  return Object.freeze({
    identity,
    adapter: loadHarnessConfigAdapterHostModule(identity),
  });
}
