// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import type {
  HarnessSessionMutationOutput,
  HarnessSessionMutationPlan,
  HarnessSessionMutationPlanRequest,
} from "../../../agent-runtime/session-module";
import {
  deferSandboxLifecycleExit,
  runWithDeferredSandboxLifecycleExit,
} from "../../../core/process-exit";
import { assertHermesPortableCommandUnavailable } from "../../../onboard/experimental/portable-agent-lifecycle";
import { withMcpLifecycleLock } from "../../../state/mcp-lifecycle-lock-acquisition";
import { execSandbox } from "../exec";
import { ensureLiveSandboxOrExit } from "../gateway-state";
import { callOpenclawGateway } from "./gateway-rpc";
import { resetLegacySandboxSession } from "./legacy-reset";
import {
  confirmSessionPackageAuthority,
  resolveSessionPackageAuthority,
  type SessionPackageAuthority,
} from "./package-authority";

export type SessionsResetReason = "reset" | "new";

export interface SessionsResetOptions {
  readonly key: string;
  readonly agent?: string;
  readonly reason?: SessionsResetReason;
  readonly json?: boolean;
  readonly verbose?: boolean;
}

export interface SessionsResetResult {
  readonly key: string;
  readonly reason: SessionsResetReason;
  readonly entry?: unknown;
}

function stopSessionReset(message: string): never {
  console.error(`  ${message}`);
  deferSandboxLifecycleExit(1);
}

function buildResetRequest(
  options: SessionsResetOptions,
): Extract<HarnessSessionMutationPlanRequest, { readonly operation: "reset" }> {
  return {
    operation: "reset",
    key: options.key,
    agent: options.agent ?? null,
    reason: options.reason === "new" ? "new" : "reset",
    jsonOutput: options.json === true,
    verboseOutput: options.verbose === true,
  };
}

function buildSessionResetPlan(
  authority: SessionPackageAuthority,
  request: Extract<HarnessSessionMutationPlanRequest, { readonly operation: "reset" }>,
): HarnessSessionMutationPlan {
  try {
    return authority.adapter.buildSessionMutationPlan(request);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return stopSessionReset(
      `The installed harness could not build a session-reset plan: ${detail}`,
    );
  }
}

function confirmSessionResetPlan(
  sandboxName: string,
  authority: SessionPackageAuthority,
  request: Extract<HarnessSessionMutationPlanRequest, { readonly operation: "reset" }>,
  expectedPlan: HarnessSessionMutationPlan,
) {
  const currentAdapter = confirmSessionPackageAuthority(sandboxName, authority.identity);
  let currentPlan: HarnessSessionMutationPlan;
  try {
    currentPlan = currentAdapter.buildSessionMutationPlan(request);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return stopSessionReset(`The installed harness session-reset plan changed: ${detail}`);
  }
  if (!isDeepStrictEqual(currentPlan, expectedPlan)) {
    stopSessionReset("The installed harness session-reset plan changed before mutation.");
  }
  return currentAdapter;
}

function renderSessionResetResult(
  result: Extract<
    HarnessSessionMutationOutput,
    { readonly kind: "completed"; readonly operation: "reset" }
  >,
  options: SessionsResetOptions,
): SessionsResetResult {
  if (options.json) {
    console.log(JSON.stringify({ key: result.key, reason: result.reason, entry: result.entry }));
  } else {
    const verb = result.reason === "new" ? "Replaced" : "Reset";
    console.error(`  ${verb} session '${result.key}' via the installed harness.`);
    if (options.verbose && result.entry !== null) {
      console.error(`  entry: ${JSON.stringify(result.entry)}`);
    }
  }
  return {
    key: result.key,
    reason: result.reason,
    ...(result.entry === null ? {} : { entry: result.entry }),
  };
}

export async function resetSandboxSession(
  sandboxName: string,
  options: SessionsResetOptions,
): Promise<SessionsResetResult> {
  const authority = resolveSessionPackageAuthority(sandboxName);
  if (authority === null) return resetLegacySandboxSession(sandboxName, options);

  return runWithDeferredSandboxLifecycleExit(() =>
    withMcpLifecycleLock(sandboxName, async () => {
      assertHermesPortableCommandUnavailable(sandboxName, "sandbox:sessions:reset");
      const request = buildResetRequest(options);
      const plan = buildSessionResetPlan(authority, request);
      if (plan.kind === "unsupported" || plan.kind === "refused") {
        return stopSessionReset(plan.reason);
      }

      await ensureLiveSandboxOrExit(sandboxName, {
        allowNonReadyPhase: true,
        exit: deferSandboxLifecycleExit,
      });
      const currentAdapter = confirmSessionResetPlan(sandboxName, authority, request, plan);
      if (plan.kind === "stream") {
        await execSandbox(sandboxName, plan.command, {}, { exit: deferSandboxLifecycleExit });
        throw new Error("unreachable: streamed session reset terminated the process");
      }
      const { payload } = callOpenclawGateway({
        sandboxName,
        method: plan.method,
        params: plan.params,
        exit: deferSandboxLifecycleExit,
      });
      let interpreted: HarnessSessionMutationOutput;
      try {
        interpreted = currentAdapter.interpretSessionMutationOutput({
          request,
          plan,
          payload: payload as unknown as Record<string, never>,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return stopSessionReset(
          `The installed harness could not interpret session-reset output: ${detail}`,
        );
      }
      if (interpreted.kind === "refused") stopSessionReset(interpreted.reason);
      if (interpreted.operation !== "reset") {
        return stopSessionReset("The installed harness returned a non-reset session result.");
      }
      return renderSessionResetResult(interpreted, options);
    }),
  );
}
