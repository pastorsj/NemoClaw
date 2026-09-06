// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Source-of-truth boundary for the `nemoclaw <name> agent` passthrough.
//
// The wrapper enforces three host-side mirrors of upstream contracts, one
// advisory diagnostic, and one best-effort pre-dispatch recovery:
//
// 1. Agent-kind and package-authority guard (registry mirror).
//
//    - Invalid state: the local registry is the source of truth for which
//      agent a sandbox runs (openclaw vs hermes vs future variants).
//      Forwarding to `openclaw agent` against a different agent package can
//      invoke a missing binary or pass incompatible flags. A gateway package
//      can opt into non-interactive dispatch with a manifest headless command.
//    - Source boundary: the registry and its exact retained package receipt
//      are NemoClaw-owned. The in-sandbox invocation, its argv contract, and
//      its streaming behaviour are owned by the selected upstream agent
//      command. NemoClaw resolves the receipt-pinned manifest, then forwards
//      agent flags verbatim. Terminal-runtime dispatch uses that manifest
//      command only when it can be represented as simple whitespace-delimited
//      argv tokens; shell quoting and escaping fail closed. A package explicitly
//      selects private standard-input prompt transport. Packages with a native
//      agent grammar declare its argv, selectors, value options, bounded output,
//      and timeout option as finite data. Core never infers those semantics from
//      a package ID or executable name.
//    - Source-fix constraint: NemoClaw cannot prove agent type from anywhere
//      except the registry, because the OpenShell exec transport has no
//      pre-execution probe that reveals the sandbox's configured agent. A
//      registry read or retained-package resolution failure therefore has to
//      fail closed — silently degrading to a current bundled definition could
//      dispatch a command that does not belong to the sandbox image. Gateway
//      packages without a headless command remain unavailable through this
//      wrapper.
//
// 2. Non-ready phase guard (OpenShell phase mirror).
//
//    - Invalid state: when a sandbox container is stopped, errored, or
//      otherwise not Ready/Running, a bare `openshell sandbox exec` either
//      hangs, fails with a generic transport error, or silently runs against
//      a stale container. None of those surface the documented recovery
//      paths (`recover`, `rebuild --yes`, `onboard --resume`).
//    - Source boundary: OpenShell owns the phase value and the underlying
//      readiness mechanism; NemoClaw owns the host-side recovery copy and
//      the precedence of the phase check vs the selector check.
//    - Source-fix constraint: NemoClaw cannot teach `openshell sandbox exec`
//      to emit recovery commands on its own — that would require an upstream
//      change to OpenShell. The wrapper therefore inspects `ensureLive`'s
//      gateway-state output and rejects with NemoClaw's recovery copy before
//      forwarding to the in-sandbox binary. The phase check runs before the
//      selector check so a stopped sandbox still gets recovery guidance even
//      when the caller forgot the selector flag. If the gateway-state output
//      cannot be parsed for a `Phase:` line at all, the wrapper fails closed
//      with exit 2 rather than dispatching against an unknown phase.
//
// 3. Package-declared selector guard.
//
//    - Invalid state: upstream `openclaw agent` reports the missing-selector
//      error on stderr but then exits with status `0` (success), so CLI
//      consumers that branch on the exit code see the call as successful
//      and never learn that no selector was provided. The host-side mirror
//      converts that misuse into a clean exit `2` with the same diagnostic
//      before any in-sandbox dispatch runs.
//    - Source boundary: the receipt-pinned package owns the finite argv
//      declaration. NemoClaw enforces only the package's declared selector
//      requirement and stops scanning at the first literal `--`. The rest of
//      the argv remains byte-for-byte package input. OpenClaw's former native
//      grammar remains in `legacy-openclaw.ts` only for sandboxes without a
//      package receipt.
//
// 4. Ollama restart recovery (best-effort lifecycle bridge). Ollama owns model
//    runner lifetime, while NemoClaw owns the registered route and dispatch
//    ordering. The focused source-boundary analysis, reporting, and regression
//    coverage live in `ollama-restart-recovery.ts` and
//    `passthrough-ollama-recovery.ts`.
//
// 5. Dispatch delivery contract and stdin posture. Both captured transports
//    fail loud when the exec returns success with no bytes on either stream,
//    and neither hands an interactive terminal to the non-interactive
//    dispatch. Both transports pin the sandbox's owning gateway and use the
//    shared asynchronous exec supervisor, which forwards host termination to
//    OpenShell before returning the signal-derived exit status. The complete
//    source-boundary analysis and classifier live in
//    `passthrough-dispatch.ts`; the operator-facing failure text lives beside
//    the help copy in `passthrough-help.ts`. The oclif adapter supplies one
//    deferred exit callback to readiness, native, JSON, and headless paths so
//    every terminal result can unwind the sandbox lifecycle lock first.
//
// Regression tests: `passthrough.test.ts` covers the Hermes redirect, gateway
// headless dispatch, forwarded argv, SIGTERM exit status, the registry-miss
// fallback to OpenClaw, registry and package-resolution fail-closed paths, receipt-pinned terminal
// commands, quoted manifest command rejection, the enforced `--no-tty` argv
// shape, the non-Ready phase recovery path, the unparseable phase fail-closed
// path, the OpenClaw no-selector rejection, and the `--flag=value`
// selector-acceptance branch, plus the OpenClaw JSON
// captured transport path used to append failure provenance without polluting
// machine-readable stdout. The focused Ollama module owns its recovery tests.
//
// Removal conditions:
//
//   - Drop the registry-based agent-kind guard when OpenShell exposes a
//     metadata endpoint that returns the sandbox's configured agent.
//   - Drop the host-side phase guard when `openshell sandbox exec` surfaces
//     readiness or recovery guidance itself.
//   - Drop the selector mirror when upstream `openclaw agent` rejects a
//     missing selector with a clean exit 2 and an actionable message.
//   - Drop the simple-token parser when terminal runtime manifests expose
//     argv arrays natively.
//   - Drop Ollama pre-dispatch recovery when supported daemon restarts preserve
//     loaded runners or NemoClaw manages and warms the daemon lifecycle.

import { type AgentDefinition, isTerminalAgent } from "../../../agent/defs";
import { CLI_NAME } from "../../../cli/branding";
import { isStdinTty } from "../../../core/stdin";
import { resolveSandboxHermesApiPort } from "../../../onboard/hermes-api-port";
import { resolveLifecycleEligibleSandboxAgent } from "../../../onboard/package/package-authority";
import * as registry from "../../../state/registry";
import {
  buildOpenshellExecArgs,
  computeExitCode,
  execSandbox,
  wrapOpenClawAgentCommandWithRuntimeEnv,
} from "../exec";
import { ensureLiveSandboxOrExit } from "../gateway-state";
import { getKnownSandboxTargetGatewayName } from "../gateway-target";
import {
  type AgentDispatchRunner,
  agentDispatchDeadlineSeconds,
  agentDispatchDeadlineFromRequest,
  isSilentAgentDispatch,
  isTimedOutAgentDispatch,
  runAgentDispatch,
  SILENT_AGENT_DISPATCH_EXIT_CODE,
  TIMED_OUT_AGENT_TURN_EXIT_CODE,
} from "./passthrough-dispatch";
import { buildPackageAgentCommandPlan } from "./command-plan";
import { buildLegacyOpenClawCommandPlan, isLegacyOpenClawSandbox } from "./legacy-openclaw";
import {
  hasAgentPassthroughHelpToken,
  printAgentPassthroughHelp,
  writeSilentAgentDispatchFailure,
  writeTimedOutAgentTurnFailure,
} from "./passthrough-help";
import {
  type AgentJsonPassthroughProcess,
  defaultGetOpenshellBinary,
  runAgentJsonPassthrough,
} from "./passthrough-json";
import { OLLAMA_LOCAL_PROVIDER, runOllamaRestartRecovery } from "./passthrough-ollama-recovery";

export { hasAgentPassthroughHelpToken, printAgentPassthroughHelp } from "./passthrough-help";

// OpenClaw can exit zero after running in embedded-fallback mode and does not
// expose a stable machine-readable transport discriminator. These patterns mirror
// the gateway-auth live tests in restore-gateway-pairing.ts and extend them with
// the reporter-observed `[agent/embedded]` line prefix (#8100). Removal condition:
// OpenClaw provides a supported machine-readable gateway-only result or removes
// embedded-fallback mode.
const OPENCLAW_EMBEDDED_FALLBACK_PATTERN =
  /EMBEDDED FALLBACK|\[agent\/embedded\]|fallbackFrom[": ]+gateway|transport[": ]+embedded/i;

export type AgentNonJsonPassthroughDeps = {
  getOpenshellBinary?: () => string;
  getGatewayName?: (sandboxName: string) => string | null;
  runDispatch?: AgentDispatchRunner;
  stdinIsTty?: () => boolean;
  timeoutSeconds?: number;
};

export async function runAgentNonJsonPassthrough(
  sandboxName: string,
  command: readonly string[],
  proc: NonNullable<AgentPassthroughDeps["process"]>,
  deps: AgentNonJsonPassthroughDeps = {},
): Promise<never> {
  const binary = (deps.getOpenshellBinary ?? defaultGetOpenshellBinary)();
  const result = await (deps.runDispatch ?? runAgentDispatch)(
    binary,
    buildOpenshellExecArgs(
      sandboxName,
      wrapOpenClawAgentCommandWithRuntimeEnv(command),
      {
        tty: false,
        timeoutSeconds: deps.timeoutSeconds ?? agentDispatchDeadlineSeconds(command),
      },
      (deps.getGatewayName ?? getKnownSandboxTargetGatewayName)(sandboxName) ?? undefined,
    ),
    {
      stdinIsTty: (deps.stdinIsTty ?? isStdinTty)(),
    },
  );
  const { stderr, stdout } = result;

  if (isSilentAgentDispatch(result, stdout, stderr)) {
    writeSilentAgentDispatchFailure(proc, sandboxName, command);
    return proc.exit(SILENT_AGENT_DISPATCH_EXIT_CODE);
  }

  if (OPENCLAW_EMBEDDED_FALLBACK_PATTERN.test(`${stdout}\n${stderr}`)) {
    proc.stderr.write(
      `  OpenClaw is running in embedded-fallback mode in sandbox '${sandboxName}': gateway pairing is broken or missing.\n`,
    );
    proc.stderr.write("  Documented recovery paths:\n");
    proc.stderr.write(
      `    ${CLI_NAME} ${sandboxName} recover         — re-pair the gateway without recreating the sandbox\n`,
    );
    proc.stderr.write(
      `    ${CLI_NAME} ${sandboxName} rebuild --yes   — recreate container, workspace preserved\n`,
    );
    proc.stderr.write(
      `    ${CLI_NAME} onboard --resume               — restore sandbox registration\n`,
    );
    return proc.exit(1);
  }

  if (stdout) (proc.stdout ?? process.stdout).write(stdout);
  if (stderr) proc.stderr.write(stderr);
  const { code, errorMessage } = computeExitCode(result);
  if (errorMessage) {
    proc.stderr.write(`  Failed to invoke openshell: ${errorMessage}\n`);
    proc.stderr.write("  Ensure 'openshell' is installed and on PATH.\n");
  }

  // Last, so the partial trace is already on the wire: a turn whose deadline
  // fired must not exit 0 just because the transport did. An upstream non-zero
  // code is preserved as-is.
  if (code === 0 && isTimedOutAgentDispatch(stdout, stderr)) {
    writeTimedOutAgentTurnFailure(proc, sandboxName);
    return proc.exit(TIMED_OUT_AGENT_TURN_EXIT_CODE);
  }
  return proc.exit(code);
}

export interface AgentPassthroughOptions {
  extraArgs?: readonly string[];
}

export interface AgentPassthroughDeps {
  getSandbox?: typeof registry.getSandbox;
  resolveAgent?: typeof resolveLifecycleEligibleSandboxAgent;
  ensureLive?: typeof ensureLiveSandboxOrExit;
  exec?: typeof execSandbox;
  execJson?: typeof runAgentJsonPassthrough;
  execNonJson?: typeof runAgentNonJsonPassthrough;
  runOllamaRestartRecovery?: typeof runOllamaRestartRecovery;
  /** Exit only after the public command can unwind its sandbox lifecycle lock. */
  deferredLifecycleExit?: (code: number) => never;
  process?: {
    exit(code: number): never;
    stdout?: { write(s: string): unknown };
    stderr: { write(s: string): unknown };
  };
}

type RegistryReadResult =
  | { kind: "missing" }
  | {
      kind: "agent";
      agent: string | null;
      provider: string | null;
      model: string | null;
      endpointUrl: string | null;
      entry: registry.SandboxEntry;
    }
  | { kind: "error"; message: string };
type ResolvedRegistryReadResult = Exclude<RegistryReadResult, { kind: "error" }>;
type ManifestCommandResult =
  | { kind: "command"; argv: string[] }
  | { kind: "unsupported"; message: string };
type AgentPassthroughInvocation = {
  command: string[];
  stdinInput?: string;
  environment?: Readonly<Record<string, string>>;
  outputMode?: "direct" | "bounded-text" | "bounded-json";
  requestedTimeoutSeconds?: number | null;
  missingSelectors?: readonly string[];
  legacyOpenClaw?: boolean;
};
type FabricArgumentResult =
  | { kind: "native" }
  | { kind: "prompt"; prompt: string; jsonOutput: boolean }
  | { kind: "invalid" };

function readSandboxAgentFromRegistry(
  sandboxName: string,
  getSandbox: typeof registry.getSandbox = registry.getSandbox,
): RegistryReadResult {
  try {
    const sandbox = getSandbox(sandboxName);
    if (!sandbox) return { kind: "missing" };
    return {
      kind: "agent",
      agent: sandbox.agent ?? null,
      provider: sandbox.provider ?? null,
      model: sandbox.model ?? null,
      endpointUrl: sandbox.endpointUrl ?? null,
      entry: sandbox,
    };
  } catch (error) {
    return { kind: "error", message: (error as Error).message ?? String(error) };
  }
}

function rejectNonOpenclawAgent(
  sandboxName: string,
  agent: string,
  proc: NonNullable<AgentPassthroughDeps["process"]>,
): never {
  proc.stderr.write(
    `  The \`sandbox agent\` wrapper cannot dispatch to sandbox '${sandboxName}' because it runs '${agent}'.\n`,
  );
  const apiPort = resolveSandboxHermesApiPort(registry.getSandbox(sandboxName) ?? {});
  proc.stderr.write(
    `  Hermes exposes an OpenAI-compatible API on port ${apiPort} inside the sandbox;\n`,
  );
  proc.stderr.write(
    `  forward it with 'openshell forward start --background ${apiPort} ${sandboxName}'\n`,
  );
  proc.stderr.write(`  and POST to http://127.0.0.1:${apiPort}/v1/chat/completions instead.\n`);
  return proc.exit(2);
}

function rejectAgentResolutionError(
  sandboxName: string,
  agent: string,
  message: string,
  proc: NonNullable<AgentPassthroughDeps["process"]>,
): never {
  proc.stderr.write(
    `  Could not resolve a passthrough command for registered agent '${agent}' in sandbox '${sandboxName}'.\n`,
  );
  proc.stderr.write(`  Agent resolution error: ${message}\n`);
  proc.stderr.write("  Refusing to dispatch because the sandbox agent guard cannot fail closed.\n");
  return proc.exit(2);
}

function splitManifestCommand(command: string): ManifestCommandResult {
  const trimmed = command.trim();
  if (!trimmed) return { kind: "command", argv: [] };
  if (/["'\\]/.test(trimmed)) {
    return {
      kind: "unsupported",
      message:
        "runtime manifest commands must be simple whitespace-delimited argv tokens; quoted or escaped shell syntax is not supported",
    };
  }
  return { kind: "command", argv: trimmed.split(/\s+/).filter(Boolean) };
}

function getHeadlessPassthroughCommand(agent: AgentDefinition): ManifestCommandResult {
  const command = agent.runtime?.headless_command ?? agent.runtime?.interactive_command ?? "";
  return splitManifestCommand(command);
}

function getNativePassthroughCommand(agent: AgentDefinition): ManifestCommandResult {
  return splitManifestCommand(agent.runtime?.interactive_command ?? "");
}

function isPlainPromptInvocation(args: readonly string[]): boolean {
  return args.length > 0 && args.every((arg) => arg.trim().length > 0 && !arg.startsWith("-"));
}

function parseFabricPromptArguments(extraArgs: readonly string[]): FabricArgumentResult {
  const jsonCount = extraArgs.filter((argument) => argument === "--json").length;
  const jsonOutput = jsonCount === 1;
  const promptArguments = extraArgs.filter((argument) => argument !== "--json");
  if (promptArguments.length === 0) return { kind: "native" };

  if (promptArguments[0] === "-m" || promptArguments[0] === "--message") {
    if (jsonCount > 1 || promptArguments.length !== 2 || !promptArguments[1]?.trim()) {
      return { kind: "invalid" };
    }
    return { kind: "prompt", prompt: promptArguments[1], jsonOutput };
  }
  if (promptArguments[0]?.startsWith("--message=")) {
    const prompt = promptArguments[0].slice("--message=".length);
    return jsonCount <= 1 && promptArguments.length === 1 && prompt.trim()
      ? { kind: "prompt", prompt, jsonOutput }
      : { kind: "invalid" };
  }
  if (isPlainPromptInvocation(promptArguments)) {
    return jsonCount <= 1
      ? { kind: "prompt", prompt: promptArguments.join(" "), jsonOutput }
      : { kind: "invalid" };
  }

  // An option-first invocation belongs to the package's native CLI unless it
  // also contains the common message grammar in an invalid position. This
  // keeps native help and harness-specific options available without teaching
  // NemoClaw their grammar.
  if (promptArguments[0]?.startsWith("-")) {
    const containsMessageArgument = promptArguments.some(
      (argument) =>
        argument === "-m" || argument === "--message" || argument.startsWith("--message="),
    );
    return containsMessageArgument ? { kind: "invalid" } : { kind: "native" };
  }
  return { kind: "invalid" };
}

function rejectFabricInvocationArguments(
  sandboxName: string,
  proc: NonNullable<AgentPassthroughDeps["process"]>,
): never {
  proc.stderr.write(
    `  The package-managed Fabric command for sandbox '${sandboxName}' accepts one prompt as positional text or with -m/--message, plus optional --json.\n`,
  );
  proc.stderr.write(
    "  Refusing to place unrecognized request values in the sandbox process arguments.\n",
  );
  return proc.exit(2);
}

function buildManifestInvocation(
  sandboxName: string,
  agentName: string,
  headlessCommand: readonly string[],
  nativeCommand: ManifestCommandResult,
  promptTransport: "argv" | "stdin" | undefined,
  headlessEnvironment: Readonly<Record<string, string>> | undefined,
  extraArgs: readonly string[],
  proc: NonNullable<AgentPassthroughDeps["process"]>,
): AgentPassthroughInvocation {
  if (promptTransport !== "stdin") {
    return {
      command: [...headlessCommand, ...extraArgs],
      ...(headlessEnvironment ? { environment: headlessEnvironment } : {}),
    };
  }

  const fabricArguments = parseFabricPromptArguments(extraArgs);
  if (fabricArguments.kind === "invalid") {
    rejectFabricInvocationArguments(sandboxName, proc);
  }
  if (fabricArguments.kind === "prompt") {
    return {
      command: [
        ...headlessCommand,
        ...(headlessCommand.includes("--stdin") ? [] : ["--stdin"]),
        ...(fabricArguments.jsonOutput ? ["--json"] : []),
      ],
      stdinInput: fabricArguments.prompt,
      ...(headlessEnvironment ? { environment: headlessEnvironment } : {}),
    };
  }
  if (nativeCommand.kind === "unsupported") {
    rejectAgentResolutionError(sandboxName, agentName, nativeCommand.message, proc);
  }
  const command = nativeCommand.argv.length > 0 ? nativeCommand.argv : headlessCommand;
  return {
    command: [...command, ...extraArgs],
    ...(nativeCommand.argv.length === 0 && headlessEnvironment
      ? { environment: headlessEnvironment }
      : {}),
  };
}

function getPassthroughCommand(
  sandboxName: string,
  lookup: ResolvedRegistryReadResult,
  extraArgs: readonly string[],
  proc: NonNullable<AgentPassthroughDeps["process"]>,
  resolveAgent: typeof resolveLifecycleEligibleSandboxAgent,
): AgentPassthroughInvocation | null {
  if (lookup.kind === "missing") {
    if (hasAgentPassthroughHelpToken(extraArgs)) {
      printAgentPassthroughHelp();
      return null;
    }
    const legacyPlan = buildLegacyOpenClawCommandPlan(extraArgs);
    if (legacyPlan.kind === "help") return null;
    if (legacyPlan.kind === "missing-selector") {
      return {
        command: [...legacyPlan.argv],
        missingSelectors: legacyPlan.selectors,
        legacyOpenClaw: true,
      };
    }
    return {
      command: [...legacyPlan.argv],
      outputMode: legacyPlan.outputMode,
      requestedTimeoutSeconds: legacyPlan.requestedTimeoutSeconds,
      legacyOpenClaw: true,
    };
  }

  // Rendering the wrapper's OpenClaw help does not dispatch into a sandbox.
  // Keep that read-only path available for legacy registry rows that predate
  // package authority, while executable commands still resolve and validate
  // the sandbox's exact retained package below.
  if (isLegacyOpenClawSandbox(lookup.entry)) {
    const legacyPlan = buildLegacyOpenClawCommandPlan(extraArgs);
    if (legacyPlan.kind === "help") {
      printAgentPassthroughHelp();
      return null;
    }
    if (legacyPlan.kind === "missing-selector") {
      return {
        command: [...legacyPlan.argv],
        missingSelectors: legacyPlan.selectors,
        legacyOpenClaw: true,
      };
    }
    return {
      command: [...legacyPlan.argv],
      outputMode: legacyPlan.outputMode,
      requestedTimeoutSeconds: legacyPlan.requestedTimeoutSeconds,
      legacyOpenClaw: true,
    };
  }

  let authority: ReturnType<typeof resolveLifecycleEligibleSandboxAgent>;
  try {
    authority = resolveAgent(lookup.entry);
  } catch (error) {
    rejectAgentResolutionError(
      sandboxName,
      lookup.agent ?? "openclaw",
      (error as Error).message,
      proc,
    );
  }

  const agentName = authority.effectiveAgentId;
  const agent: AgentDefinition = authority.definition;
  if (
    lookup.entry.harnessPackage &&
    agent.runtime?.agent_command &&
    (!isPlainPromptInvocation(extraArgs) || !agent.runtime?.headless_command)
  ) {
    const plan = buildPackageAgentCommandPlan(agent.runtime.agent_command, extraArgs);
    if (plan.kind === "help") {
      printAgentPassthroughHelp();
      return null;
    }
    if (plan.kind === "missing-selector") {
      return { command: [...plan.argv], missingSelectors: plan.selectors };
    }
    return {
      command: [...plan.argv],
      outputMode: plan.outputMode,
      requestedTimeoutSeconds: plan.requestedTimeoutSeconds,
    };
  }

  const manifestCommand = isTerminalAgent(agent)
    ? getHeadlessPassthroughCommand(agent)
    : splitManifestCommand(agent.runtime?.headless_command ?? "");
  if (manifestCommand.kind === "unsupported") {
    rejectAgentResolutionError(sandboxName, agentName, manifestCommand.message, proc);
  }
  if (manifestCommand.argv.length === 0) {
    rejectNonOpenclawAgent(sandboxName, agentName, proc);
  }
  return buildManifestInvocation(
    sandboxName,
    agentName,
    manifestCommand.argv,
    getNativePassthroughCommand(agent),
    agent.runtime?.prompt_transport,
    agent.runtime?.headless_environment,
    extraArgs,
    proc,
  );
}

function rejectRegistryReadError(
  sandboxName: string,
  message: string,
  proc: NonNullable<AgentPassthroughDeps["process"]>,
): never {
  proc.stderr.write(
    `  Could not read the local sandbox registry to confirm agent type for '${sandboxName}'.\n`,
  );
  proc.stderr.write(`  Registry read error: ${message}\n`);
  proc.stderr.write(
    "  Refusing to forward to `openclaw agent` because the agent guard cannot fail closed.\n",
  );
  return proc.exit(2);
}

function rejectNoTargetSelector(
  proc: NonNullable<AgentPassthroughDeps["process"]>,
  selectors: readonly string[],
  legacyOpenClaw: boolean,
): never {
  const selectorList = selectors.map((selector) => `${selector} <value>`).join(", ");
  proc.stderr.write(
    legacyOpenClaw
      ? "  No target session selected. Use --agent <id>, --session-key <key>, --session-id <id>, or --to <E.164>.\n"
      : `  No target selected. Use one of the package-declared selectors: ${selectorList}.\n`,
  );
  if (legacyOpenClaw) {
    proc.stderr.write("  Run `openclaw agents list` inside the sandbox to see available agents.\n");
  }
  return proc.exit(2);
}

function rejectUnparseablePhase(
  sandboxName: string,
  proc: NonNullable<AgentPassthroughDeps["process"]>,
): never {
  proc.stderr.write(
    `  Could not parse a 'Phase:' line from the live state of sandbox '${sandboxName}'.\n`,
  );
  proc.stderr.write(
    "  Refusing to dispatch the agent command because the readiness guard cannot fail closed.\n",
  );
  proc.stderr.write(
    `  Run \`${CLI_NAME} ${sandboxName} status\` to inspect the gateway-state output.\n`,
  );
  return proc.exit(2);
}

function rejectNotReadyForAgent(
  sandboxName: string,
  phase: string,
  proc: NonNullable<AgentPassthroughDeps["process"]>,
): never {
  proc.stderr.write(
    `  Sandbox '${sandboxName}' is not ready for the agent wrapper (phase: ${phase}).\n`,
  );
  proc.stderr.write("  Documented recovery paths:\n");
  proc.stderr.write(
    `    ${CLI_NAME} ${sandboxName} recover         — gateway down, sandbox alive\n`,
  );
  proc.stderr.write(
    `    ${CLI_NAME} ${sandboxName} rebuild --yes   — recreate container, workspace preserved\n`,
  );
  proc.stderr.write(
    `    ${CLI_NAME} onboard --resume               — restore sandbox registration\n`,
  );
  return proc.exit(1);
}

export async function runAgentPassthrough(
  sandboxName: string,
  { extraArgs = [] }: AgentPassthroughOptions = {},
  deps: AgentPassthroughDeps = {},
): Promise<void> {
  const proc = deps.process ?? process;
  const lookup = readSandboxAgentFromRegistry(sandboxName, deps.getSandbox);
  if (lookup.kind === "error") {
    rejectRegistryReadError(sandboxName, lookup.message, proc);
  }
  const invocation = getPassthroughCommand(
    sandboxName,
    lookup,
    extraArgs,
    proc,
    deps.resolveAgent ?? resolveLifecycleEligibleSandboxAgent,
  );
  if (!invocation) return;
  const { command } = invocation;
  const ensureLive = deps.ensureLive ?? ensureLiveSandboxOrExit;
  const state = await ensureLive(sandboxName, {
    allowNonReadyPhase: true,
    ...(deps.deferredLifecycleExit ? { exit: deps.deferredLifecycleExit } : {}),
  });
  const phase = state?.phase ?? null;
  if (!phase) {
    rejectUnparseablePhase(sandboxName, proc);
  }
  if (phase !== "Ready" && phase !== "Running") {
    rejectNotReadyForAgent(sandboxName, phase, proc);
  }
  if (invocation.missingSelectors) {
    rejectNoTargetSelector(proc, invocation.missingSelectors, invocation.legacyOpenClaw ?? false);
  }
  if (
    invocation.outputMode !== undefined &&
    invocation.outputMode !== "direct" &&
    lookup.kind === "agent" &&
    lookup.provider === OLLAMA_LOCAL_PROVIDER
  ) {
    const recoverOllama = deps.runOllamaRestartRecovery ?? runOllamaRestartRecovery;
    recoverOllama(lookup, proc);
  }
  const timeoutSeconds = agentDispatchDeadlineFromRequest(
    invocation.requestedTimeoutSeconds ?? null,
  );
  if (invocation.outputMode === "bounded-json") {
    const passthroughProcess = {
      exit: proc.exit.bind(proc),
      stdout: proc.stdout ?? process.stdout,
      stderr: proc.stderr,
    } satisfies AgentJsonPassthroughProcess;
    if (deps.execJson) {
      await deps.execJson(sandboxName, command, passthroughProcess);
    } else {
      await runAgentJsonPassthrough(sandboxName, command, passthroughProcess, { timeoutSeconds });
    }
    return;
  }
  if (invocation.outputMode === "bounded-text") {
    if (deps.execNonJson) {
      await deps.execNonJson(sandboxName, command, proc);
    } else {
      await runAgentNonJsonPassthrough(sandboxName, command, proc, { timeoutSeconds });
    }
    return;
  }
  const exec = deps.exec ?? execSandbox;
  const execOptions = {
    tty: false,
    ...(invocation.stdinInput !== undefined ? { stdinInput: invocation.stdinInput } : {}),
    ...(invocation.environment ? { environment: invocation.environment } : {}),
  };
  if (deps.deferredLifecycleExit) {
    // The public command supplies a deferred process facade. Forward its exit
    // callback through execSandbox instead of falling back to process.exit.
    await exec(sandboxName, command, execOptions, {
      exit: deps.deferredLifecycleExit,
    });
    return;
  }
  await exec(sandboxName, command, execOptions);
}
