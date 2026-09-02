// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HermesFabricConfig } from "./fabric-config.ts";
import type { HermesManagedPolicyV1 } from "./managed-policy.ts";
import { buildHermesUpstreamHeader } from "./upstream-header.ts";
import { toYaml } from "./yaml.ts";

export type WrittenHermesConfig = {
  configPath: string;
  envPath: string;
  envEntryCount: number;
  policyPath: string;
  fabricPath: string;
};

export function writeHermesConfigFiles(
  config: Record<string, unknown>,
  envLines: string[],
  policy: HermesManagedPolicyV1,
  fabricConfig: HermesFabricConfig,
  homeDir: string = homedir(),
): WrittenHermesConfig {
  const configPath = join(homeDir, ".hermes", "config.yaml");
  writeFileSync(configPath, `${buildHermesUpstreamHeader(config)}${toYaml(config)}`);
  chmodSync(configPath, 0o600);

  const envPath = join(homeDir, ".hermes", ".env");
  writeFileSync(envPath, envLines.length > 0 ? `${envLines.join("\n")}\n` : "");
  chmodSync(envPath, 0o600);

  const policyPath = join(homeDir, ".hermes", "managed-policy.json");
  writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
  chmodSync(policyPath, 0o600);

  const fabricPath = join(homeDir, ".hermes", "fabric.json");
  writeFileSync(fabricPath, `${JSON.stringify(fabricConfig, null, 2)}\n`);
  chmodSync(fabricPath, 0o600);

  return {
    configPath,
    envPath,
    envEntryCount: envLines.length,
    policyPath,
    fabricPath,
  };
}
