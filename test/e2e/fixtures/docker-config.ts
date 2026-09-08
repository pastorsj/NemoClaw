// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

/** Read only executable plugin locations from the host Docker CLI config. */
function hostDockerCliPluginDirectories(source: NodeJS.ProcessEnv): string[] {
  const sourceHome = source.HOME;
  const configuredDirectory = source.DOCKER_CONFIG?.trim();
  if (configuredDirectory && !path.isAbsolute(configuredDirectory)) {
    throw new Error("DOCKER_CONFIG must be absolute before isolating NemoClaw E2E state");
  }
  if (!configuredDirectory && (!sourceHome || !path.isAbsolute(sourceHome))) {
    throw new Error("An absolute host HOME is required before isolating Docker CLI plugins");
  }

  const configDirectory = configuredDirectory ?? path.join(sourceHome as string, ".docker");
  const configPath = path.join(configDirectory, "config.json");
  if (!fs.existsSync(configPath)) return [];

  let config: unknown;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    throw new Error("The host Docker CLI config is not valid JSON");
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("The host Docker CLI config must be a JSON object");
  }
  const configuredPlugins = (config as Record<string, unknown>).cliPluginsExtraDirs;
  if (configuredPlugins === undefined) return [];
  if (!Array.isArray(configuredPlugins)) {
    throw new Error("Docker cliPluginsExtraDirs must be an array of absolute directories");
  }

  const pluginDirectories = configuredPlugins.map((directory: unknown) => {
    if (
      typeof directory !== "string" ||
      !directory ||
      !path.isAbsolute(directory) ||
      /[\0\r\n]/u.test(directory)
    ) {
      throw new Error("Docker cliPluginsExtraDirs must contain only absolute local directories");
    }
    const canonicalDirectory = fs.realpathSync(directory);
    if (!fs.statSync(canonicalDirectory).isDirectory()) {
      throw new Error("Docker cliPluginsExtraDirs must contain only directories");
    }
    return canonicalDirectory;
  });
  return [...new Set(pluginDirectories)];
}

/** Create a credential-free Docker CLI config for one private E2E home. */
export function createPrivateDockerCliConfig(home: string, source: NodeJS.ProcessEnv): string {
  const dockerConfigDirectory = path.join(home, ".docker");
  fs.mkdirSync(dockerConfigDirectory, { mode: 0o700, recursive: true });
  fs.chmodSync(dockerConfigDirectory, 0o700);
  const cliPluginsExtraDirs = hostDockerCliPluginDirectories(source);
  const privateConfig = cliPluginsExtraDirs.length > 0 ? { cliPluginsExtraDirs } : {};
  const configPath = path.join(dockerConfigDirectory, "config.json");
  fs.writeFileSync(configPath, `${JSON.stringify(privateConfig, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.chmodSync(configPath, 0o600);
  return dockerConfigDirectory;
}
