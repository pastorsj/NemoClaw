// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { captureOpenshell } from "../../../adapters/openshell/runtime";
import { deferSandboxLifecycleExit } from "../../../core/process-exit";
import { redactFull } from "../../../security/redact";
import { buildOpenshellExecArgs, computeExitCode } from "../exec";

const SESSION_MUTATION_CAPTURE_MAX_BUFFER_BYTES = 1024 * 1024;

function capturedStdout(result: { readonly output: string; readonly stdout?: string }): string {
  return typeof result.stdout === "string" ? result.stdout.trim() : result.output.trim();
}

function capturedDiagnostics(result: {
  readonly output: string;
  readonly stdout?: string;
  readonly stderr?: string;
}): string {
  if (typeof result.stdout === "string" || typeof result.stderr === "string") {
    return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  }
  return result.output.trim();
}

/** Execute one receipt-pinned package command and return only its bounded stdout. */
export function captureSessionMutationOutput(
  sandboxName: string,
  operation: "delete" | "reset",
  command: readonly string[],
): string {
  const result = captureOpenshell(buildOpenshellExecArgs(sandboxName, command), {
    ignoreError: true,
    includeStderr: true,
    includeStreams: true,
    maxBuffer: SESSION_MUTATION_CAPTURE_MAX_BUFFER_BYTES,
  });
  const { code, errorMessage } = computeExitCode(result);
  if (code === 0) return capturedStdout(result);

  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS") {
    console.error("  Session-mutation output exceeded NemoClaw's 1 MiB capture boundary.");
  } else {
    console.error(
      `  The installed harness session-${operation} command failed with exit ${String(code)}.`,
    );
    const diagnostic = redactFull(capturedDiagnostics(result));
    if (diagnostic) console.error(`  ${diagnostic}`);
    if (errorMessage) console.error(`  Failed to invoke openshell: ${errorMessage}`);
  }
  deferSandboxLifecycleExit(code || 1);
}
