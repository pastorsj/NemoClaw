// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";

import type {
  HarnessProcessLifecycleAction,
  HarnessProcessLifecycleDeclaration,
} from "@nvidia/nemoclaw-harness-contract";

import type { AgentDefinition } from "../../agent/defs";
import * as agentRuntime from "../../agent/runtime";
import type { RuntimeProviderPrivilegedSandboxCommandResult } from "../../onboard/runtime-provider/contract";
import {
  executePrivilegedSandboxCommand,
  resolvePrivilegedSandboxTarget,
  withPrivilegedSandboxExecutionLease,
} from "../../sandbox/privileged-exec";
import { readRegisteredSandboxAuthority } from "../../onboard/package/package-authority";
import type { HarnessPackageIdentity } from "../../agent-runtime/package/identity";

export type SandboxProcessLifecycleAction = HarnessProcessLifecycleAction;

type ProcessLifecycleSandboxAuthority = {
  readonly agent?: string | null;
  readonly harnessPackage?: HarnessPackageIdentity | null;
};

export type SandboxProcessLifecyclePlan =
  | {
      readonly kind: "command";
      readonly authority: "package" | "legacy";
      readonly command: readonly string[];
    }
  | {
      readonly kind: "unsupported";
      readonly reason: string;
    };

export type SandboxProcessLifecycleExecution =
  | {
      readonly kind: "completed";
      readonly authority: "package" | "legacy";
      readonly nonce: string;
      readonly targetResourceHandle: string;
      readonly result: RuntimeProviderPrivilegedSandboxCommandResult;
    }
  | {
      readonly kind: "unsupported";
      readonly reason: string;
    };

export interface SandboxProcessLifecycleExecutorDeps {
  readonly getSandbox: (sandboxName: string) => ProcessLifecycleSandboxAuthority | null | undefined;
  readonly getSessionAgent: (sandboxName: string) => AgentDefinition | null;
  readonly createNonce: () => string;
  readonly resolveTarget: typeof resolvePrivilegedSandboxTarget;
  readonly executeCommand: typeof executePrivilegedSandboxCommand;
  readonly withExecutionLease: typeof withPrivilegedSandboxExecutionLease;
}

const LEGACY_GATEWAY_CONTROL_COMMAND = "/usr/local/bin/nemoclaw-gateway-control";
export const PROCESS_LIFECYCLE_MAX_OUTPUT_BYTES = 64 * 1024;
export const PROCESS_LIFECYCLE_UNSUPPORTED_MARKER = "PROCESS_LIFECYCLE_UNSUPPORTED";

const DEFAULT_PROCESS_LIFECYCLE_EXECUTOR_DEPS: SandboxProcessLifecycleExecutorDeps = {
  getSandbox: readRegisteredSandboxAuthority,
  getSessionAgent: agentRuntime.getSessionAgent,
  createNonce: () => randomBytes(32).toString("hex"),
  resolveTarget: resolvePrivilegedSandboxTarget,
  executeCommand: executePrivilegedSandboxCommand,
  withExecutionLease: withPrivilegedSandboxExecutionLease,
};

function receiptLifecycleDeclaration(
  sandbox: ProcessLifecycleSandboxAuthority,
  agent: AgentDefinition | null,
): HarnessProcessLifecycleDeclaration | null {
  const receipt = sandbox.harnessPackage;
  const recordedAgentMatches = sandbox.agent == null || sandbox.agent === receipt?.id;
  if (!receipt || !agent || agent.name !== receipt.id || !recordedAgentMatches) return null;
  return agent.runtime?.process_lifecycle ?? null;
}

/**
 * Build one finite lifecycle plan without branching on a package identifier.
 * Only an explicit no-receipt registry row may use the historical controller.
 */
export function buildSandboxProcessLifecyclePlan(
  sandbox: ProcessLifecycleSandboxAuthority,
  agent: AgentDefinition | null,
  action: SandboxProcessLifecycleAction,
  nonce: string,
): SandboxProcessLifecyclePlan {
  if (!/^[0-9a-f]{64}$/u.test(nonce)) {
    throw new Error(
      "Sandbox process lifecycle nonce must contain 64 lowercase hexadecimal characters",
    );
  }
  if (!sandbox.harnessPackage) {
    return Object.freeze({
      kind: "command",
      authority: "legacy",
      command: Object.freeze([LEGACY_GATEWAY_CONTROL_COMMAND, action, nonce]),
    });
  }

  const declaration = receiptLifecycleDeclaration(sandbox, agent);
  if (!declaration) {
    return Object.freeze({
      kind: "unsupported",
      reason: "the exact package process lifecycle declaration is unavailable",
    });
  }
  if (agent?.runtime?.kind === "terminal") {
    return Object.freeze({
      kind: "unsupported",
      reason: "terminal packages do not expose gateway process lifecycle operations",
    });
  }
  if (declaration.support === "unsupported") {
    return Object.freeze({ kind: "unsupported", reason: declaration.reason });
  }
  return Object.freeze({
    kind: "command",
    authority: "package",
    command: Object.freeze([...declaration.command, action, nonce]),
  });
}

/**
 * Execute a package or legacy lifecycle plan through core-owned authority.
 * The package supplies argv only; core owns the lease, provider/resource pin,
 * sanitized environment, deadline, and bounded capture.
 */
export function executeSandboxProcessLifecycle(
  sandboxName: string,
  action: SandboxProcessLifecycleAction,
  options: {
    readonly timeout: number;
    readonly expectedResourceHandle?: string;
    readonly deps?: Partial<SandboxProcessLifecycleExecutorDeps>;
  },
): SandboxProcessLifecycleExecution {
  const deps = { ...DEFAULT_PROCESS_LIFECYCLE_EXECUTOR_DEPS, ...options.deps };
  const nonce = deps.createNonce();
  return deps.withExecutionLease(sandboxName, `gateway supervisor ${action}`, () => {
    const targetResourceHandle =
      options.expectedResourceHandle ?? deps.resolveTarget(sandboxName).resourceHandle;
    const sandbox = deps.getSandbox(sandboxName);
    if (!sandbox) {
      throw new Error(`No NemoClaw registry entry found for '${sandboxName}'`);
    }

    let agent: AgentDefinition | null = null;
    if (sandbox.harnessPackage) {
      try {
        agent = deps.getSessionAgent(sandboxName);
      } catch {
        return {
          kind: "unsupported",
          reason: "the exact package process lifecycle declaration is unavailable",
        };
      }
    }
    const plan = buildSandboxProcessLifecyclePlan(sandbox, agent, action, nonce);
    if (plan.kind === "unsupported") return plan;

    return {
      kind: "completed",
      authority: plan.authority,
      nonce,
      targetResourceHandle,
      result: deps.executeCommand(sandboxName, plan.command, {
        sanitizeEnvironment: true,
        expectedResourceHandle: targetResourceHandle,
        timeout: options.timeout,
        maxOutputBytes: PROCESS_LIFECYCLE_MAX_OUTPUT_BYTES,
      }),
    };
  });
}

/** Return a receipt-backed package's typed lifecycle refusal, if any. */
export function packageProcessLifecycleUnsupportedReason(
  agent: AgentDefinition | null,
): string | null {
  const declaration = agent?.runtime?.process_lifecycle;
  if (!declaration) return "the package does not declare managed process lifecycle support";
  return declaration.support === "unsupported" ? declaration.reason : null;
}
