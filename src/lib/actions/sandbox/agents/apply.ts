// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import type {
  HarnessAgentRosterApplyPlan,
  HarnessAgentRosterJsonObject,
} from "@nvidia/nemoclaw-harness-contract";

import {
  deferSandboxLifecycleExit,
  runWithDeferredSandboxLifecycleExit,
} from "../../../core/process-exit";
import { loadAgentsManifest } from "../../../onboard/agents-manifest";
import { buildOpenshellExecArgs, computeExitCode, execSandbox } from "../exec";
import { redactAgentDiagnostic } from "../agent/diagnostic";
import {
  confirmAgentRosterCommandAuthority,
  ensureLiveAgentRosterSandbox,
  resolveAgentRosterCommandAuthority,
  type AgentRosterPackageAuthority,
  withAgentRosterCommandLock,
} from "./command-authority";
import { runLegacyAgentsApply } from "./legacy-roster";
import { captureOpenshell } from "./openshell";

const AGENT_ROSTER_CAPTURE_MAX_BYTES = 63 * 1024 * 1024;

export interface RunAgentsApplyOptions {
  readonly sandboxName: string;
  readonly manifestPath: string;
  readonly yes?: boolean;
  readonly nonInteractive?: boolean;
}

export interface RunAgentsApplyDependencies {
  readonly log?: (message: string) => void;
  readonly exit?: (code: number) => never;
}

function stopAgentsApply(log: (message: string) => void, message: string, code = 1): never {
  log(`  ${message}`);
  deferSandboxLifecycleExit(code);
}

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

function captureCurrentRoster(
  sandboxName: string,
  command: readonly string[],
  log: (message: string) => void,
): string {
  const result = captureOpenshell(buildOpenshellExecArgs(sandboxName, command), {
    ignoreError: true,
    includeStderr: true,
    includeStreams: true,
    maxBuffer: AGENT_ROSTER_CAPTURE_MAX_BYTES,
  });
  const { code, errorMessage } = computeExitCode(result);
  if (code === 0) return capturedStdout(result);

  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS") {
    stopAgentsApply(log, "Agent roster output exceeded NemoClaw's 63 MiB capture boundary.");
  }
  const diagnostic = redactAgentDiagnostic(capturedDiagnostics(result));
  if (diagnostic) log(`  ${diagnostic}`);
  if (errorMessage) log(`  Failed to invoke openshell: ${errorMessage}`);
  return stopAgentsApply(
    log,
    `The installed harness agent roster inspection failed with exit ${String(code)}.`,
    code || 1,
  );
}

function buildApplyPlan(
  authority: AgentRosterPackageAuthority,
  manifest: HarnessAgentRosterJsonObject,
  currentOutput: string,
  log: (message: string) => void,
): HarnessAgentRosterApplyPlan {
  try {
    return authority.adapter.buildAgentRosterApplyPlan({
      manifest,
      current_output: currentOutput,
    });
  } catch (error) {
    return stopAgentsApply(
      log,
      `The installed harness could not build an agent roster apply plan: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function renderApplyPlan(
  plan: Extract<HarnessAgentRosterApplyPlan, { readonly kind: "ready" }>,
  options: RunAgentsApplyOptions,
  log: (message: string) => void,
): void {
  log(`  Sandbox: ${options.sandboxName}`);
  log(`  Manifest: ${options.manifestPath}`);
  log(
    `  Plan: ${String(plan.additions.length)} agent(s) to add, ${String(plan.deletions.length)} to delete, ${String(plan.current_count)} currently present.`,
  );
  plan.additions.forEach((entry) => log(`    + ${entry.agent_id}`));
  plan.deletions.forEach((entry) => log(`    - ${entry.agent_id}`));
  if (plan.rebuild_only_fields.length > 0) {
    log("");
    log("  ⚠  The following manifest fields require a sandbox rebuild and are not applied here:");
    plan.rebuild_only_fields.forEach((field) => log(`     - ${field}`));
    log("  Run `nemoclaw onboard --agents <file> --recreate-sandbox` to bake those fields.");
  }
  plan.notices.forEach((notice) => log(`  ⚠  ${notice.message}`));
}

function confirmUnchangedApplyPlan(
  authority: AgentRosterPackageAuthority,
  sandboxName: string,
  manifest: HarnessAgentRosterJsonObject,
  currentOutput: string,
  expectedPlan: HarnessAgentRosterApplyPlan,
  log: (message: string) => void,
): void {
  const currentAdapter = confirmAgentRosterCommandAuthority(sandboxName, authority.identity);
  const currentPlan = currentAdapter.buildAgentRosterApplyPlan({
    manifest,
    current_output: currentOutput,
  });
  if (!isDeepStrictEqual(currentPlan, expectedPlan)) {
    stopAgentsApply(log, "The installed harness agent roster plan changed before mutation.");
  }
}

async function applyPackageRoster(
  authority: AgentRosterPackageAuthority,
  options: RunAgentsApplyOptions,
  log: (message: string) => void,
): Promise<void> {
  const manifest = loadAgentsManifest(options.manifestPath);
  let inspection: ReturnType<typeof authority.adapter.buildAgentRosterInspection>;
  try {
    inspection = authority.adapter.buildAgentRosterInspection({ manifest });
  } catch (error) {
    return stopAgentsApply(
      log,
      `The installed harness could not inspect the agent roster manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (inspection.kind === "refused") {
    return stopAgentsApply(log, `Manifest rejected before mutation: ${inspection.reason}`);
  }

  await ensureLiveAgentRosterSandbox(options.sandboxName, {
    allowNonReadyPhase: false,
    exit: deferSandboxLifecycleExit,
  });
  const currentOutput = captureCurrentRoster(options.sandboxName, inspection.command, log);
  const plan = buildApplyPlan(authority, manifest, currentOutput, log);
  if (plan.kind === "refused") {
    return stopAgentsApply(log, `Manifest rejected before mutation: ${plan.reason}`);
  }
  renderApplyPlan(plan, options, log);

  if (plan.additions.length === 0 && plan.deletions.length === 0) {
    log("  No roster changes to apply.");
    return;
  }
  if (!options.yes && options.nonInteractive) {
    return stopAgentsApply(log, "Pass --yes to apply roster changes in non-interactive mode.");
  }
  if (!options.yes) {
    return stopAgentsApply(log, "Pass --yes to confirm the roster changes above.", 2);
  }

  for (const mutation of plan.deletions) {
    confirmUnchangedApplyPlan(authority, options.sandboxName, manifest, currentOutput, plan, log);
    log(`  Deleting agent: ${mutation.agent_id}`);
    await execSandbox(
      options.sandboxName,
      mutation.command,
      {},
      {
        exit: deferSandboxLifecycleExit,
      },
    );
  }
  for (const mutation of plan.additions) {
    confirmUnchangedApplyPlan(authority, options.sandboxName, manifest, currentOutput, plan, log);
    log(`  Adding agent: ${mutation.agent_id}`);
    await execSandbox(
      options.sandboxName,
      mutation.command,
      {},
      {
        exit: deferSandboxLifecycleExit,
      },
    );
  }
  log("  Apply complete.");
}

/** Reconcile a roster through a receipt-pinned package or the explicit pre-receipt path. */
export async function runAgentsApply(
  options: RunAgentsApplyOptions,
  dependencies: RunAgentsApplyDependencies = {},
): Promise<void> {
  const log = dependencies.log ?? ((message: string) => console.log(message));
  const exit = dependencies.exit ?? ((code: number) => process.exit(code));
  return runWithDeferredSandboxLifecycleExit(
    () =>
      withAgentRosterCommandLock(options.sandboxName, async () => {
        const authority = resolveAgentRosterCommandAuthority(options.sandboxName);
        if (authority.kind === "legacy") {
          return runLegacyAgentsApply(options, { log, exit: deferSandboxLifecycleExit });
        }
        if (authority.kind === "unsupported") {
          return stopAgentsApply(log, `Agent roster unavailable: ${authority.reason}`);
        }
        return applyPackageRoster(authority, options, log);
      }),
    exit,
  );
}
