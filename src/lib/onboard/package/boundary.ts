// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { resolveAgentNameAlias } from "../../agent/aliases";
import type { AgentDefinition } from "../../agent/defs";
import { getBundledHarnessPackageRoot } from "../../harness/package-catalog";
import {
  inspectHarnessPackageState,
  type HarnessPackageIdentity,
  type HarnessPackageMigration,
} from "../../harness/package-identity";
import {
  getBundledHarnessPackageSourceIdentity,
  type BundledHarnessPackageSourceIdentity,
} from "../../harness/package-receipt";
import { getHarnessPackageStoreRoot } from "../../harness/package-store";
import {
  prepareLegacyHarnessMigration,
  reconcileLegacyHarnessMigration,
  type PreparedLegacyHarnessMigration,
} from "../../state/harness-migration";
import { bindCheckpointHarnessPackageAuthority } from "../../state/onboard-checkpoint-migrate";
import { type CompareAndSwapSessionResult, type Session } from "../../state/onboard-session";
import { load as loadRegistry } from "../../state/registry/persistence";
import type { SandboxRegistry } from "../../state/registry/types";
import { resolveQualifiedOnboardAgent } from "../agent-selection";
import {
  prepare as prepareLockedOnboardRuntime,
  type LockedOnboardRuntimePreparation,
} from "../resume/locked-runtime";
import {
  selectOnboardHarnessPackage,
  type OnboardHarnessInstallGuidance,
  type OnboardHarnessPackageSelection,
} from "../package-selection";
import {
  getEffectiveSandboxAgent,
  resolveSandboxAgent,
  type ResolvedSandboxAgent,
} from "../sandbox-agent";
import type { FreshOnboardHarnessBinding } from "../session-bootstrap";
import { assertCheckpointPackageAuthorityChain } from "../checkpoint-replay";

export { requireCurrentSessionHarnessPackageAuthority } from "./package-authority";

type SelectedOnboardHarness = Exclude<
  OnboardHarnessPackageSelection,
  OnboardHarnessInstallGuidance
>;

interface PreparedPackageContext {
  readonly environment: NodeJS.ProcessEnv;
  readonly storeRoot: string;
}

export type PreparedOnboardHarnessPackage =
  | ({
      readonly kind: "fresh";
      readonly selection: SelectedOnboardHarness;
    } & PreparedPackageContext)
  | ({
      readonly kind: "package-resume";
      readonly ownerSnapshot: Session;
    } & PreparedPackageContext)
  | ({
      readonly kind: "qualified-resume";
      readonly ownerSnapshot: Session;
    } & PreparedPackageContext)
  | ({
      readonly kind: "legacy-resume";
      readonly migration: PreparedLegacyHarnessMigration;
    } & PreparedPackageContext)
  | { readonly kind: "deferred-resume" };

export interface BoundOnboardHarnessPackage {
  readonly effectiveDefinition: AgentDefinition | null;
  readonly freshHarnessBinding: FreshOnboardHarnessBinding | null;
  readonly selectedAgent: AgentDefinition | null;
  readonly selectionIsAuthoritative: boolean;
}

export interface OnboardHarnessPackageBoundaryInput {
  readonly agentFlag: string | null;
  readonly canPrompt: boolean;
  readonly environment: NodeJS.ProcessEnv;
  readonly log: (message?: string) => void;
  readonly prompt: (question: string) => Promise<string>;
  readonly resume: boolean;
  readonly rootDir: string;
}

export interface OnboardHarnessPackageBoundaryDependencies {
  readonly assertWriterLockOwned: () => void;
  readonly compareAndSwapSession: (
    matches: (session: Session) => boolean,
    mutator: (session: Session) => Session | void,
    command?: string,
  ) => CompareAndSwapSessionResult;
  readonly loadSession: () => Session | null;
  readonly loadRegistry: () => SandboxRegistry;
  readonly getBundledRoot: typeof getBundledHarnessPackageRoot;
  readonly getSourceIdentity: typeof getBundledHarnessPackageSourceIdentity;
  readonly getStoreRoot: typeof getHarnessPackageStoreRoot;
  readonly prepareLegacyMigration: typeof prepareLegacyHarnessMigration;
  readonly reconcileLegacyMigration: typeof reconcileLegacyHarnessMigration;
  readonly resolveQualifiedAgent: typeof resolveQualifiedOnboardAgent;
  readonly resolveSandboxAgent: typeof resolveSandboxAgent;
  readonly selectHarnessPackage: typeof selectOnboardHarnessPackage;
}

export interface OnboardHarnessPackageBoundary {
  prepare(input: OnboardHarnessPackageBoundaryInput): Promise<PreparedOnboardHarnessPackage>;
  bind(prepared: PreparedOnboardHarnessPackage): BoundOnboardHarnessPackage;
}

export interface PrepareOnboardHarnessOperationInput {
  readonly agentFlag: string | null;
  readonly canPrompt: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly log?: (message?: string) => void;
  readonly prompt: (question: string) => Promise<string>;
  readonly resume: boolean;
  readonly rootDir: string;
}

export interface PreparedOnboardHarnessOperation {
  readonly beforeRuntimeEffects: () => void;
  freshSessionInput(): { readonly freshHarnessBinding?: FreshOnboardHarnessBinding };
  prepareBoundRuntime(
    options: Parameters<typeof prepareLockedOnboardRuntime>[0],
    nonInteractive: boolean,
    loadRuntimeSession: Parameters<typeof prepareLockedOnboardRuntime>[3],
  ): Promise<BoundOnboardRuntimePreparation>;
  requireBoundAuthority(): BoundOnboardHarnessPackage;
  resolveAgents(
    session: Session | null,
    selectAgent: (input: {
      readonly agentFlag: string | null;
      readonly session: Session | null;
      readonly resume: boolean;
      readonly canPrompt: boolean;
    }) => Promise<AgentDefinition | null>,
  ): Promise<{ readonly agent: AgentDefinition | null; readonly effectiveAgent: AgentDefinition }>;
}

export interface BoundOnboardRuntimePreparation {
  readonly harnessAuthority: BoundOnboardHarnessPackage;
  readonly lockedRuntime: LockedOnboardRuntimePreparation;
}

const PRODUCTION_DEPENDENCIES = Object.freeze({
  getBundledRoot: getBundledHarnessPackageRoot,
  getSourceIdentity: getBundledHarnessPackageSourceIdentity,
  getStoreRoot: getHarnessPackageStoreRoot,
  loadRegistry,
  prepareLegacyMigration: prepareLegacyHarnessMigration,
  reconcileLegacyMigration: reconcileLegacyHarnessMigration,
  resolveQualifiedAgent: resolveQualifiedOnboardAgent,
  resolveSandboxAgent,
  selectHarnessPackage: selectOnboardHarnessPackage,
});

function assertResumeSelectionMatches(
  effectiveAgentId: string,
  input: OnboardHarnessPackageBoundaryInput,
): void {
  const requested = input.agentFlag?.trim() || input.environment.NEMOCLAW_AGENT?.trim();
  if (!requested) return;
  if (resolveAgentNameAlias(requested, [effectiveAgentId]) !== effectiveAgentId) {
    throw new Error(
      `Requested harness '${requested}' does not match resumed harness '${effectiveAgentId}'`,
    );
  }
}

function bundledSourceIdentity(
  input: OnboardHarnessPackageBoundaryInput,
  deps: OnboardHarnessPackageBoundaryDependencies,
): BundledHarnessPackageSourceIdentity {
  return {
    ...deps.getSourceIdentity({ rootDir: input.rootDir }),
  };
}

function packageContext(
  input: OnboardHarnessPackageBoundaryInput,
  deps: OnboardHarnessPackageBoundaryDependencies,
): PreparedPackageContext {
  return { environment: input.environment, storeRoot: deps.getStoreRoot() };
}

function requireUnchangedPackageOwner(expected: Session, current: Session | null): Session {
  if (
    current === null ||
    current.sessionId !== expected.sessionId ||
    current.agent !== expected.agent ||
    !isDeepStrictEqual(current.harnessPackage, expected.harnessPackage) ||
    !isDeepStrictEqual(current.harnessPackageMigration, expected.harnessPackageMigration)
  ) {
    throw new Error("Onboarding session package authority changed during portable recovery");
  }
  return current;
}

function requireUnchangedQualifiedOwner(expected: Session, current: Session | null): Session {
  if (
    current === null ||
    current.sessionId !== expected.sessionId ||
    current.agent !== expected.agent ||
    !isDeepStrictEqual(current.harnessPackage, expected.harnessPackage) ||
    !isDeepStrictEqual(current.harnessPackageMigration, expected.harnessPackageMigration)
  ) {
    throw new Error("Qualified onboarding session authority changed during portable recovery");
  }
  return current;
}

function reconcileCheckpointAuthority(
  current: Session,
  harnessPackage: HarnessPackageIdentity | null,
  deps: OnboardHarnessPackageBoundaryDependencies,
): Session {
  const checkpoint = bindCheckpointHarnessPackageAuthority(current.checkpoint, harnessPackage);
  if (isDeepStrictEqual(checkpoint, current.checkpoint)) return current;
  const result = deps.compareAndSwapSession(
    (candidate) =>
      candidate.sessionId === current.sessionId &&
      candidate.agent === current.agent &&
      isDeepStrictEqual(candidate.harnessPackage, current.harnessPackage) &&
      isDeepStrictEqual(candidate.harnessPackageMigration, current.harnessPackageMigration) &&
      isDeepStrictEqual(candidate.checkpoint, current.checkpoint),
    (candidate) => ({ ...candidate, checkpoint }),
    "nemoclaw checkpoint package authority migration",
  );
  if (result !== "updated") {
    throw new Error(`Onboarding checkpoint authority compare-and-swap returned ${result}`);
  }
  const reread = deps.loadSession();
  if (
    !reread ||
    reread.sessionId !== current.sessionId ||
    !isDeepStrictEqual(reread.checkpoint, checkpoint)
  ) {
    throw new Error("Onboarding checkpoint package authority did not survive readback");
  }
  return reread;
}

function assertOwningRegistryAuthority(
  session: Session,
  deps: OnboardHarnessPackageBoundaryDependencies,
): void {
  const entry = session.sandboxName
    ? (deps.loadRegistry().sandboxes[session.sandboxName] ?? null)
    : null;
  assertCheckpointPackageAuthorityChain(session, entry);
}

function packageEntry(session: Session): {
  readonly agent: string | null;
  readonly harnessPackage: HarnessPackageIdentity;
  readonly harnessPackageMigration?: HarnessPackageMigration;
} {
  const state = inspectHarnessPackageState(session.harnessPackage, session.harnessPackageMigration);
  if (state.status !== "valid") {
    throw new Error("Resumed onboarding session lost valid harness package authority");
  }
  return {
    agent: session.agent,
    harnessPackage: state.harnessPackage,
    ...(state.harnessPackageMigration
      ? { harnessPackageMigration: state.harnessPackageMigration }
      : {}),
  };
}

function boundResolvedAgent(resolved: ResolvedSandboxAgent): BoundOnboardHarnessPackage {
  return {
    effectiveDefinition: resolved.definition,
    freshHarnessBinding: null,
    selectedAgent: resolved.recordedAgent === null ? null : resolved.definition,
    selectionIsAuthoritative: true,
  };
}

function bindFreshSelection(
  prepared: Extract<PreparedOnboardHarnessPackage, { readonly kind: "fresh" }>,
  deps: OnboardHarnessPackageBoundaryDependencies,
): BoundOnboardHarnessPackage {
  const selection = prepared.selection;
  if (selection.kind === "qualified-agent") {
    const definition = deps.resolveQualifiedAgent(selection.recordedAgent, prepared.environment);
    if (!definition || definition.name !== selection.recordedAgent) {
      throw new Error("Selected qualified harness authority did not survive portable recovery");
    }
    deps.assertWriterLockOwned();
    return {
      effectiveDefinition: definition,
      freshHarnessBinding: selection,
      selectedAgent: definition,
      selectionIsAuthoritative: true,
    };
  }

  const resolved = deps.resolveSandboxAgent(
    {
      agent: selection.recordedAgent,
      harnessPackage: selection.harnessPackage,
    },
    { storeRoot: prepared.storeRoot, env: prepared.environment },
  );
  if (
    resolved.recordedAgent !== selection.recordedAgent ||
    !isDeepStrictEqual(resolved.harnessPackage, selection.harnessPackage)
  ) {
    throw new Error("Selected harness package changed during post-recovery resolution");
  }
  deps.assertWriterLockOwned();
  return {
    effectiveDefinition: resolved.definition,
    freshHarnessBinding: selection,
    selectedAgent: resolved.recordedAgent === null ? null : resolved.definition,
    selectionIsAuthoritative: true,
  };
}

async function prepareBoundary(
  input: OnboardHarnessPackageBoundaryInput,
  deps: OnboardHarnessPackageBoundaryDependencies,
): Promise<PreparedOnboardHarnessPackage> {
  deps.assertWriterLockOwned();
  const context = packageContext(input, deps);
  if (!input.resume) {
    const selection = await deps.selectHarnessPackage({
      agentFlag: input.agentFlag,
      bundledRoot: deps.getBundledRoot(),
      canPrompt: input.canPrompt,
      environment: input.environment,
      log: input.log,
      prompt: input.prompt,
      storeRoot: context.storeRoot,
    });
    deps.assertWriterLockOwned();
    if (selection.kind === "install-required") throw new Error(selection.message);
    return { kind: "fresh", selection, ...context };
  }

  const session = deps.loadSession();
  if (!session || session.resumable === false) return { kind: "deferred-resume" };
  const packageState = inspectHarnessPackageState(
    session.harnessPackage,
    session.harnessPackageMigration,
  );
  if (packageState.status === "valid") {
    assertResumeSelectionMatches(packageState.harnessPackage.id, input);
    const owningEntry = session.sandboxName
      ? deps.loadRegistry().sandboxes[session.sandboxName]
      : undefined;
    if (
      packageState.harnessPackageMigration &&
      owningEntry &&
      (!isDeepStrictEqual(owningEntry.harnessPackage, packageState.harnessPackage) ||
        !isDeepStrictEqual(
          owningEntry.harnessPackageMigration,
          packageState.harnessPackageMigration,
        ))
    ) {
      return {
        kind: "legacy-resume",
        migration: deps.prepareLegacyMigration({
          owner: { kind: "session", session },
          bundledRoot: deps.getBundledRoot(),
          storeRoot: context.storeRoot,
          sourceIdentity: bundledSourceIdentity(input, deps),
        }),
        ...context,
      };
    }
    deps.resolveSandboxAgent(packageEntry(session), {
      storeRoot: context.storeRoot,
      env: input.environment,
    });
    deps.assertWriterLockOwned();
    return { kind: "package-resume", ownerSnapshot: structuredClone(session), ...context };
  }

  if (packageState.status === "absent" && session.agent) {
    const definition = deps.resolveQualifiedAgent(session.agent, input.environment);
    if (definition) {
      if (definition.name !== session.agent) {
        throw new Error(
          `Qualified harness '${session.agent}' resolved as unexpected harness '${definition.name}'`,
        );
      }
      assertResumeSelectionMatches(session.agent, input);
      return { kind: "qualified-resume", ownerSnapshot: structuredClone(session), ...context };
    }
  }

  assertResumeSelectionMatches(session.agent ?? "openclaw", input);
  return {
    kind: "legacy-resume",
    migration: deps.prepareLegacyMigration({
      owner: { kind: "session", session },
      bundledRoot: deps.getBundledRoot(),
      storeRoot: context.storeRoot,
      sourceIdentity: bundledSourceIdentity(input, deps),
    }),
    ...context,
  };
}

function bindBoundary(
  prepared: PreparedOnboardHarnessPackage,
  deps: OnboardHarnessPackageBoundaryDependencies,
): BoundOnboardHarnessPackage {
  deps.assertWriterLockOwned();
  if (prepared.kind === "fresh") {
    return bindFreshSelection(prepared, deps);
  }
  if (prepared.kind === "package-resume") {
    const unchanged = requireUnchangedPackageOwner(prepared.ownerSnapshot, deps.loadSession());
    const owner = reconcileCheckpointAuthority(unchanged, unchanged.harnessPackage, deps);
    assertOwningRegistryAuthority(owner, deps);
    const resolved = deps.resolveSandboxAgent(packageEntry(owner), {
      storeRoot: prepared.storeRoot,
      env: prepared.environment,
    });
    deps.assertWriterLockOwned();
    return boundResolvedAgent(resolved);
  }
  if (prepared.kind === "qualified-resume") {
    const unchanged = requireUnchangedQualifiedOwner(prepared.ownerSnapshot, deps.loadSession());
    const owner = reconcileCheckpointAuthority(unchanged, null, deps);
    assertOwningRegistryAuthority(owner, deps);
    const definition = owner.agent
      ? deps.resolveQualifiedAgent(owner.agent, prepared.environment)
      : null;
    if (!definition || definition.name !== owner.agent) {
      throw new Error("Qualified harness authority did not survive portable recovery");
    }
    deps.assertWriterLockOwned();
    return {
      effectiveDefinition: definition,
      freshHarnessBinding: null,
      selectedAgent: definition,
      selectionIsAuthoritative: true,
    };
  }
  if (prepared.kind === "deferred-resume") {
    return {
      effectiveDefinition: null,
      freshHarnessBinding: null,
      selectedAgent: null,
      selectionIsAuthoritative: false,
    };
  }
  if (prepared.migration.owner.kind !== "session") {
    throw new Error("Onboarding legacy migration requires a session owner");
  }
  const migrated = deps.reconcileLegacyMigration(prepared.migration);
  const resolved = deps.resolveSandboxAgent(
    {
      agent: prepared.migration.owner.session.agent,
      harnessPackage: migrated.harnessPackage,
      harnessPackageMigration: migrated.harnessPackageMigration,
    },
    { storeRoot: prepared.storeRoot, env: prepared.environment },
  );
  deps.assertWriterLockOwned();
  return boundResolvedAgent(resolved);
}

/** Build the writer-locked harness package boundary used by one onboarding command. */
export function createOnboardHarnessPackageBoundary(
  overrides: Pick<
    OnboardHarnessPackageBoundaryDependencies,
    "assertWriterLockOwned" | "compareAndSwapSession" | "loadSession"
  > &
    Partial<OnboardHarnessPackageBoundaryDependencies>,
): OnboardHarnessPackageBoundary {
  const deps: OnboardHarnessPackageBoundaryDependencies = {
    ...PRODUCTION_DEPENDENCIES,
    ...overrides,
  };
  return Object.freeze({
    prepare: (input: OnboardHarnessPackageBoundaryInput) => prepareBoundary(input, deps),
    bind: (prepared: PreparedOnboardHarnessPackage) => bindBoundary(prepared, deps),
  });
}

/** Prepare package authority before portable recovery, then expose one post-recovery binder. */
export async function prepareOnboardHarnessOperation(
  input: PrepareOnboardHarnessOperationInput,
  dependencyOverrides: Pick<
    OnboardHarnessPackageBoundaryDependencies,
    "assertWriterLockOwned" | "compareAndSwapSession" | "loadSession"
  > &
    Partial<OnboardHarnessPackageBoundaryDependencies>,
): Promise<PreparedOnboardHarnessOperation> {
  const boundary = createOnboardHarnessPackageBoundary({
    ...dependencyOverrides,
  });
  const prepared = await boundary.prepare({
    agentFlag: input.agentFlag,
    canPrompt: input.canPrompt,
    environment: input.environment ?? process.env,
    log: input.log ?? ((message = "") => console.log(message)),
    prompt: input.prompt,
    resume: input.resume,
    rootDir: input.rootDir,
  });
  let authority: BoundOnboardHarnessPackage | null = null;
  const beforeRuntimeEffects = (): void => {
    if (authority) throw new Error("Onboarding harness package authority is already bound");
    authority = boundary.bind(prepared);
  };
  const operation: PreparedOnboardHarnessOperation = {
    beforeRuntimeEffects,
    freshSessionInput: () => freshHarnessSessionInput(operation.requireBoundAuthority()),
    prepareBoundRuntime: (options, nonInteractive, loadRuntimeSession) =>
      prepareBoundOnboardRuntime(
        operation,
        options,
        input.resume,
        nonInteractive,
        loadRuntimeSession,
      ),
    requireBoundAuthority(): BoundOnboardHarnessPackage {
      if (!authority) throw new Error("Onboarding harness package authority was not bound");
      return authority;
    },
    resolveAgents: (session, selectAgent) =>
      resolveBoundHarnessAgents(operation.requireBoundAuthority(), () =>
        selectAgent({
          agentFlag: input.agentFlag,
          session,
          resume: input.resume,
          canPrompt: input.canPrompt,
        }),
      ),
  };
  return Object.freeze(operation);
}

/** Bind prepared harness authority at the locked runtime's pre-effect hook. */
export async function prepareBoundOnboardRuntime(
  operation: PreparedOnboardHarnessOperation,
  options: Parameters<typeof prepareLockedOnboardRuntime>[0],
  resume: boolean,
  nonInteractive: boolean,
  loadRuntimeSession: Parameters<typeof prepareLockedOnboardRuntime>[3],
): Promise<BoundOnboardRuntimePreparation> {
  const lockedRuntime = await prepareLockedOnboardRuntime(
    options,
    resume,
    nonInteractive,
    loadRuntimeSession,
    { beforeRuntimeEffects: operation.beforeRuntimeEffects },
  );
  return {
    harnessAuthority: operation.requireBoundAuthority(),
    lockedRuntime,
  };
}

export function freshHarnessSessionInput(authority: BoundOnboardHarnessPackage): {
  readonly freshHarnessBinding?: FreshOnboardHarnessBinding;
} {
  return authority.freshHarnessBinding
    ? { freshHarnessBinding: authority.freshHarnessBinding }
    : {};
}

export async function resolveBoundHarnessAgents(
  authority: BoundOnboardHarnessPackage,
  selectFallback: () => Promise<AgentDefinition | null>,
): Promise<{ readonly agent: AgentDefinition | null; readonly effectiveAgent: AgentDefinition }> {
  const agent = authority.selectionIsAuthoritative
    ? authority.selectedAgent
    : await selectFallback();
  return {
    agent,
    effectiveAgent: authority.effectiveDefinition ?? getEffectiveSandboxAgent(agent),
  };
}
