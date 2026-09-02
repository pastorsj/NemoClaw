// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_GATEWAY_PORT } from "../../../src/lib/core/ports.ts";
import { resolveGatewayName } from "../../../src/lib/onboard/gateway-binding.ts";
import type { CleanupRegistry } from "./cleanup.ts";
import { resultText } from "./clients/command.ts";
import type { HostCliClient } from "./clients/host.ts";
import { REPO_ROOT } from "./paths.ts";
import type { ShellProbeResult, ShellProbeRunOptions } from "./shell-probe.ts";

const GATEWAY_CLEANUP_MODULE = path.join(REPO_ROOT, "dist/lib/actions/sandbox/destroy-gateway.js");
const OPENSHELL_RUNTIME_MODULE = path.join(REPO_ROOT, "dist/lib/adapters/openshell/runtime.js");
const DEFAULT_GATEWAY_CLEANUP_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_PORT_RELEASE_TIMEOUT_MS = 30_000;

// Reuse NemoClaw's ownership-aware gateway cleanup, but defer registration
// removal until the fixture has independently proved that the exact listener
// port is free. This keeps the registration and private state available when
// process ownership cannot be established or the listener survives cleanup.
const OWNED_GATEWAY_CLEANUP_SCRIPT = String.raw`
const cleanupModule = require(process.argv[1]);
const openshellRuntime = require(process.argv[2]);
const gatewayName = process.argv[3];
const keepRegistration = (args, options) => {
  if (args[0] === "gateway" && (args[1] === "remove" || args[1] === "destroy")) {
    return { status: 0, stdout: "", stderr: "" };
  }
  return openshellRuntime.runOpenshell(args, options);
};
cleanupModule.cleanupGatewayAfterLastSandbox(gatewayName, keepRegistration);
`;

const PORT_RELEASE_PROBE_SCRIPT = String.raw`
const net = require("node:net");
const port = Number(process.argv[1]);
const deadline = Date.now() + Number(process.argv[2]);
const attempt = () => {
  const server = net.createServer();
  server.once("error", (error) => {
    if (error.code !== "EADDRINUSE" || Date.now() >= deadline) {
      console.error(error.code || error.message || "bind failed");
      process.exit(1);
    }
    setTimeout(attempt, 500);
  });
  server.listen(port, "127.0.0.1", () => {
    server.close((error) => {
      if (error) {
        console.error(error.message);
        process.exit(1);
      }
      console.log("available");
    });
  });
};
attempt();
`;

type IsolatedGatewayCleanupHost = Pick<HostCliClient, "cleanupGatewayRegistration" | "command">;

export interface IsolatedGatewayCleanupOptions {
  artifactName: string;
  environment: NodeJS.ProcessEnv;
  gatewayName: string;
  gatewayPort: number;
  home: string;
  portReleaseTimeoutMs?: number;
  redactionValues?: string[];
  timeoutMs?: number;
}

function validateIsolatedGatewayCleanup(options: IsolatedGatewayCleanupOptions): void {
  if (
    !Number.isSafeInteger(options.gatewayPort) ||
    options.gatewayPort < 1024 ||
    options.gatewayPort > 65_535 ||
    options.gatewayPort === DEFAULT_GATEWAY_PORT
  ) {
    throw new Error("Isolated gateway cleanup requires a non-default port from 1024 to 65535");
  }

  const expectedGatewayName = resolveGatewayName(options.gatewayPort);
  if (options.gatewayName !== expectedGatewayName) {
    throw new Error(
      `Isolated gateway cleanup requires canonical gateway '${expectedGatewayName}' for port ${String(options.gatewayPort)}`,
    );
  }

  if (options.environment.NEMOCLAW_GATEWAY_PORT?.trim() !== String(options.gatewayPort)) {
    throw new Error("Isolated gateway cleanup environment must select the exact gateway port");
  }
  if (options.environment.OPENSHELL_GATEWAY?.trim() !== options.gatewayName) {
    throw new Error("Isolated gateway cleanup environment must select the exact gateway name");
  }

  const resolvedHome = path.resolve(options.home);
  const privateHomeName = path.basename(resolvedHome);
  let canonicalHome: string;
  let canonicalParentHome: string;
  try {
    canonicalHome = fs.realpathSync(resolvedHome);
    canonicalParentHome = fs.realpathSync(os.homedir());
  } catch {
    throw new Error("Isolated gateway cleanup requires an existing private test HOME");
  }
  if (
    !path.isAbsolute(options.home) ||
    resolvedHome === path.parse(resolvedHome).root ||
    !/^\.nemoclaw-[a-z0-9-]+-home-[a-z0-9]{6}$/iu.test(privateHomeName) ||
    canonicalHome !== resolvedHome ||
    path.dirname(canonicalHome) !== canonicalParentHome ||
    !options.environment.HOME ||
    path.resolve(options.environment.HOME) !== resolvedHome
  ) {
    throw new Error(
      "Isolated gateway cleanup requires the exact private .nemoclaw-*-home-* directory created beneath the user's HOME",
    );
  }
}

function requireSuccessfulCleanupCommand(
  result: ShellProbeResult,
  description: string,
  home: string,
): void {
  if (result.exitCode === 0) return;
  throw new Error(
    `${description} failed; gateway registration and private HOME '${home}' were preserved: ${resultText(result)}`,
  );
}

/** Release one test-owned standalone gateway, then remove its registration and private HOME. */
export async function cleanupIsolatedGateway(
  host: IsolatedGatewayCleanupHost,
  options: IsolatedGatewayCleanupOptions,
): Promise<void> {
  validateIsolatedGatewayCleanup(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_GATEWAY_CLEANUP_TIMEOUT_MS;
  const portReleaseTimeoutMs = options.portReleaseTimeoutMs ?? DEFAULT_PORT_RELEASE_TIMEOUT_MS;
  const sharedCommandOptions: ShellProbeRunOptions = {
    env: options.environment,
    redactionValues: options.redactionValues,
  };

  const runtimeCleanup = await host.command(
    process.execPath,
    [
      "-e",
      OWNED_GATEWAY_CLEANUP_SCRIPT,
      GATEWAY_CLEANUP_MODULE,
      OPENSHELL_RUNTIME_MODULE,
      options.gatewayName,
    ],
    {
      ...sharedCommandOptions,
      artifactName: `${options.artifactName}-runtime`,
      timeoutMs,
    },
  );
  requireSuccessfulCleanupCommand(
    runtimeCleanup,
    `Owned gateway runtime cleanup for '${options.gatewayName}'`,
    options.home,
  );

  const portProbe = await host.command(
    process.execPath,
    ["-e", PORT_RELEASE_PROBE_SCRIPT, String(options.gatewayPort), String(portReleaseTimeoutMs)],
    {
      ...sharedCommandOptions,
      artifactName: `${options.artifactName}-port-release`,
      timeoutMs: portReleaseTimeoutMs + 10_000,
    },
  );
  requireSuccessfulCleanupCommand(
    portProbe,
    `Gateway port ${String(options.gatewayPort)} release proof`,
    options.home,
  );

  try {
    await host.cleanupGatewayRegistration(options.gatewayName, {
      ...sharedCommandOptions,
      artifactName: `${options.artifactName}-registration`,
      timeoutMs,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Gateway registration cleanup for '${options.gatewayName}' failed; private HOME '${options.home}' was preserved: ${detail}`,
    );
  }

  fs.rmSync(options.home, { force: true, recursive: true });
}

/** Register teardown only for an isolated gateway and the private HOME that owns its state. */
export function trackIsolatedGatewayCleanup(
  cleanup: Pick<CleanupRegistry, "trackDisposable">,
  host: IsolatedGatewayCleanupHost,
  options: IsolatedGatewayCleanupOptions,
): void {
  validateIsolatedGatewayCleanup(options);
  cleanup.trackDisposable(`release isolated gateway ${options.gatewayName} and its test home`, () =>
    cleanupIsolatedGateway(host, options),
  );
}
