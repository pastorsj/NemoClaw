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
import { deleteLegacySandboxSession } from "./legacy-delete";
import {
  confirmSessionPackageAuthority,
  resolveSessionPackageAuthority,
  type SessionPackageAuthority,
} from "./package-authority";

export interface SessionsDeleteOptions {
  readonly key: string;
  readonly agent?: string;
  readonly keepTranscript?: boolean;
  readonly json?: boolean;
  readonly verbose?: boolean;
}

export interface SessionsDeleteResult {
  readonly key: string;
  readonly removedTranscript: boolean;
  readonly entry?: unknown;
}

function stopSessionDelete(message: string): never {
  console.error(`  ${message}`);
  deferSandboxLifecycleExit(1);
}

function buildDeleteRequest(
  options: SessionsDeleteOptions,
): Extract<HarnessSessionMutationPlanRequest, { readonly operation: "delete" }> {
  return {
    operation: "delete",
    key: options.key,
    agent: options.agent ?? null,
    keepTranscript: options.keepTranscript === true,
    jsonOutput: options.json === true,
    verboseOutput: options.verbose === true,
  };
}

function buildSessionDeletePlan(
  authority: SessionPackageAuthority,
  request: Extract<HarnessSessionMutationPlanRequest, { readonly operation: "delete" }>,
): HarnessSessionMutationPlan {
  try {
    return authority.adapter.buildSessionMutationPlan(request);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return stopSessionDelete(
      `The installed harness could not build a session-delete plan: ${detail}`,
    );
  }
}

function confirmSessionDeletePlan(
  sandboxName: string,
  authority: SessionPackageAuthority,
  request: Extract<HarnessSessionMutationPlanRequest, { readonly operation: "delete" }>,
  expectedPlan: HarnessSessionMutationPlan,
) {
  const currentAdapter = confirmSessionPackageAuthority(sandboxName, authority.identity);
  let currentPlan: HarnessSessionMutationPlan;
  try {
    currentPlan = currentAdapter.buildSessionMutationPlan(request);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return stopSessionDelete(`The installed harness session-delete plan changed: ${detail}`);
  }
  if (!isDeepStrictEqual(currentPlan, expectedPlan)) {
    stopSessionDelete("The installed harness session-delete plan changed before mutation.");
  }
  return currentAdapter;
}

function renderSessionDeleteResult(
  result: Extract<
    HarnessSessionMutationOutput,
    { readonly kind: "completed"; readonly operation: "delete" }
  >,
  options: SessionsDeleteOptions,
): SessionsDeleteResult {
  if (options.json) {
    console.log(
      JSON.stringify({
        key: result.key,
        removedTranscript: result.removedTranscript,
        entry: result.entry,
      }),
    );
  } else {
    const transcriptNote = result.removedTranscript
      ? "(transcript removed)"
      : "(transcript preserved)";
    console.error(`  Deleted session '${result.key}' via the installed harness ${transcriptNote}.`);
    if (options.verbose && result.entry !== null) {
      console.error(`  entry: ${JSON.stringify(result.entry)}`);
    }
  }
  return {
    key: result.key,
    removedTranscript: result.removedTranscript,
    ...(result.entry === null ? {} : { entry: result.entry }),
  };
}

export async function deleteSandboxSession(
  sandboxName: string,
  options: SessionsDeleteOptions,
): Promise<SessionsDeleteResult> {
  const authority = resolveSessionPackageAuthority(sandboxName);
  if (authority === null) return deleteLegacySandboxSession(sandboxName, options);

  return runWithDeferredSandboxLifecycleExit(() =>
    withMcpLifecycleLock(sandboxName, async () => {
      assertHermesPortableCommandUnavailable(sandboxName, "sandbox:sessions:delete");
      const request = buildDeleteRequest(options);
      const plan = buildSessionDeletePlan(authority, request);
      if (plan.kind === "unsupported" || plan.kind === "refused") {
        return stopSessionDelete(plan.reason);
      }

      // Capability refusal happens before liveness can issue any OpenShell call.
      await ensureLiveSandboxOrExit(sandboxName, {
        allowNonReadyPhase: true,
        exit: deferSandboxLifecycleExit,
      });
      const currentAdapter = confirmSessionDeletePlan(sandboxName, authority, request, plan);

      if (plan.kind === "stream") {
        await execSandbox(sandboxName, plan.command, {}, { exit: deferSandboxLifecycleExit });
        throw new Error("unreachable: streamed session deletion terminated the process");
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
        return stopSessionDelete(
          `The installed harness could not interpret session-delete output: ${detail}`,
        );
      }
      if (interpreted.kind === "refused") stopSessionDelete(interpreted.reason);
      if (interpreted.operation !== "delete") {
        return stopSessionDelete("The installed harness returned a non-delete session result.");
      }
      return renderSessionDeleteResult(interpreted, options);
    }),
  );
}
