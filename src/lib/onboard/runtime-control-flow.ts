// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type Session, updateSession } from "../state/onboard-session";
import { inspectHarnessPackageState } from "../agent-runtime/package/identity-read";
import { supportsSandboxStartupControl } from "../agent-runtime/sandbox-create";
import type { AgentDefinition } from "../agent-runtime/manifest-types";
import { clearAgentScopedResumeState } from "./agent-resume-state";
import { isDcodeAutoApprovalMode } from "./dcode-auto-approval";
import { managedSandboxFeatureIssue } from "./managed-sandbox-feature";
import { stopTrackedModelRouterForAgentChange } from "./model-router-process";
import { DCODE_OBSERVABILITY_FEATURE } from "./observability-policy-presets";
import { sandboxObservabilityFeature } from "./managed-startup/startup-controls";
import { resolvePackageBackedSandboxAgent } from "./package/package-authority";
import { formatSandboxAgentName, normalizeSandboxAgentName } from "./sandbox-agent/naming";
import { applyOnboardToolDisclosureRequest } from "./tool-disclosure-flow";
import type { OnboardOptions } from "./types";

export { clearAgentScopedResumeState };
export {
  resolveCurrentOpenShellComputePlan,
  resolveCurrentOpenShellRuntimeSelection,
} from "./compute/plan";

export interface RuntimeControlAgentDeps {
  error(message: string): void;
  exitProcess(code: number): never;
  getRegisteredAgent?: (
    source: Pick<Session, "agent" | "harnessPackage" | "harnessPackageMigration">,
  ) => AgentDefinition | null;
}

export interface SelectedAgentTransitionDeps extends RuntimeControlAgentDeps {
  note(message: string): void;
  stopTrackedModelRouterForAgentChange(session: Session, routerPort: number): Promise<void>;
  clearAgentScopedResumeState(session: Session, selectedAgentName: string): Session;
  updateSession(mutator: (session: Session) => Session | void): Session;
}

function sessionPackageAuthorityEntry(
  session: Pick<Session, "agent" | "harnessPackage" | "harnessPackageMigration">,
) {
  return {
    agent: session.agent,
    ...(session.harnessPackage == null ? {} : { harnessPackage: session.harnessPackage }),
    ...(session.harnessPackageMigration == null
      ? {}
      : { harnessPackageMigration: session.harnessPackageMigration }),
  };
}

type SelectedAgentTransitionOverrides = Partial<Omit<SelectedAgentTransitionDeps, "note">>;

export function applyOnboardRuntimeControlRequests(
  opts: Pick<
    OnboardOptions,
    | "toolDisclosure"
    | "observabilityEnabled"
    | "observabilityRequestedExplicitly"
    | "dcodeAutoApprovalMode"
  >,
) {
  const observabilityIsExplicit = opts.observabilityRequestedExplicitly !== false;
  return {
    requestedToolDisclosure: applyOnboardToolDisclosureRequest(opts.toolDisclosure),
    requestedObservabilityEnabled:
      observabilityIsExplicit && typeof opts.observabilityEnabled === "boolean"
        ? opts.observabilityEnabled
        : null,
    requestedDcodeAutoApprovalMode: isDcodeAutoApprovalMode(opts.dcodeAutoApprovalMode)
      ? opts.dcodeAutoApprovalMode
      : null,
  };
}

export function updateSessionAgent(
  session: Session,
  agentName: string | null | undefined,
  deps: RuntimeControlAgentDeps = {
    error: console.error,
    exitProcess: (code) => process.exit(code),
  },
): Session {
  validateSessionAgentObservability(session, agentName, deps);
  session.agent = agentName ?? null;
  return session;
}

export function validateSessionAgentObservability(
  session: Pick<
    Session,
    "agent" | "harnessPackage" | "harnessPackageMigration" | "observabilityEnabled"
  > | null,
  agentName: string | null | undefined,
  deps: RuntimeControlAgentDeps = {
    error: console.error,
    exitProcess: (code) => process.exit(code),
  },
): void {
  if (session && (session.harnessPackage != null || session.harnessPackageMigration != null)) {
    let agent: AgentDefinition | null;
    try {
      agent = deps.getRegisteredAgent
        ? deps.getRegisteredAgent(session)
        : resolvePackageBackedSandboxAgent(sessionPackageAuthorityEntry(session)).definition;
    } catch {
      throw new Error("Session harness package authority is malformed");
    }
    const feature = sandboxObservabilityFeature(
      supportsSandboxStartupControl(agent, "observability"),
    );
    if (
      managedSandboxFeatureIssue(feature, {
        agent: agentName,
        sessionValue: session?.observabilityEnabled,
      }) === "recorded-state-on-unsupported-agent"
    ) {
      deps.error(
        "  Recorded observability belongs to a harness package that declares the observability startup control. Pass --no-observability explicitly before changing packages.",
      );
      deps.exitProcess(1);
    }
    return;
  }
  // Exact DCode recognition is limited to the explicit no-receipt compatibility lane.
  if (
    managedSandboxFeatureIssue(DCODE_OBSERVABILITY_FEATURE, {
      agent: agentName,
      sessionValue: session?.observabilityEnabled,
    }) === "recorded-state-on-unsupported-agent"
  ) {
    deps.error(
      "  Recorded observability belongs to Deep Agents Code. Pass --no-observability explicitly when switching agents.",
    );
    deps.exitProcess(1);
  }
}

export interface SelectedAgentTransitionPlan {
  session: Session;
  resumeAgentChanged: boolean;
  commit(): Promise<Session>;
}

function assertPackageResumeTransition(
  resume: boolean,
  session: Session,
  selectedAgentName: string | null | undefined,
): void {
  if (!resume) return;
  const packageState = inspectHarnessPackageState(
    session.harnessPackage,
    session.harnessPackageMigration,
  );
  if (packageState.status === "invalid") {
    throw new Error("Resumed harness package authority is malformed");
  }
  if (packageState.status === "absent") return;

  const selectedAgent = normalizeSandboxAgentName(selectedAgentName);
  const recordedAgent = normalizeSandboxAgentName(session.agent);
  if (
    packageState.harnessPackage.id !== recordedAgent ||
    packageState.harnessPackage.id !== selectedAgent
  ) {
    throw new Error(
      `Resumed harness package '${packageState.harnessPackage.id}' cannot transition to '${selectedAgent}'`,
    );
  }
}

/** Plan an agent transition without changing durable state or stopping a router. */
export function planSelectedAgentTransition(
  input: {
    resume: boolean;
    session: Session | null;
    selectedAgentName: string | null | undefined;
    routerPort: number;
    note(message: string): void;
  },
  overrides: SelectedAgentTransitionOverrides = {},
): SelectedAgentTransitionPlan {
  const deps: SelectedAgentTransitionDeps = {
    note: input.note,
    stopTrackedModelRouterForAgentChange,
    clearAgentScopedResumeState,
    updateSession,
    error: console.error,
    exitProcess: (code) => process.exit(code),
    ...overrides,
  };
  if (!input.session) throw new Error("Agent transition requires an active onboarding session.");
  assertPackageResumeTransition(input.resume, input.session, input.selectedAgentName);
  validateSessionAgentObservability(input.session, input.selectedAgentName, deps);

  const selectedAgentName = normalizeSandboxAgentName(input.selectedAgentName);
  const recordedAgentName = normalizeSandboxAgentName(input.session?.agent);
  const resumeAgentChanged = Boolean(
    input.resume && input.session && recordedAgentName !== selectedAgentName,
  );
  const originalSession = structuredClone(input.session);
  let projectedSession = structuredClone(input.session);
  if (resumeAgentChanged) {
    projectedSession = deps.clearAgentScopedResumeState(projectedSession, selectedAgentName);
  }
  projectedSession = updateSessionAgent(projectedSession, input.selectedAgentName, deps);
  let committed: Promise<Session> | null = null;
  return {
    session: projectedSession,
    resumeAgentChanged,
    commit() {
      committed ??= (async () => {
        if (resumeAgentChanged) {
          deps.note(
            `  Agent changed from ${formatSandboxAgentName(recordedAgentName)} to ${formatSandboxAgentName(selectedAgentName)}; refreshing provider selection.`,
          );
          await deps.stopTrackedModelRouterForAgentChange(originalSession, input.routerPort);
        }
        return deps.updateSession((current) => {
          const transitioned = resumeAgentChanged
            ? deps.clearAgentScopedResumeState(current, selectedAgentName)
            : current;
          return updateSessionAgent(transitioned, input.selectedAgentName, deps);
        });
      })();
      return committed;
    },
  };
}
