// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isStdinTty } from "../../../core/stdin";
import {
  structuredTurnIncompleteSignal,
  type StructuredTurnIncompleteSignal,
  structuredTurnProvenanceLines,
} from "./structured-turn-envelope";
import {
  buildOpenshellExecArgs,
  computeExitCode,
  wrapExecCommandWithRuntimeEnv,
  wrapOpenClawAgentCommandWithRuntimeEnv,
} from "../exec";
import { getKnownSandboxTargetGatewayName } from "../gateway-target";
import {
  declarationAuthorizesStructuredTurnEnvelope,
  type StructuredTurnEnvelopeDeclaration,
} from "./command-plan";
import {
  type AgentDispatchRunner,
  agentDispatchDeadlineSeconds,
  isSilentAgentDispatch,
  runAgentDispatch,
  SILENT_AGENT_DISPATCH_EXIT_CODE,
} from "./passthrough-dispatch";
import {
  writeDeclaredAgentTurnIncompleteFailure,
  writeDeclaredAgentTurnTimeoutFailure,
  writeIncompleteAgentTurnFailure,
  writeSilentAgentDispatchFailure,
  writeTimedOutAgentTurnFailure,
} from "./passthrough-help";

/** Exit code for a turn the payload itself marks incomplete or abandoned. */
export const INCOMPLETE_AGENT_TURN_EXIT_CODE = 1;

export type AgentJsonPassthroughProcess = {
  exit(code: number): never;
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
};

export type AgentJsonPassthroughDeps = {
  getOpenshellBinary?: () => string;
  getGatewayName?: (sandboxName: string) => string | null;
  stdinIsTty?: () => boolean;
  provenanceLines?: (raw: string) => string[];
  incompleteTurnSignal?: (raw: string) => StructuredTurnIncompleteSignal | null;
  runDispatch?: AgentDispatchRunner;
  timeoutSeconds?: number;
  wrapCommand?: (command: readonly string[]) => string[];
  parserFailureLine?: string;
  legacyOpenClawDiagnostics?: boolean;
};

export function defaultGetOpenshellBinary(): string {
  // Lazy require keeps this module unit-testable under Vitest's TS loader; the
  // OpenShell runtime imports runner/platform modules that only exist in built
  // CLI layouts.
  const runtime = require("../agents/openshell") as typeof import("../agents/openshell");
  return runtime.getOpenshellBinary();
}

function writeProvenanceBlock(
  proc: AgentJsonPassthroughProcess,
  stderr: string,
  lines: readonly string[],
): void {
  if (lines.length === 0) return;
  proc.stderr.write(`${stderr && !stderr.endsWith("\n") ? "\n" : ""}${lines.join("\n")}\n`);
}

async function runStructuredJsonPassthrough(
  sandboxName: string,
  command: readonly string[],
  proc: AgentJsonPassthroughProcess = process,
  deps: AgentJsonPassthroughDeps = {},
): Promise<never> {
  const binary = (deps.getOpenshellBinary ?? defaultGetOpenshellBinary)();
  const result = await (deps.runDispatch ?? runAgentDispatch)(
    binary,
    buildOpenshellExecArgs(
      sandboxName,
      (deps.wrapCommand ?? wrapExecCommandWithRuntimeEnv)(command),
      { tty: false, timeoutSeconds: deps.timeoutSeconds },
      (deps.getGatewayName ?? getKnownSandboxTargetGatewayName)(sandboxName) ?? undefined,
    ),
    {
      stdinIsTty: (deps.stdinIsTty ?? isStdinTty)(),
    },
  );
  const { stderr, stdout } = result;

  // Ahead of the stdout write so machine-readable stdout stays byte-empty and
  // no provenance line is appended for a turn that never ran.
  if (isSilentAgentDispatch(result, stdout, stderr)) {
    writeSilentAgentDispatchFailure(proc, sandboxName, command);
    return proc.exit(SILENT_AGENT_DISPATCH_EXIT_CODE);
  }

  if (stdout) proc.stdout.write(stdout);
  if (stderr) proc.stderr.write(stderr);

  try {
    writeProvenanceBlock(
      proc,
      stderr,
      (deps.provenanceLines ?? structuredTurnProvenanceLines)(stdout),
    );
  } catch {
    writeProvenanceBlock(proc, stderr, [
      deps.parserFailureLine ??
        "[agent provenance] skipped provenance extraction after parser failure.",
    ]);
  }

  const { code, errorMessage } = computeExitCode(result);
  if (errorMessage) {
    proc.stderr.write(`  Failed to invoke openshell: ${errorMessage}\n`);
    proc.stderr.write("  Ensure 'openshell' is installed and on PATH.\n");
  }

  // Last, so the partial trace and its provenance are already on the wire: a
  // turn the payload marks incomplete must not exit 0 just because the envelope
  // reported success. An upstream non-zero code is preserved as-is. A payload
  // that declares a timeout phase gets the deadline-specific guidance instead
  // of the generic incomplete-turn text; both are the same failure to the
  // caller and share one exit code.
  const incompleteTurn = (deps.incompleteTurnSignal ?? structuredTurnIncompleteSignal)(stdout);
  if (incompleteTurn && code === 0) {
    if (incompleteTurn.timeoutPhase) {
      if (deps.legacyOpenClawDiagnostics) {
        writeTimedOutAgentTurnFailure(proc, sandboxName, incompleteTurn.timeoutPhase);
      } else {
        writeDeclaredAgentTurnTimeoutFailure(proc, sandboxName, incompleteTurn.timeoutPhase);
      }
    } else if (deps.legacyOpenClawDiagnostics) {
      writeIncompleteAgentTurnFailure(proc, sandboxName, incompleteTurn.markers);
    } else {
      writeDeclaredAgentTurnIncompleteFailure(proc, sandboxName, incompleteTurn.markers);
    }
    return proc.exit(INCOMPLETE_AGENT_TURN_EXIT_CODE);
  }
  return proc.exit(code);
}

/** Interpret a receipt-declared structured turn envelope without harness-specific dispatch. */
export async function runStructuredTurnJsonPassthrough(
  declaration: StructuredTurnEnvelopeDeclaration,
  sandboxName: string,
  command: readonly string[],
  proc: AgentJsonPassthroughProcess = process,
  deps: AgentJsonPassthroughDeps = {},
): Promise<never> {
  if (!declarationAuthorizesStructuredTurnEnvelope(declaration, command)) {
    proc.stderr.write(
      "  The package command is not authorized for structured-turn envelope interpretation.\n",
    );
    return proc.exit(2);
  }
  return runStructuredJsonPassthrough(sandboxName, command, proc, deps);
}

/** Compatibility wrapper for no-receipt OpenClaw sandboxes. */
export async function runAgentJsonPassthrough(
  sandboxName: string,
  command: readonly string[],
  proc: AgentJsonPassthroughProcess = process,
  deps: AgentJsonPassthroughDeps = {},
): Promise<never> {
  const provenanceLines =
    deps.provenanceLines ??
    ((raw: string) =>
      structuredTurnProvenanceLines(raw).map((line) =>
        line.replace(/^\[agent provenance\]/u, "[openclaw provenance]"),
      ));
  return runStructuredJsonPassthrough(sandboxName, command, proc, {
    ...deps,
    legacyOpenClawDiagnostics: true,
    timeoutSeconds: deps.timeoutSeconds ?? agentDispatchDeadlineSeconds(command),
    provenanceLines,
    wrapCommand: deps.wrapCommand ?? wrapOpenClawAgentCommandWithRuntimeEnv,
    parserFailureLine:
      deps.parserFailureLine ??
      "[openclaw provenance] skipped provenance extraction after parser failure.",
  });
}
