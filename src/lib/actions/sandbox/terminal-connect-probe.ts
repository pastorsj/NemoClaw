// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { captureOpenshell } from "../../adapters/openshell/runtime";
import type { AgentDefinition } from "../../agent/defs";
import * as agentRuntime from "../../agent/runtime";
import { runAgentSmokeCommands } from "../../agent-runtime/runtime/terminal-smoke";
import { redact } from "../../runner";

export type EnsureTerminalInferenceRoute = (
  sandboxName: string,
  options: { quiet: true },
) => { routeHealthy: boolean | null };

export function runTerminalAgentConnectProbe({
  agent,
  agentName,
  capture,
  ensureInferenceRoute,
  sandboxName,
}: {
  agent: AgentDefinition;
  agentName: string;
  capture: typeof captureOpenshell;
  ensureInferenceRoute: EnsureTerminalInferenceRoute;
  sandboxName: string;
}): void {
  const routeResult = ensureInferenceRoute(sandboxName, { quiet: true });
  // A package can declare that its configured inference.local route is itself
  // part of terminal readiness. The route implementation remains core-owned;
  // the manifest only selects whether an explicit negative result is fatal.
  //
  // routeHealthy tri-state: `true` = route probe ran and succeeded,
  // `false` = route probe ran and explicitly failed (broken managed proxy),
  // `null` = probe was not run or was indeterminate. Only an explicit `false`
  // from a required probe short-circuits the connect flow — `null` falls
  // through to the smoke command so other agents (and runs where
  // the probe genuinely could not be executed) are not spuriously blocked.
  if (
    agent.inference?.route_probe?.terminal_connect === "required" &&
    routeResult.routeHealthy === false
  ) {
    console.error(
      `  Probe failed: ${agentName} could not reach the managed inference.local route in '${sandboxName}'.`,
    );
    process.exit(1);
  }
  const smokeResult = runAgentSmokeCommands(sandboxName, agent, capture);
  if (!smokeResult.ok) {
    console.error(
      `  Probe failed: ${agentName} terminal smoke command failed: ${smokeResult.command}`,
    );
    if (smokeResult.output) {
      console.error(`    ${String(redact(smokeResult.output)).slice(0, 500)}`);
    }
    process.exit(1);
  }
  const command = agentRuntime.getTerminalCommand(agent);
  const commandText = command ? ` (${command})` : "";
  console.log(`  Probe complete: ${agentName} terminal smoke checks passed${commandText}.`);
}
