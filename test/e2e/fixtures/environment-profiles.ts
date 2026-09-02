// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isSupportedGatewayDockerHost } from "../../../src/lib/domain/docker-host.ts";
import { buildAvailabilityProbeEnv } from "./availability-env.ts";

const DOCKER_CONTEXT_HOST_FORMAT = "{{json .Endpoints.docker.Host}}";
const ISOLATED_HOME_DOCKER_SELECTORS = [
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_TLS_VERIFY",
] as const;

const HOST_OPEN_SHELL_HOME_SELECTORS = {
  XDG_BIN_HOME: [".local", "bin"],
  XDG_CONFIG_HOME: [".config"],
  XDG_DATA_HOME: [".local", "share"],
  XDG_STATE_HOME: [".local", "state"],
} as const;

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

/** Resolve the host-owned directories that establish OpenShell authority. */
function hostOpenShellAuthority(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sourceHome = source.HOME;
  if (!sourceHome || !path.isAbsolute(sourceHome)) {
    throw new Error("An absolute host HOME is required before isolating NemoClaw E2E state");
  }

  return Object.fromEntries(
    Object.entries(HOST_OPEN_SHELL_HOME_SELECTORS).map(([selector, fallbackParts]) => {
      const configured = source[selector];
      if (configured && !path.isAbsolute(configured)) {
        throw new Error(`${selector} must be absolute before isolating NemoClaw E2E state`);
      }
      return [selector, configured ?? path.join(sourceHome, ...fallbackParts)];
    }),
  );
}

/**
 * Isolate NemoClaw's HOME-owned state while retaining the reviewed host
 * OpenShell installation, gateway registration, mTLS identity, and runtime
 * data. OpenShell is host infrastructure for this target, not test state.
 * Preserve local Docker access without exposing the account's Docker config.
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
  Object.assign(environment, hostOpenShellAuthority(source));
  environment.HOME = home;
  environment.DOCKER_HOST = dockerHost;
  return environment;
}

/**
 * Create an isolated HOME beneath the caller's real home directory.
 *
 * NemoClaw rejects package stores reached through symlinks or writable
 * ancestors. System temporary directories do not meet that contract: macOS
 * aliases them through /var, while Linux normally exposes /tmp as 01777.
 */
export function createPrivateTestHome(prefix: string, parentHome: string = os.homedir()): string {
  const canonicalParent = fs.realpathSync(parentHome);
  const testHome = fs.mkdtempSync(path.join(canonicalParent, prefix));
  fs.chmodSync(testHome, 0o700);
  return fs.realpathSync(testHome);
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
