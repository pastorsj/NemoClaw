// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  buildOpenShellSubprocessEnv,
  resolveOpenshellBinaryOrNull,
} from "../adapters/openshell/resolve-shared";
import { VOICE_GATEWAY_DEPLOYMENT_CREDENTIAL_FD, VOICE_GATEWAY_FEATURE_ENV } from "./contracts";
import { validatePrivateCredentialDescriptor } from "./credential-file";
import {
  encodeSemanticTurnBinding,
  resolveSandboxSemanticTurnAuthority,
  semanticTurnBinding,
  type SandboxSemanticTurnAuthority,
} from "./sandbox-authority";

/** Trusted source paths and fixed runtime fields for one voice-gateway launch. */
export interface VoiceGatewayLaunchOptions {
  readonly deploymentCredentialPath: string;
  readonly runtimeIdentity: string;
  readonly runtimeProfile: string;
  readonly sandbox: string;
  readonly agent: string;
  readonly listenPort?: number;
}

/** Credential-free process contract emitted by the bounded launcher. */
export interface VoiceGatewayLaunchContract {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface VoiceGatewayProcessAuthority {
  readonly openshellBinary: string;
  readonly semanticTurn: SandboxSemanticTurnAuthority;
  readonly sourceEnv: NodeJS.ProcessEnv;
}

export interface VoiceGatewayLauncherDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly resolveOpenShell?: (env: NodeJS.ProcessEnv) => string | null;
  readonly resolveSemanticTurnAuthority?: (sandboxName: string) => SandboxSemanticTurnAuthority;
  readonly spawnChild?: typeof spawn;
}

/** Cleanup failure that retains the only handle to a child whose exit was not observed. */
export class VoiceGatewayTerminationUnconfirmedError extends Error {
  readonly child: ChildProcess;

  constructor(cause: unknown, child: ChildProcess) {
    super("Voice gateway termination could not be confirmed after credential cleanup failed.", {
      cause,
    });
    this.name = "VoiceGatewayTerminationUnconfirmedError";
    this.child = child;
  }
}

const CLI = path.resolve(__dirname, "../../../bin/nemoclaw.js");

/** Build the path- and value-free child process contract for the voice gateway. */
export function buildVoiceGatewayLaunchContract(
  options: VoiceGatewayLaunchOptions,
  authority: VoiceGatewayProcessAuthority,
): VoiceGatewayLaunchContract {
  if (!path.isAbsolute(authority.openshellBinary)) {
    throw new Error("Voice gateway requires an absolute OpenShell executable path.");
  }
  const binding = semanticTurnBinding(authority.semanticTurn);
  if (binding.sandboxName !== options.sandbox) {
    throw new Error("Voice gateway sandbox authority does not match the requested sandbox.");
  }
  const args = [
    CLI,
    "internal",
    "voice-gateway",
    "serve",
    "--runtime-identity",
    options.runtimeIdentity,
    "--runtime-profile",
    options.runtimeProfile,
    "--sandbox",
    options.sandbox,
    "--sandbox-authority",
    encodeSemanticTurnBinding(binding),
    "--agent",
    options.agent,
    "--turn-timeout-ms",
    String(authority.semanticTurn.declaration.timeout_seconds * 1000),
  ];
  if (options.listenPort !== undefined) args.push("--listen-port", String(options.listenPort));
  const env = buildOpenShellSubprocessEnv(authority.sourceEnv);
  const home = authority.sourceEnv.HOME || "/tmp";
  if (!path.isAbsolute(home)) throw new Error("Voice gateway HOME must be an absolute path.");
  for (const name of ["XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "OPENSHELL_WORKSPACE"] as const) {
    const value = authority.sourceEnv[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  return {
    command: process.execPath,
    args,
    env: {
      ...env,
      HOME: home,
      NEMOCLAW_GATEWAY_PORT: String(binding.gatewayPort),
      NEMOCLAW_OPENSHELL_BIN: authority.openshellBinary,
      [VOICE_GATEWAY_FEATURE_ENV]: "1",
    },
  };
}

function captureProcessAuthority(
  options: VoiceGatewayLaunchOptions,
  dependencies: VoiceGatewayLauncherDependencies,
): VoiceGatewayProcessAuthority {
  const sourceEnv = dependencies.env ?? process.env;
  const semanticTurn = (
    dependencies.resolveSemanticTurnAuthority ?? resolveSandboxSemanticTurnAuthority
  )(options.sandbox);
  const openshellBinary = (
    dependencies.resolveOpenShell ?? ((env) => resolveOpenshellBinaryOrNull(env))
  )(sourceEnv);
  if (!openshellBinary || !path.isAbsolute(openshellBinary)) {
    throw new Error("Voice gateway could not resolve an absolute OpenShell executable.");
  }
  return Object.freeze({ openshellBinary, semanticTurn, sourceEnv: { ...sourceEnv } });
}

/** Open and validate one trusted credential source without exposing its path downstream. */
function openCredential(pathname: string, label: string): number {
  if (!path.isAbsolute(pathname)) throw new Error(`${label} path must be absolute.`);
  if (typeof fs.constants.O_NOFOLLOW !== "number") {
    throw new Error("Secure no-follow credential opens are unavailable on this platform.");
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      pathname,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") {
      throw new Error(`${label} path must not be a symbolic link.`);
    }
    throw new Error(`${label} source could not be opened.`);
  }
  try {
    validatePrivateCredentialDescriptor(fs.fstatSync(descriptor), label);
    return descriptor;
  } catch (error) {
    try {
      fs.closeSync(descriptor);
    } catch {
      // Preserve the validation failure; the process still owns final descriptor cleanup.
    }
    throw error;
  }
}

/** Close every owned descriptor while preserving the first cleanup failure. */
function closeDescriptors(descriptors: readonly number[]): void {
  let cleanupError: unknown;
  for (const descriptor of descriptors) {
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EBADF") continue;
      cleanupError ??= error;
    }
  }
  if (cleanupError !== undefined) throw cleanupError;
}

/** Attempt bounded termination and report whether child exit was observed. */
async function terminateChild(child: ChildProcess): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    let forceTimer: NodeJS.Timeout | undefined;
    let terminalTimer: NodeJS.Timeout | undefined;
    const settled = (exitObserved: boolean) => {
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      if (terminalTimer !== undefined) clearTimeout(terminalTimer);
      child.off("error", failed);
      child.off("exit", confirmed);
      resolve(exitObserved);
    };
    const confirmed = () => settled(true);
    const failed = () => settled(false);
    forceTimer = setTimeout(() => {
      if (!child.kill("SIGKILL")) {
        settled(false);
        return;
      }
      terminalTimer = setTimeout(() => settled(false), 5_000);
      terminalTimer.unref();
    }, 5_000);
    forceTimer.unref();
    child.once("error", failed);
    child.once("exit", confirmed);
    if (!child.kill("SIGTERM")) settled(false);
  });
}

/** Launch the real gateway with only the selected deployment credential inherited. */
export async function launchVoiceGateway(
  options: VoiceGatewayLaunchOptions,
  dependencies: VoiceGatewayLauncherDependencies = {},
): Promise<ChildProcess> {
  const descriptors: number[] = [];
  let child: ChildProcess | undefined;
  let operationError: { readonly value: unknown } | undefined;
  try {
    const deployment = openCredential(
      options.deploymentCredentialPath,
      "Voice gateway deployment credential",
    );
    descriptors.push(deployment);
    const contract = buildVoiceGatewayLaunchContract(
      options,
      captureProcessAuthority(options, dependencies),
    );
    const stdio: Array<"ignore" | "pipe" | number> = ["ignore", "pipe", "pipe"];
    stdio[VOICE_GATEWAY_DEPLOYMENT_CREDENTIAL_FD] = deployment;
    child = (dependencies.spawnChild ?? spawn)(contract.command, contract.args, {
      env: contract.env,
      stdio,
    });
  } catch (error) {
    operationError = { value: error };
  }

  let cleanupError: unknown;
  try {
    closeDescriptors(descriptors);
  } catch (error) {
    cleanupError = error;
  }
  if (operationError !== undefined) throw operationError.value;
  if (cleanupError !== undefined) {
    if (!(await terminateChild(child!))) {
      throw new VoiceGatewayTerminationUnconfirmedError(cleanupError, child!);
    }
    throw cleanupError;
  }
  return child!;
}
