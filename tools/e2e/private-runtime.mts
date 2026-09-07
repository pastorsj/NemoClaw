// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../../test/e2e/fixtures/availability-env.ts";

const OPEN_SHELL_COMPONENTS =
  process.platform === "linux"
    ? (["openshell", "openshell-gateway", "openshell-sandbox"] as const)
    : (["openshell", "openshell-gateway"] as const);

export interface PrivateFabricRuntime {
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly home: string;
  readonly stateRoot: string;
  environment(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  removeHome(): void;
}

function executable(candidate: string): string | undefined {
  try {
    const resolved = fs.realpathSync(candidate);
    fs.accessSync(resolved, fs.constants.X_OK);
    return fs.statSync(resolved).isFile() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function resolveExecutable(name: string, source: NodeJS.ProcessEnv): string | undefined {
  const configured = source.OPENSHELL_BIN?.trim() || source.NEMOCLAW_OPENSHELL_BIN?.trim();
  if (name === "openshell" && configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error("Configured OpenShell CLI must use an absolute path for isolated E2E");
    }
    const resolved = executable(configured);
    if (!resolved) throw new Error("Configured OpenShell CLI is not executable");
    return resolved;
  }
  for (const directory of source.PATH?.split(path.delimiter) ?? []) {
    if (!path.isAbsolute(directory)) continue;
    const resolved = executable(path.join(directory, name));
    if (resolved) return resolved;
  }
  return undefined;
}

function resolveDockerHost(source: NodeJS.ProcessEnv): string {
  const explicit = source.DOCKER_HOST?.trim();
  const inspection = explicit
    ? undefined
    : spawnSync("docker", ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"], {
        encoding: "utf8",
        env: buildAvailabilityProbeEnv(source),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5_000,
      });
  let candidate = explicit;
  if (!candidate && inspection?.status === 0) {
    try {
      const parsed: unknown = JSON.parse(inspection.stdout.trim());
      if (typeof parsed === "string") candidate = parsed.trim();
    } catch {
      // The validated error below owns malformed Docker context output.
    }
  }
  if (!candidate?.startsWith("unix:///") || /[\0\r\n]/u.test(candidate)) {
    throw new Error("Standalone Fabric E2E requires an absolute local unix:// Docker endpoint");
  }
  return candidate;
}

function stageOpenShell(home: string, openshell: string): void {
  const directory = path.join(home, ".local", "bin");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const sourceDirectory = path.dirname(openshell);
  for (const component of OPEN_SHELL_COMPONENTS) {
    const sourcePath =
      component === "openshell" ? openshell : executable(path.join(sourceDirectory, component));
    if (sourcePath) fs.symlinkSync(sourcePath, path.join(directory, component));
  }
}

function removePrivateHome(home: string): void {
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(home);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const parent = fs.realpathSync(os.homedir());
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    path.dirname(home) !== parent ||
    fs.realpathSync(home) !== home ||
    !/^\.nemoclaw-[a-z0-9-]+-home-[a-z0-9]{6}$/iu.test(path.basename(home))
  ) {
    throw new Error("Standalone Fabric E2E refused to remove an unowned private HOME");
  }
  fs.rmSync(home, { force: true, recursive: true });
}

/** Create the isolated HOME and gateway authority owned by one exact package journey. */
export function createPrivateFabricRuntime(
  prefix: string,
  source: NodeJS.ProcessEnv = process.env,
): PrivateFabricRuntime {
  const portText = source.NEMOCLAW_GATEWAY_PORT?.trim() ?? "";
  const port = Number(portText);
  if (
    !/^\d+$/u.test(portText) ||
    !Number.isSafeInteger(port) ||
    port < 1024 ||
    port > 65_535 ||
    port === 8080
  ) {
    throw new Error("Standalone Fabric E2E requires an isolated non-default gateway port");
  }
  const gatewayName = `nemoclaw-${portText}`;
  if (source.OPENSHELL_GATEWAY?.trim() !== gatewayName) {
    throw new Error(`Standalone Fabric E2E gateway must be ${gatewayName}`);
  }
  const openshell = resolveExecutable("openshell", source);
  if (!openshell) throw new Error("Standalone Fabric E2E requires the OpenShell CLI on PATH");
  const dockerHost = resolveDockerHost(source);
  const base = buildAvailabilityProbeEnv(source);
  const parent = fs.realpathSync(os.homedir());
  const home = fs.realpathSync(fs.mkdtempSync(path.join(parent, prefix)));
  try {
    fs.chmodSync(home, 0o700);
    const dockerDirectory = path.join(home, ".docker");
    fs.mkdirSync(dockerDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dockerDirectory, "config.json"), "{}\n", { mode: 0o600 });
    stageOpenShell(home, openshell);
    const stateRoot = path.join(home, ".nemoclaw", "gateways", portText);
    return Object.freeze({
      gatewayName,
      gatewayPort: port,
      home,
      stateRoot,
      environment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
        const merged: NodeJS.ProcessEnv = {
          ...base,
          ...extra,
          HOME: home,
          PATH: [path.join(home, ".local", "bin"), path.join(home, ".npm-global", "bin"), base.PATH]
            .filter(Boolean)
            .join(path.delimiter),
          XDG_BIN_HOME: path.join(home, ".local", "bin"),
          XDG_CONFIG_HOME: path.join(home, ".config"),
          XDG_DATA_HOME: path.join(home, ".local", "share"),
          XDG_STATE_HOME: path.join(home, ".local", "state"),
          DOCKER_CONFIG: dockerDirectory,
          DOCKER_HOST: dockerHost,
          NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
          NEMOCLAW_NON_INTERACTIVE: "1",
          NEMOCLAW_SKIP_FORWARD_WATCHER: "1",
          NEMOCLAW_GATEWAY_PORT: portText,
          OPENSHELL_GATEWAY: gatewayName,
        };
        delete merged.DOCKER_CERT_PATH;
        delete merged.DOCKER_CONTEXT;
        delete merged.DOCKER_TLS_VERIFY;
        delete merged.XDG_RUNTIME_DIR;
        delete merged.NEMOCLAW_OPENSHELL_BIN;
        delete merged.OPENSHELL_BIN;
        return merged;
      },
      removeHome: () => removePrivateHome(home),
    });
  } catch (error) {
    removePrivateHome(home);
    throw error;
  }
}
