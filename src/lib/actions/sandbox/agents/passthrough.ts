// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { CLI_NAME } from "../../../cli/branding";
import {
  deferSandboxLifecycleExit,
  runWithDeferredSandboxLifecycleExit,
} from "../../../core/process-exit";
import { execSandbox } from "../exec";
import {
  confirmAgentRosterCommandAuthority,
  ensureLiveAgentRosterSandbox,
  resolveAgentRosterCommandAuthority,
  withAgentRosterCommandLock,
} from "./command-authority";
import { runLegacyAgentsPassthrough } from "./legacy-roster";

export type AgentsPassthroughVerb = "add" | "delete" | "list";

export interface AgentsPassthroughOptions {
  verb: AgentsPassthroughVerb;
  extraArgs?: readonly string[];
}

export function hasAgentsPassthroughHelpToken(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === "--") break;
    if (arg === "--help" || arg === "-h") return true;
  }
  return false;
}

export function printAgentsPassthroughHelp(verb: AgentsPassthroughVerb): void {
  const flagsToken = `harness-agents-${verb}-flags`;
  console.log("");
  console.log(`  Usage: ${CLI_NAME} <name> agents ${verb} [${flagsToken}...]`);
  console.log("");
  console.log(`  Pass through to the installed harness's native agent roster ${verb} command.`);
  console.log("  All additional arguments are forwarded through its typed package adapter.");
  console.log("");
}

export function printAgentsParentHelp(): void {
  console.log("");
  console.log(`  Usage: ${CLI_NAME} <name> agents <subcommand> [harness-agents-flags...]`);
  console.log("");
  console.log("  Manage the installed harness's agent roster. The parent command itself has no");
  console.log(
    "  runnable default; pick one of the subcommands below or pass `--help` for details.",
  );
  console.log("");
  console.log("  Subcommands:");
  console.log("    add       Add an agent through the installed harness.");
  console.log("    apply     Reconcile the sandbox roster against an agents.yaml manifest.");
  console.log("    delete    Delete an agent through the installed harness.");
  console.log("    list      List agents configured by the installed harness.");
  console.log("");
}

export async function runAgentsPassthrough(
  sandboxName: string,
  { verb, extraArgs = [] }: AgentsPassthroughOptions,
): Promise<void> {
  return runWithDeferredSandboxLifecycleExit(async () => {
    const operation = async (): Promise<void> => {
      const authority = resolveAgentRosterCommandAuthority(sandboxName);
      if (authority.kind === "legacy") {
        await runLegacyAgentsPassthrough(sandboxName, verb, extraArgs);
        return;
      }
      if (authority.kind === "unsupported") {
        console.error(`  Agent roster unavailable: ${authority.reason}`);
        deferSandboxLifecycleExit(1);
      }

      const request = { operation: verb, arguments: extraArgs } as const;
      let plan: ReturnType<typeof authority.adapter.buildAgentRosterCommand>;
      try {
        plan = authority.adapter.buildAgentRosterCommand(request);
      } catch (error) {
        console.error(
          `  The installed harness could not build an agent roster command: ${error instanceof Error ? error.message : String(error)}`,
        );
        deferSandboxLifecycleExit(1);
      }
      if (plan.kind === "unsupported") {
        console.error(`  Agent roster unavailable: ${plan.reason}`);
        deferSandboxLifecycleExit(1);
      }

      await ensureLiveAgentRosterSandbox(sandboxName, {
        allowNonReadyPhase: true,
        exit: deferSandboxLifecycleExit,
      });
      if (verb !== "list") {
        const currentAdapter = confirmAgentRosterCommandAuthority(sandboxName, authority.identity);
        const currentPlan = currentAdapter.buildAgentRosterCommand(request);
        if (!isDeepStrictEqual(currentPlan, plan)) {
          console.error("  The installed harness agent roster command changed before mutation.");
          deferSandboxLifecycleExit(1);
        }
      }
      await execSandbox(sandboxName, plan.command, {}, { exit: deferSandboxLifecycleExit });
    };

    if (verb === "list") return operation();
    return withAgentRosterCommandLock(sandboxName, operation);
  });
}
