// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isStdinTty } from "../../../core/stdin";
import { buildOpenshellExecArgs, computeExitCode, wrapExecCommandWithRuntimeEnv } from "../exec";
import { getKnownSandboxTargetGatewayName } from "../gateway-target";
import { type AgentDispatchRunner, runAgentDispatch } from "./passthrough-dispatch";

export type PackageAgentCapturedProcess = {
  exit(code: number): never;
  stdout: { write(value: string): unknown };
  stderr: { write(value: string): unknown };
};

export type PackageAgentCapturedDeps = {
  getOpenshellBinary?: () => string;
  getGatewayName?: (sandboxName: string) => string | null;
  stdinIsTty?: () => boolean;
  runDispatch?: AgentDispatchRunner;
  timeoutSeconds?: number;
};

function defaultGetOpenshellBinary(): string {
  const runtime = require("../agents/openshell") as typeof import("../agents/openshell");
  return runtime.getOpenshellBinary();
}

/** Relay one receipt-backed command without interpreting output as a specific harness envelope. */
export async function runPackageAgentCapturedPassthrough(
  sandboxName: string,
  command: readonly string[],
  proc: PackageAgentCapturedProcess = process,
  deps: PackageAgentCapturedDeps = {},
): Promise<never> {
  const binary = (deps.getOpenshellBinary ?? defaultGetOpenshellBinary)();
  const result = await (deps.runDispatch ?? runAgentDispatch)(
    binary,
    buildOpenshellExecArgs(
      sandboxName,
      wrapExecCommandWithRuntimeEnv(command),
      { tty: false, timeoutSeconds: deps.timeoutSeconds },
      (deps.getGatewayName ?? getKnownSandboxTargetGatewayName)(sandboxName) ?? undefined,
    ),
    { stdinIsTty: (deps.stdinIsTty ?? isStdinTty)() },
  );

  if (result.stdout) proc.stdout.write(result.stdout);
  if (result.stderr) proc.stderr.write(result.stderr);
  const { code, errorMessage } = computeExitCode(result);
  if (errorMessage) {
    proc.stderr.write(`  Failed to invoke openshell: ${errorMessage}\n`);
    proc.stderr.write("  Ensure 'openshell' is installed and on PATH.\n");
  }
  return proc.exit(code);
}
