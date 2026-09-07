// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../../cli/branding";
import { shellQuote } from "../../../core/shell-quote";
import { sanitizeReadinessText } from "../../../readiness/sanitize";
import { redactAgentDiagnostic } from "./diagnostic";

/** Stderr sink for the passthrough's operator-facing failure text. */
export type AgentPassthroughDiagnosticProcess = {
  stderr: { write(s: string): unknown };
};

/**
 * Report a dispatch that exited 0 without delivering a turn (#8796). Lives
 * beside the help text because both are operator-facing copy for this command;
 * the classifier that decides when to call it lives in `passthrough-dispatch`.
 */
export function writeSilentAgentDispatchFailure(
  proc: AgentPassthroughDiagnosticProcess,
  sandboxName: string,
  command: readonly string[],
): void {
  // The recovery command reproduces THIS turn, not a bare `openclaw agent`:
  // an invocation without a target selector and the original arguments exits 2
  // on the selector guard instead of running anything. Sandbox name and
  // forwarded argv are user-controlled command text and stay shell-quoted.
  //
  // The forwarded argv can carry message text and session identifiers, and
  // stderr is captured by CI logs and automation that may never log the
  // invocation itself. Redact before emitting so a credential pasted into
  // `-m` is not amplified into a log it would not otherwise reach. Redaction
  // is pattern-based, so ordinary prompt text is unchanged and the command
  // stays runnable; a command that does get masked is one nobody should
  // replay verbatim anyway.
  const rawDirectRun = [CLI_NAME, shellQuote(sandboxName), "exec", "--", ...command.map(shellQuote)]
    .join(" ")
    .trimEnd();
  const directRun = redactAgentDiagnostic(rawDirectRun);
  const directRunWasRedacted = directRun !== rawDirectRun;
  proc.stderr.write(
    `  The agent dispatch for sandbox '${sandboxName}' exited 0 without producing any output, so the turn was not delivered.\n`,
  );
  proc.stderr.write(
    "  Reporting this as a failure: a delivered turn always writes to stdout or stderr.\n",
  );
  proc.stderr.write("  Documented recovery paths:\n");
  proc.stderr.write(`    ${directRun}\n`);
  proc.stderr.write(
    directRunWasRedacted
      ? "      — sensitive values were redacted; do not replay this command\n"
      : "      — run this turn directly inside the sandbox\n",
  );
  proc.stderr.write(
    `    ${CLI_NAME} ${shellQuote(sandboxName)} status    — confirm gateway and inference health\n`,
  );
  proc.stderr.write(
    `    ${CLI_NAME} ${shellQuote(sandboxName)} recover   — re-pair the gateway without recreating the sandbox\n`,
  );
}

/**
 * Report a turn the payload marks incomplete or abandoned (#8796). The agent's
 * partial output has already been written verbatim, so this only adds the
 * verdict, the markers that produced it, and verify-before-retry guidance —
 * retrying blind can re-apply side effects the abandoned turn already made.
 */
export function writeIncompleteAgentTurnFailure(
  proc: AgentPassthroughDiagnosticProcess,
  sandboxName: string,
  markers: readonly string[],
): void {
  proc.stderr.write(
    `  The agent turn in sandbox '${sandboxName}' did not complete: ${markers.join(", ")}.\n`,
  );
  proc.stderr.write(
    "  The output above is a partial trace. Tool calls in it may have already applied side effects.\n",
  );
  proc.stderr.write("  Locate the session key, then export its transcript:\n");
  proc.stderr.write(`    ${CLI_NAME} ${shellQuote(sandboxName)} sessions list\n`);
  proc.stderr.write(`    ${CLI_NAME} ${shellQuote(sandboxName)} sessions export <key>\n`);
  proc.stderr.write(
    "  Inspect the partial JSON trace, exported transcript, and affected resources before retrying.\n",
  );
}

/** Receipt-neutral verdict for a package-declared structured turn. */
export function writeDeclaredAgentTurnIncompleteFailure(
  proc: AgentPassthroughDiagnosticProcess,
  sandboxName: string,
  markers: readonly string[],
): void {
  proc.stderr.write(
    `  The agent turn in sandbox '${sandboxName}' did not complete: ${markers.join(", ")}.\n`,
  );
  proc.stderr.write(
    "  The output above is a partial trace. Tool calls in it may have already applied side effects.\n",
  );
  proc.stderr.write(
    "  Inspect the partial trace and affected resources before retrying with the package's documented recovery path.\n",
  );
}

/**
 * Report a turn whose deadline fired before it produced a result (#8723). The
 * partial output has already been written verbatim, so this adds the verdict,
 * the phase when the payload declares one, and where the deadline that fired
 * actually lives. Retrying blind can re-apply side effects the timed-out turn
 * already made.
 *
 * `--timeout` is described rather than offered as a recovery command because a
 * measured provider-phase timeout does not respond to it: `--timeout N` sets the
 * embedded run deadline (`embedded run timeout timeoutMs=N000`), while the
 * provider request keeps the deadline from `models.providers.<id>.timeoutSeconds`
 * (`[model-fetch] start ... timeoutMs=60000` was unchanged by `--timeout 150`).
 */
export function writeTimedOutAgentTurnFailure(
  proc: AgentPassthroughDiagnosticProcess,
  sandboxName: string,
  timeoutPhase?: string,
): void {
  const sandboxDisplay = sanitizeReadinessText(sandboxName, 200);
  const target = shellQuote(sandboxDisplay);
  const diagnosticPhase =
    timeoutPhase && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(timeoutPhase) ? timeoutPhase : undefined;
  proc.stderr.write(
    diagnosticPhase
      ? `  The agent turn in sandbox '${sandboxDisplay}' timed out in the ${diagnosticPhase} phase before producing a result.\n`
      : `  The agent turn in sandbox '${sandboxDisplay}' timed out before producing a result.\n`,
  );
  proc.stderr.write(
    "  Reporting this as a failure: the deadline fired and no result reached this command.\n",
  );
  proc.stderr.write(
    "  The output above is a partial trace. Tool calls in it may have already applied side effects.\n",
  );
  proc.stderr.write("  Documented recovery paths:\n");
  proc.stderr.write(`    ${CLI_NAME} ${target} sessions list          — locate the session key\n`);
  proc.stderr.write(
    `    ${CLI_NAME} ${target} sessions export <key>  — export the partial transcript\n`,
  );
  proc.stderr.write(
    `    ${CLI_NAME} ${target} config set --key <deadline-key> --value <seconds> --restart  — raise the deadline\n`,
  );
  proc.stderr.write(
    "  Two keys carry a deadline. agents.defaults.timeoutSeconds bounds the run, and\n",
  );
  proc.stderr.write(
    "  `agent --timeout <seconds>` overrides it for a single run. models.providers.<id>.timeoutSeconds\n",
  );
  proc.stderr.write("  bounds the provider request, and no flag overrides it.\n");
  proc.stderr.write("  Inspect the partial output and affected resources before retrying.\n");
}

/** Receipt-neutral timeout verdict for a package-declared structured turn. */
export function writeDeclaredAgentTurnTimeoutFailure(
  proc: AgentPassthroughDiagnosticProcess,
  sandboxName: string,
  timeoutPhase?: string,
): void {
  const sandboxDisplay = sanitizeReadinessText(sandboxName, 200);
  const diagnosticPhase =
    timeoutPhase && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(timeoutPhase) ? timeoutPhase : undefined;
  proc.stderr.write(
    diagnosticPhase
      ? `  The agent turn in sandbox '${sandboxDisplay}' timed out in the ${diagnosticPhase} phase before producing a result.\n`
      : `  The agent turn in sandbox '${sandboxDisplay}' timed out before producing a result.\n`,
  );
  proc.stderr.write(
    "  Reporting this as a failure: the deadline fired and no result reached this command.\n",
  );
  proc.stderr.write(
    "  The output above is a partial trace. Tool calls in it may have already applied side effects.\n",
  );
  proc.stderr.write(
    "  Inspect the partial trace and affected resources, then use the package's documented deadline setting before retrying.\n",
  );
}

export function hasAgentPassthroughHelpToken(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === "--") break;
    if (arg === "--help" || arg === "-h") return true;
  }
  return false;
}

export function printAgentPassthroughHelp(): void {
  console.log("");
  console.log(`  Usage: ${CLI_NAME} <name> agent [prompt-or-agent-flags...]`);
  console.log("");
  console.log(
    "  Run the sandbox's package-declared headless or native command via `openshell sandbox exec`.",
  );
  console.log("  For packages with a Fabric command, a plain prompt or");
  console.log("  -m/--message with optional --json uses private standard input, not host");
  console.log("  process arguments. Bare, help, and option-first calls use the native");
  console.log("  interactive command. This experimental path leaves the native option grammar");
  console.log("  with the agent runtime package.");
  console.log("");
  console.log("  OpenClaw plain positional prompts can use Fabric and private standard input.");
  console.log("  Except for -h/--help, OpenClaw selector and option calls keep the native");
  console.log("  `openclaw agent ...` path for compatibility.");
  console.log(
    "  Common OpenClaw flags: -m <text>, --session-id <id>, --agent <id>, --json, --thinking <level>.",
  );
  console.log("");
  console.log("  Native OpenClaw invocations must include at least one target selector — --agent,");
  console.log("  --session-id, --session-key, or --to. On Ready/Running OpenClaw sandboxes,");
  console.log("  invocations without a selector exit 2 with `No target session selected`; on a");
  console.log(
    "  non-Ready sandbox the phase guard fires first and exits 1 with recovery commands.",
  );
  console.log("");
  console.log("  Legacy no-receipt OpenClaw -h/--help prints this wrapper summary locally. Run");
  console.log(`  \`${CLI_NAME} <name> exec -- openclaw agent --help\` for native OpenClaw help.`);
  console.log("");
  console.log(`  For receipt-backed package help, run \`${CLI_NAME} <name> agent --help\` to view`);
  console.log("  its declared native command help from inside the sandbox.");
  console.log("");
  console.log(
    "  A Hermes package with a Fabric headless command accepts the common prompt grammar.",
  );
  console.log("  A Hermes definition without that command is rejected with HTTP API guidance.");
  console.log("");
}
