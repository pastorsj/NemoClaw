// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Host-side write path for the agent-facing policy context file. The
 * shell command construction (payload encoding, atomic mv replacement,
 * symlink resistance) and the failure-routing contract are pinned by the
 * unit tests in this directory. The cross-boundary runtime behaviour —
 * the file actually appearing inside the sandbox with the expected mode,
 * symlinks at the target being replaced rather than followed, and the
 * refresh firing only after a successful policy mutation — is exercised
 * end-to-end by the `network-policy-e2e` and `channels-add-remove-e2e`
 * jobs under `test/e2e/`, which spin up a real OpenShell sandbox and run
 * the full `policy-add`/`policy-remove`/`rebuild` flow. The unit
 * harness intentionally stays inside the JS process; runtime regressions
 * surface in those e2e jobs before merge.
 */

import {
  buildPolicyContext,
  type PolicyContext,
  renderPolicyContextMarkdown,
} from "../../policy/context";
import {
  captureSandboxCommandAgentAuthority,
  readSandboxCommandAgentEntry,
  requireCurrentSandboxCommandAgentAuthority,
  type SandboxCommandAgentAuthority,
} from "../../sandbox/command-agent";
import { shellQuote } from "../../shared/shell-quote";
import type { SandboxEntry } from "../../state/registry";
import { LEGACY_POLICY_CONTEXT_SANDBOX_PATH } from "./legacy/policy-context";

/** Compatibility export for callers that report the historical no-receipt target. */
export const POLICY_CONTEXT_SANDBOX_PATH = LEGACY_POLICY_CONTEXT_SANDBOX_PATH;

export type SandboxExec = (
  sandboxName: string,
  command: string,
) => { status: number; stdout: string; stderr: string } | null;

export interface ExplainPolicyOptions {
  json?: boolean;
  writeToSandbox?: boolean;
}

export interface ExplainPolicyDeps {
  build?: (sandboxName: string) => PolicyContext;
  render?: (ctx: PolicyContext) => string;
  log?: (line: string) => void;
  logJson?: (value: unknown) => void;
  exec?: SandboxExec;
  warn?: (line: string) => void;
  resolveTarget?: (sandboxName: string) => PolicyContextWriteTarget | null;
}

export interface PolicyContextWriteTarget {
  readonly targetPath: string;
  readonly assertCurrentAuthority?: () => void;
}

export interface PolicyContextTargetDependencies {
  readonly getSandbox: (sandboxName: string) => SandboxEntry | null;
  readonly captureAuthority: (entry: SandboxEntry) => SandboxCommandAgentAuthority;
  readonly requireCurrentAuthority: (
    expected: SandboxCommandAgentAuthority,
    currentEntry: SandboxEntry | null,
  ) => SandboxCommandAgentAuthority;
}

const DEFAULT_TARGET_DEPENDENCIES: PolicyContextTargetDependencies = {
  getSandbox: readSandboxCommandAgentEntry,
  captureAuthority: captureSandboxCommandAgentAuthority,
  requireCurrentAuthority: requireCurrentSandboxCommandAgentAuthority,
};

/** Resolve a package-declared policy context target, with explicit no-receipt compatibility. */
export function resolvePolicyContextWriteTarget(
  sandboxName: string,
  dependencies: PolicyContextTargetDependencies = DEFAULT_TARGET_DEPENDENCIES,
): PolicyContextWriteTarget | null {
  const entry = dependencies.getSandbox(sandboxName);
  if (entry?.harnessPackageMigration && !entry.harnessPackage) {
    throw new Error("sandbox package migration has no current package receipt");
  }
  if (!entry?.harnessPackage) {
    return Object.freeze({ targetPath: LEGACY_POLICY_CONTEXT_SANDBOX_PATH });
  }
  const authority = dependencies.captureAuthority(entry);
  const targetPath = authority.definition.policyCapability.context_target;
  if (!targetPath) return null;
  return Object.freeze({
    targetPath,
    assertCurrentAuthority: () => {
      dependencies.requireCurrentAuthority(authority, dependencies.getSandbox(sandboxName));
    },
  });
}

export interface WritePolicyContextResult {
  written: boolean;
  reason?: string;
  /**
   * Set to `unexpected-loader` when the executor loader caught an
   * import/resolve error (cycle, missing module, process-recovery
   * regression). Callers use this to distinguish a legitimate
   * `sandbox unreachable` from a code regression that needs surfacing.
   */
  failure?:
    | "loader-vitest"
    | "no-runtime"
    | "unexpected-loader"
    | "unsupported"
    | "authority-invalid"
    | "sandbox-unreachable"
    | "exec-failed";
  /** Error captured by the loader, if any. */
  errorMessage?: string;
  /** Exact package-declared destination used for the attempted write. */
  targetPath?: string;
}

type ExecutorLoad =
  | { kind: "ok"; exec: SandboxExec }
  | { kind: "vitest" }
  | { kind: "no-runtime" }
  | { kind: "crashed"; error: Error };

/**
 * Lazy executor loader. The seed runs from policy mutation hooks and from
 * the onboard policy step, both of which can be called from contexts that
 * have no OpenShell binary (unit tests, host-side dev shells before the
 * runtime is installed). The loader returns a tagged union so callers can
 * distinguish three expected boundary conditions from a regression:
 *
 * - `vitest`: `process.env.VITEST === "true"`. Tests never spawn
 *   OpenShell. The seed is silently inert in the test process without
 *   requiring every consumer test to mock {@link writePolicyContextToSandbox}.
 * - `no-runtime`: `resolveOpenshell()` returned null (no binary on PATH,
 *   stale path, X_OK fail). The sandbox surface genuinely cannot spawn
 *   OpenShell; treat as `sandbox unreachable` and warn at most once per
 *   call site at the caller's discretion.
 * - `crashed`: require/resolve threw. Either an import cycle, a missing
 *   module, or a process-recovery regression. Callers must route this
 *   through the refresh helper's `unexpected` sink so a code regression
 *   is not silently treated as `sandbox unreachable`.
 *
 * Once the loader returns `ok`, ownership of the actual subprocess call
 * lives in `process-recovery`'s {@link executeSandboxCommand}, which is
 * the single source of truth for sandbox SSH spawning. This function
 * does not invent a parallel spawn pipeline.
 */
function loadExecutor(): ExecutorLoad {
  if (process.env.VITEST === "true") return { kind: "vitest" };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const resolve = require("../../adapters/openshell/resolve") as {
      resolveOpenshell?: () => string | null;
    };
    const resolved = resolve.resolveOpenshell ? resolve.resolveOpenshell() : null;
    if (!resolved) return { kind: "no-runtime" };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const recovery = require("./process-recovery") as {
      executeSandboxCommand: SandboxExec;
    };
    return { kind: "ok", exec: recovery.executeSandboxCommand };
  } catch (error: unknown) {
    return {
      kind: "crashed",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Render the in-sandbox write command. Four explicit safety guarantees:
 *
 * - The markdown payload is base64-encoded before it is interpolated into
 *   the shell string, so anything in the rendered context — quotes,
 *   semicolons, backticks, command substitutions, redirections, newlines —
 *   reaches `base64 -d` as inert data rather than the parent shell. The
 *   hostile-markdown negative test in policy-explain.test.ts guards this.
 * - The destination is a contract-validated package path and every path
 *   token is shell-quoted before interpolation. No user-provided path reaches
 *   this helper.
 * - The intermediate `mkdir -p` and `chmod 0644` use that same validated
 *   destination. The parent directory is derived only after validation.
 * - The payload is first written to a freshly-created sibling temp file
 *   with restrictive permissions (umask 077 + mktemp template), then
 *   atomically replaces the target via `mv -fT`. Replacement uses the
 *   `rename(2)` semantics, which acts on the link itself rather than the
 *   target of a symlink, so an in-sandbox attacker who pre-created
 *   POLICY.md as a symlink cannot redirect the policy-context write into
 *   another file reachable from the sandbox user. `mv -fT` additionally
 *   refuses to descend into a directory pre-staged at the target path.
 */
function buildWriteCommand(markdown: string, targetPath: string): string {
  const encoded = Buffer.from(markdown, "utf-8").toString("base64");
  const dir = targetPath.replace(/\/[^/]+$/, "") || "/";
  const quotedDirectory = shellQuote(dir);
  const quotedTemplate = shellQuote(`${dir}/.POLICY.md.XXXXXX`);
  const quotedTarget = shellQuote(targetPath);
  return [
    `mkdir -p -- ${quotedDirectory}`,
    "umask 077",
    `__pm_tmp=$(mktemp ${quotedTemplate})`,
    `printf '%s' '${encoded}' | base64 -d > "$__pm_tmp"`,
    `chmod 0644 "$__pm_tmp"`,
    `mv -fT -- "$__pm_tmp" ${quotedTarget}`,
  ].join(" && ");
}

export function writePolicyContextToSandbox(
  sandboxName: string,
  deps: ExplainPolicyDeps = {},
): WritePolicyContextResult {
  const build = deps.build ?? buildPolicyContext;
  const render = deps.render ?? renderPolicyContextMarkdown;
  const resolveTarget = deps.resolveTarget ?? resolvePolicyContextWriteTarget;
  let target: PolicyContextWriteTarget | null;
  try {
    target = resolveTarget(sandboxName);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      written: false,
      reason: `policy-context package authority is invalid: ${message}`,
      failure: "authority-invalid",
      errorMessage: message,
    };
  }
  if (!target) {
    return {
      written: false,
      reason: "the selected harness package does not declare a policy context target",
      failure: "unsupported",
    };
  }
  let exec: SandboxExec | undefined = deps.exec;
  if (!exec) {
    const load = loadExecutor();
    if (load.kind === "vitest") {
      return { written: false, reason: "sandbox unreachable", failure: "loader-vitest" };
    }
    if (load.kind === "no-runtime") {
      return { written: false, reason: "sandbox unreachable", failure: "no-runtime" };
    }
    if (load.kind === "crashed") {
      return {
        written: false,
        reason: `policy-context executor failed to load: ${load.error.message}`,
        failure: "unexpected-loader",
        errorMessage: load.error.message,
      };
    }
    exec = load.exec;
  }
  const ctx = build(sandboxName);
  const markdown = render(ctx);
  const command = buildWriteCommand(markdown, target.targetPath);
  try {
    target.assertCurrentAuthority?.();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      written: false,
      reason: `policy-context package authority changed: ${message}`,
      failure: "authority-invalid",
      errorMessage: message,
      targetPath: target.targetPath,
    };
  }
  const result = exec(sandboxName, command);
  if (result === null) {
    return {
      written: false,
      reason: "sandbox unreachable",
      failure: "sandbox-unreachable",
      targetPath: target.targetPath,
    };
  }
  if (result.status !== 0) {
    return {
      written: false,
      reason: `write failed (status ${String(result.status)}): ${result.stderr || "(no stderr)"}`,
      failure: "exec-failed",
      targetPath: target.targetPath,
    };
  }
  return { written: true, targetPath: target.targetPath };
}

export function explainSandboxPolicy(
  sandboxName: string,
  options: ExplainPolicyOptions = {},
  deps: ExplainPolicyDeps = {},
): PolicyContext {
  const build = deps.build ?? buildPolicyContext;
  const render = deps.render ?? renderPolicyContextMarkdown;
  const log = deps.log ?? ((line: string) => console.log(line));
  const logJson = deps.logJson ?? ((value: unknown) => console.log(JSON.stringify(value, null, 2)));
  const warn = deps.warn ?? ((line: string) => console.error(line));
  const ctx = build(sandboxName);
  if (options.json) {
    logJson(ctx);
  } else {
    log(render(ctx));
  }
  if (options.writeToSandbox) {
    const writeResult = writePolicyContextToSandbox(sandboxName, { ...deps, build, render });
    if (!writeResult.written) {
      const detail = writeResult.reason ?? "unknown reason";
      const destination = writeResult.targetPath ?? "the harness policy context file";
      warn(`  Could not seed ${destination}: ${detail}.`);
    }
  }
  return ctx;
}
