// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { captureOpenshell } from "../../../adapters/openshell/runtime";
import {
  type HarnessSessionAdapterHostModule,
  loadHarnessSessionAdapterHostModule,
} from "../../../agent-runtime/session-module";
import { CLI_NAME } from "../../../cli/branding";
import {
  deferSandboxLifecycleExit,
  runWithDeferredSandboxLifecycleExit,
} from "../../../core/process-exit";
import { assertHermesPortableCommandUnavailable } from "../../../onboard/experimental/portable-agent-lifecycle";
import { resolvePackageBackedSandboxAgent } from "../../../onboard/package/package-authority";
import { withMcpLifecycleLock } from "../../../state/mcp-lifecycle-lock-acquisition";
import * as registry from "../../../state/registry";
import { buildOpenshellExecArgs, computeExitCode, execSandbox } from "../exec";
import { ensureLiveSandboxOrExit } from "../gateway-state";
import { WARMUP_SESSION_ID_PREFIX } from "../warmup-session";
import { runLegacySessionList } from "./legacy-list";

const SESSION_LIST_CAPTURE_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export type SessionsPassthroughVerb = "list";

export interface SessionsPassthroughOptions {
  readonly verb?: SessionsPassthroughVerb;
  readonly extraArgs?: readonly string[];
}

export function hasSessionsPassthroughHelpToken(args: readonly string[]): boolean {
  for (const argument of args) {
    if (argument === "--") break;
    if (argument === "--help" || argument === "-h") return true;
  }
  return false;
}

export function printSessionsPassthroughHelp(verb?: SessionsPassthroughVerb): void {
  const usageSuffix = verb ? ` ${verb}` : "";
  const flagsToken = verb ? `sessions-${verb}-flags` : "sessions-flags";
  console.log("");
  console.log(`  Usage: ${CLI_NAME} <name> sessions${usageSuffix} [${flagsToken}...]`);
  console.log("");
  console.log("  List conversation sessions through the installed harness package.");
  console.log("  NemoClaw forwards additional arguments to the package's native session command.");
  console.log("");
}

function writeWithTrailingNewline(stream: NodeJS.WriteStream, value: string | undefined): void {
  if (!value) return;
  stream.write(value.endsWith("\n") ? value : `${value}\n`);
}

function capturedStdout(result: { readonly output: string; readonly stdout?: string }): string {
  return typeof result.stdout === "string" ? result.stdout.trim() : result.output;
}

function capturedStderr(result: { readonly stderr?: string }): string {
  return typeof result.stderr === "string" ? result.stderr.trim() : "";
}

function stopSessionList(message: string): never {
  console.error(`  ${message}`);
  deferSandboxLifecycleExit(1);
}

function resolvePackageSessionAdapter(
  sandbox: NonNullable<ReturnType<typeof registry.getSandbox>>,
): HarnessSessionAdapterHostModule {
  try {
    const resolved = resolvePackageBackedSandboxAgent(sandbox);
    if (!resolved.harnessPackage) {
      throw new Error("the sandbox does not carry a harness package identity");
    }
    return loadHarnessSessionAdapterHostModule(resolved.harnessPackage);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return stopSessionList(`Cannot resolve the installed harness session adapter: ${detail}`);
  }
}

async function executeCapturedSessionList(
  sandboxName: string,
  command: readonly string[],
  extraArgs: readonly string[],
  adapter: HarnessSessionAdapterHostModule,
): Promise<void> {
  const result = captureOpenshell(buildOpenshellExecArgs(sandboxName, command), {
    ignoreError: true,
    includeStreams: true,
    maxBuffer: SESSION_LIST_CAPTURE_MAX_BUFFER_BYTES,
  });
  const { code, errorMessage } = computeExitCode(result);
  const stdout = capturedStdout(result);
  const stderr = capturedStderr(result);
  if (code !== 0) {
    writeWithTrailingNewline(process.stdout, stdout);
    writeWithTrailingNewline(process.stderr, stderr);
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS") {
      console.error("  Session-list output exceeded NemoClaw's 64 MiB capture boundary.");
    } else if (errorMessage) {
      console.error(`  Failed to invoke openshell: ${errorMessage}`);
    }
    deferSandboxLifecycleExit(code);
  }

  let interpreted: ReturnType<HarnessSessionAdapterHostModule["interpretSessionListOutput"]>;
  try {
    interpreted = adapter.interpretSessionListOutput({
      output: stdout,
      jsonOutput: extraArgs.includes("--json"),
      hiddenSessionIdPrefix: WARMUP_SESSION_ID_PREFIX,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return stopSessionList(
      `The installed harness could not interpret session-list output: ${detail}`,
    );
  }
  if (interpreted.kind === "refused") stopSessionList(interpreted.reason);
  writeWithTrailingNewline(process.stdout, interpreted.output);
  writeWithTrailingNewline(process.stderr, stderr);
}

export async function runSessionsPassthrough(
  sandboxName: string,
  { verb, extraArgs = [] }: SessionsPassthroughOptions = {},
): Promise<void> {
  return runWithDeferredSandboxLifecycleExit(async () => {
    await withMcpLifecycleLock(sandboxName, () => {
      assertHermesPortableCommandUnavailable(sandboxName, `sandbox:sessions:${verb ?? "list"}`);
      return runSessionsPassthroughUnlocked(sandboxName, { verb, extraArgs });
    });
  });
}

async function runSessionsPassthroughUnlocked(
  sandboxName: string,
  { verb, extraArgs = [] }: SessionsPassthroughOptions,
): Promise<void> {
  await ensureLiveSandboxOrExit(sandboxName, {
    allowNonReadyPhase: true,
    exit: deferSandboxLifecycleExit,
  });
  const sandbox = registry.getSandbox(sandboxName);
  if (!sandbox?.harnessPackage) {
    return runLegacySessionList(sandboxName, sandbox?.agent, {
      useListSubcommand: verb === "list",
      arguments: extraArgs,
    });
  }

  const adapter = resolvePackageSessionAdapter(sandbox);
  let plan: ReturnType<HarnessSessionAdapterHostModule["buildSessionListPlan"]>;
  try {
    plan = adapter.buildSessionListPlan({
      arguments: extraArgs,
      useListSubcommand: verb === "list",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return stopSessionList(`The installed harness could not build a session-list plan: ${detail}`);
  }

  if (plan.kind === "unsupported") stopSessionList(plan.reason);
  if (plan.kind === "stream") {
    await execSandbox(sandboxName, plan.command, {}, { exit: deferSandboxLifecycleExit });
    return;
  }
  await executeCapturedSessionList(sandboxName, plan.command, extraArgs, adapter);
}
