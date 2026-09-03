// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isSupportedGatewayDockerHost } from "../../../src/lib/domain/docker-host.ts";
import { DEFAULT_GATEWAY_PORT } from "../../../src/lib/core/ports.ts";
import { resolveGatewayName } from "../../../src/lib/onboard/gateway-binding.ts";
import { nemoclawStateRoot } from "../../../src/lib/state/state-root.ts";
import { buildAvailabilityProbeEnv } from "./availability-env.ts";

const DOCKER_CONTEXT_HOST_FORMAT = "{{json .Endpoints.docker.Host}}";
const ISOLATED_HOME_DOCKER_SELECTORS = [
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_TLS_VERIFY",
] as const;

const HOST_OPEN_SHELL_BINARY_SELECTORS = ["NEMOCLAW_OPENSHELL_BIN", "OPENSHELL_BIN"] as const;
const OPEN_SHELL_COMPONENTS =
  process.platform === "linux"
    ? (["openshell", "openshell-gateway", "openshell-sandbox"] as const)
    : (["openshell", "openshell-gateway"] as const);

export interface TestGatewayBinding {
  readonly environment: NodeJS.ProcessEnv;
  readonly name: string;
}

export interface IsolatedTestRuntime {
  readonly gatewayEnvironment: NodeJS.ProcessEnv;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly home: string;
  readonly stateRoot: string;
  environment(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
}

/** Bind one test process to the canonical gateway selected by its port. */
export function resolveTestGatewayBinding(
  source: NodeJS.ProcessEnv = process.env,
): TestGatewayBinding {
  const rawPort = source.NEMOCLAW_GATEWAY_PORT?.trim();
  if (!rawPort) {
    const name = source.OPENSHELL_GATEWAY?.trim() || resolveGatewayName(DEFAULT_GATEWAY_PORT);
    return { environment: { OPENSHELL_GATEWAY: name }, name };
  }

  const port = Number(rawPort);
  if (!/^[0-9]+$/u.test(rawPort) || !Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new Error("NEMOCLAW_GATEWAY_PORT must be an integer between 1024 and 65535");
  }
  const name = resolveGatewayName(port);
  const requestedName = source.OPENSHELL_GATEWAY?.trim();
  if (requestedName && requestedName !== name) {
    throw new Error(`OPENSHELL_GATEWAY must be ${name} when NEMOCLAW_GATEWAY_PORT=${rawPort}`);
  }
  return {
    environment: { NEMOCLAW_GATEWAY_PORT: rawPort, OPENSHELL_GATEWAY: name },
    name,
  };
}

/** Require a standalone per-port gateway so a live test cannot mutate the host default. */
export function requireIsolatedTestGateway(
  source: NodeJS.ProcessEnv = process.env,
): TestGatewayBinding {
  const rawPort = source.NEMOCLAW_GATEWAY_PORT?.trim();
  if (!rawPort || Number(rawPort) === DEFAULT_GATEWAY_PORT) {
    throw new Error("This live E2E target requires a non-default NEMOCLAW_GATEWAY_PORT");
  }
  return resolveTestGatewayBinding(source);
}

export interface DockerContextInspection {
  readonly status: number | null;
  readonly stdout: string;
  readonly error?: Error;
}

export type DockerContextInspector = (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => DockerContextInspection;

function inspectDockerContext(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): DockerContextInspection {
  const result = spawnSync("docker", [...args], {
    encoding: "utf8",
    env,
    killSignal: "SIGKILL",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
}

/** Resolve only the local daemon endpoint needed after HOME is isolated. */
export function resolveIsolatedHomeDockerHost(
  source: NodeJS.ProcessEnv = process.env,
  inspect: DockerContextInspector = inspectDockerContext,
): string {
  const explicitDockerHost = source.DOCKER_HOST;
  if (explicitDockerHost?.trim()) {
    if (!isSupportedGatewayDockerHost(explicitDockerHost)) {
      throw new Error("Isolated E2E HOME requires an absolute local unix:// Docker endpoint");
    }
    return explicitDockerHost.trim();
  }

  const inspection = inspect(
    ["context", "inspect", "--format", DOCKER_CONTEXT_HOST_FORMAT],
    buildAvailabilityProbeEnv(source),
  );
  if (inspection.error || inspection.status !== 0) {
    throw new Error("Could not resolve the active Docker context before isolating E2E HOME");
  }

  let contextDockerHost: unknown;
  try {
    contextDockerHost = JSON.parse(inspection.stdout.trim());
  } catch {
    throw new Error("The active Docker context endpoint is unreadable");
  }
  if (
    typeof contextDockerHost !== "string" ||
    !contextDockerHost.trim() ||
    !isSupportedGatewayDockerHost(contextDockerHost)
  ) {
    throw new Error("Isolated E2E HOME requires an absolute local unix:// Docker endpoint");
  }
  return contextDockerHost.trim();
}

function withDefaults(
  base: NodeJS.ProcessEnv,
  extra: NodeJS.ProcessEnv,
  gateway: string | undefined,
): NodeJS.ProcessEnv {
  return {
    ...base,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    OPENSHELL_GATEWAY: gateway ?? "nemoclaw",
    ...extra,
  };
}

function withInstalledCliPath(base: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const entries = [
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    ...(base.PATH?.split(path.delimiter) ?? []),
  ];
  return {
    ...base,
    HOME: home,
    PATH: [...new Set(entries.filter(Boolean))].join(path.delimiter),
  };
}

export function commandEnvironment(
  extra: NodeJS.ProcessEnv = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return withDefaults(buildAvailabilityProbeEnv(source), extra, source.OPENSHELL_GATEWAY);
}

export function installedCommandEnvironment(
  extra: NodeJS.ProcessEnv = {},
  home = os.homedir(),
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const base = buildAvailabilityProbeEnv({ ...source, HOME: home });
  return withDefaults(withInstalledCliPath(base, home), extra, source.OPENSHELL_GATEWAY);
}

export function testHomeEnvironment(
  home: string,
  extra: NodeJS.ProcessEnv = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return installedCommandEnvironment(extra, home, source);
}

function executableFile(candidate: string): string | null {
  try {
    const canonicalPath = fs.realpathSync(candidate);
    if (!fs.statSync(canonicalPath).isFile()) return null;
    fs.accessSync(canonicalPath, fs.constants.X_OK);
    return canonicalPath;
  } catch {
    return null;
  }
}

function resolveHostOpenShellBinary(source: NodeJS.ProcessEnv): string {
  for (const selector of HOST_OPEN_SHELL_BINARY_SELECTORS) {
    const configured = source[selector]?.trim();
    if (!configured) continue;
    if (!path.isAbsolute(configured)) {
      throw new Error(`${selector} must be an absolute executable path before isolating E2E state`);
    }
    const executable = executableFile(configured);
    if (!executable) {
      throw new Error(
        `${selector} must identify an executable OpenShell CLI before isolating E2E state`,
      );
    }
    return executable;
  }

  for (const directory of source.PATH?.split(path.delimiter) ?? []) {
    if (!path.isAbsolute(directory)) continue;
    const executable = executableFile(path.join(directory, "openshell"));
    if (executable) return executable;
  }
  throw new Error("Could not resolve an absolute executable OpenShell CLI from the host PATH");
}

/** Put the validated host components at private paths that an in-run repair replaces. */
function stageHostOpenShellFallback(home: string, source: NodeJS.ProcessEnv): void {
  const sourceHome = source.HOME;
  if (!sourceHome || !path.isAbsolute(sourceHome)) {
    throw new Error("An absolute host HOME is required before isolating NemoClaw E2E state");
  }
  const hostOpenShellBinary = resolveHostOpenShellBinary(source);
  if (!fs.existsSync(home)) return;
  const privateBinDirectory = path.join(home, ".local", "bin");
  const hostBinDirectory = path.dirname(hostOpenShellBinary);
  fs.mkdirSync(privateBinDirectory, { mode: 0o700, recursive: true });
  for (const component of OPEN_SHELL_COMPONENTS) {
    const privateComponent = path.join(privateBinDirectory, component);
    if (fs.existsSync(privateComponent)) {
      if (!executableFile(privateComponent)) {
        throw new Error(
          `The private OpenShell ${component} path must remain executable during E2E isolation`,
        );
      }
      continue;
    }
    const hostComponent =
      component === "openshell"
        ? hostOpenShellBinary
        : executableFile(path.join(hostBinDirectory, component));
    if (hostComponent) fs.symlinkSync(hostComponent, privateComponent);
  }
}

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
function createPrivateDockerCliConfig(home: string, source: NodeJS.ProcessEnv): string {
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

/**
 * Isolate NemoClaw and OpenShell state while retaining the reviewed host
 * OpenShell CLI as a replaceable private-path fallback. Preserve local Docker
 * access without exposing the account's Docker config or active gateway.
 */
export function isolatedNemoClawEnvironment(
  home: string,
  extra: NodeJS.ProcessEnv = {},
  source: NodeJS.ProcessEnv = process.env,
  inspect: DockerContextInspector = inspectDockerContext,
): NodeJS.ProcessEnv {
  const dockerHost = resolveIsolatedHomeDockerHost(source, inspect);
  const environment = testHomeEnvironment(home, extra, source);
  for (const selector of ISOLATED_HOME_DOCKER_SELECTORS) delete environment[selector];
  stageHostOpenShellFallback(home, source);
  for (const selector of HOST_OPEN_SHELL_BINARY_SELECTORS) delete environment[selector];
  environment.HOME = home;
  environment.PATH = withInstalledCliPath(environment, home).PATH;
  environment.XDG_BIN_HOME = path.join(home, ".local", "bin");
  environment.XDG_CONFIG_HOME = path.join(home, ".config");
  environment.XDG_DATA_HOME = path.join(home, ".local", "share");
  environment.XDG_STATE_HOME = path.join(home, ".local", "state");
  delete environment.XDG_RUNTIME_DIR;
  environment.DOCKER_CONFIG = path.join(home, ".docker");
  environment.DOCKER_HOST = dockerHost;
  // Isolated E2E homes are removed at teardown. Do not detach the Hermes
  // forward recovery watcher with its script and PID state rooted in that home.
  environment.NEMOCLAW_SKIP_FORWARD_WATCHER = "1";
  return environment;
}

/**
 * Create an isolated HOME beneath the caller's real home directory.
 *
 * NemoClaw rejects package stores reached through symlinks or writable
 * ancestors. System temporary directories do not meet that contract: macOS
 * aliases them through /var, while Linux normally exposes /tmp as 01777.
 */
export function createPrivateTestHome(
  prefix: string,
  parentHome: string = os.homedir(),
  source: NodeJS.ProcessEnv = process.env,
): string {
  const canonicalParent = fs.realpathSync(parentHome);
  const testHome = fs.mkdtempSync(path.join(canonicalParent, prefix));
  fs.chmodSync(testHome, 0o700);
  const canonicalHome = fs.realpathSync(testHome);
  createPrivateDockerCliConfig(canonicalHome, source);
  return canonicalHome;
}

/** Create the private home and per-port authority shared by one live test. */
export function createIsolatedTestRuntime(prefix: string): IsolatedTestRuntime {
  const gateway = requireIsolatedTestGateway();
  const gatewayPort = Number(gateway.environment.NEMOCLAW_GATEWAY_PORT);
  const home = createPrivateTestHome(prefix);
  return {
    gatewayEnvironment: gateway.environment,
    gatewayName: gateway.name,
    gatewayPort,
    home,
    stateRoot: nemoclawStateRoot(home, gatewayPort),
    environment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
      return isolatedNemoClawEnvironment(home, { ...extra, ...gateway.environment });
    },
  };
}

export function sandboxCommandEnvironment(
  sandboxName: string,
  extra: NodeJS.ProcessEnv = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return commandEnvironment(
    {
      NEMOCLAW_RECREATE_SANDBOX: "1",
      NEMOCLAW_SANDBOX_NAME: sandboxName,
      ...extra,
    },
    source,
  );
}
