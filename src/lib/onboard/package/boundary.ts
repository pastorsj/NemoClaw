// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { createAgentAliasMap, resolveAgentNameAlias } from "../../agent/aliases";
import type { AgentDefinition } from "../../agent/defs";
import { readAgentAliasTargets } from "../../agent/manifest-inventory";
import { getBundledHarnessPackageRoot } from "../../agent-runtime/package/catalog";
import {
  inspectHarnessPackageState,
  type HarnessPackageIdentity,
  type HarnessPackageMigration,
} from "../../agent-runtime/package/identity";
import {
  getBundledHarnessPackageSourceIdentity,
  type BundledHarnessPackageSourceIdentity,
} from "../../agent-runtime/package/receipt";
import { getHarnessPackageStoreRoot } from "../../agent-runtime/package/store";
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
import {
  type HarnessPackageSessionAuthority,
  type OnboardHarnessPackageAuthority,
  requireCurrentSessionHarnessPackageAuthority,
} from "./package-authority";

export { requireCurrentSessionHarnessPackageAuthority };

type SelectedOnboardHarness = Exclude<
  OnboardHarnessPackageSelection,
  OnboardHarnessInstallGuidance
>;

interface PreparedPackageContext {
  readonly authoritativeRebuildAgentAuthority: ResolvedSandboxAgent | null;
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
  | ({ readonly kind: "deferred-resume" } & PreparedPackageContext);

export interface BoundOnboardHarnessPackage {
  readonly effectiveDefinition: AgentDefinition | null;
  readonly freshHarnessBinding: FreshOnboardHarnessBinding | null;
  readonly selectedAgent: AgentDefinition | null;
  readonly selectionIsAuthoritative: boolean;
}

export interface OnboardHarnessPackageBoundaryInput {
  readonly agentFlag: string | null;
  readonly authoritativeRebuildAgentAuthority?: ResolvedSandboxAgent;
  readonly canPrompt: boolean;
  readonly environment: NodeJS.ProcessEnv;
  readonly log: (message?: string) => void;
  readonly prompt: (question: string) => Promise<string>;
  readonly resume: boolean;
  readonly rootDir: string;
}

export interface OnboardHarnessPackageBoundaryDependencies {
  readonly assertOnboardLockOwned: () => void;
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
  readonly authoritativeRebuildAgentAuthority?: ResolvedSandboxAgent;
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
  revalidateSessionAuthority(
    expected: HarnessPackageSessionAuthority,
    operation: string,
  ): OnboardHarnessPackageAuthority;
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
  const aliases = readAgentAliasTargets([effectiveAgentId], input.environment);
  if (
    resolveAgentNameAlias(requested, [effectiveAgentId], createAgentAliasMap(aliases)) !==
    effectiveAgentId
  ) {
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
  return {
    authoritativeRebuildAgentAuthority: input.authoritativeRebuildAgentAuthority ?? null,
    environment: input.environment,
    storeRoot: deps.getStoreRoot(),
  };
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

function bindResolvedAgentAuthority(
  resolved: ResolvedSandboxAgent,
  authoritativeRebuildAgentAuthority: ResolvedSandboxAgent | null,
  freshHarnessBinding: FreshOnboardHarnessBinding | null = null,
): BoundOnboardHarnessPackage {
  assertPinnedRebuildAuthority(resolved, authoritativeRebuildAgentAuthority);
  const selected = authoritativeRebuildAgentAuthority ?? resolved;
  return {
    effectiveDefinition: selected.definition,
    freshHarnessBinding,
    selectedAgent: selected.recordedAgent === null ? null : selected.definition,
    selectionIsAuthoritative: true,
  };
}

function assertPinnedRebuildAuthority(
  resolved: ResolvedSandboxAgent,
  authoritativeRebuildAgentAuthority: ResolvedSandboxAgent | null,
): void {
  if (
    authoritativeRebuildAgentAuthority !== null &&
    !isDeepStrictEqual(resolved, authoritativeRebuildAgentAuthority)
  ) {
    throw new Error("Authoritative rebuild agent authority changed before runtime effects");
  }
}

function qualifiedAgentAuthority(
  recordedAgent: string,
  definition: AgentDefinition,
): ResolvedSandboxAgent {
  return Object.freeze({
    recordedAgent,
    effectiveAgentId: recordedAgent,
    definition,
    harnessPackage: null,
    harnessPackageMigration: null,
  });
}

function resolveCurrentQualifiedAuthority(
  recordedAgent: string,
  prepared: PreparedPackageContext,
  deps: OnboardHarnessPackageBoundaryDependencies,
  failureMessage: string,
): ResolvedSandboxAgent {
  if (prepared.authoritativeRebuildAgentAuthority !== null) {
    try {
      const resolved = deps.resolveSandboxAgent(
        { agent: recordedAgent },
        { storeRoot: prepared.storeRoot, env: prepared.environment },
      );
      if (resolved.recordedAgent !== recordedAgent || resolved.harnessPackage !== null) {
        throw new Error(failureMessage);
      }
      return resolved;
    } catch {
      throw new Error(failureMessage);
    }
  }
  const definition = deps.resolveQualifiedAgent(recordedAgent, prepared.environment);
  if (!definition || definition.name !== recordedAgent) throw new Error(failureMessage);
  return qualifiedAgentAuthority(recordedAgent, definition);
}

function bindFreshSelection(
  prepared: Extract<PreparedOnboardHarnessPackage, { readonly kind: "fresh" }>,
  deps: OnboardHarnessPackageBoundaryDependencies,
): BoundOnboardHarnessPackage {
  const selection = prepared.selection;
  if (selection.kind === "qualified-agent") {
    const resolved = resolveCurrentQualifiedAuthority(
      selection.recordedAgent,
      prepared,
      deps,
      "Selected qualified harness authority did not survive portable recovery",
    );
    deps.assertOnboardLockOwned();
    return bindResolvedAgentAuthority(
      resolved,
      prepared.authoritativeRebuildAgentAuthority,
      selection,
    );
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
  deps.assertOnboardLockOwned();
  return bindResolvedAgentAuthority(
    resolved,
    prepared.authoritativeRebuildAgentAuthority,
    selection,
  );
}

async function prepareBoundary(
  input: OnboardHarnessPackageBoundaryInput,
  deps: OnboardHarnessPackageBoundaryDependencies,
): Promise<PreparedOnboardHarnessPackage> {
  deps.assertOnboardLockOwned();
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
    deps.assertOnboardLockOwned();
    if (selection.kind === "install-required") throw new Error(selection.message);
    return { kind: "fresh", selection, ...context };
  }

  const session = deps.loadSession();
  if (!session || session.resumable === false) return { kind: "deferred-resume", ...context };
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
    deps.assertOnboardLockOwned();
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
  deps.assertOnboardLockOwned();
  if (prepared.kind === "fresh") {
    return bindFreshSelection(prepared, deps);
  }
  if (prepared.kind === "package-resume") {
    const unchanged = requireUnchangedPackageOwner(prepared.ownerSnapshot, deps.loadSession());
    const resolvedBeforeMutation = prepared.authoritativeRebuildAgentAuthority
      ? deps.resolveSandboxAgent(packageEntry(unchanged), {
          storeRoot: prepared.storeRoot,
          env: prepared.environment,
        })
      : null;
    if (resolvedBeforeMutation) {
      assertPinnedRebuildAuthority(
        resolvedBeforeMutation,
        prepared.authoritativeRebuildAgentAuthority,
      );
    }
    const owner = reconcileCheckpointAuthority(unchanged, unchanged.harnessPackage, deps);
    assertOwningRegistryAuthority(owner, deps);
    const resolved =
      resolvedBeforeMutation ??
      deps.resolveSandboxAgent(packageEntry(owner), {
        storeRoot: prepared.storeRoot,
        env: prepared.environment,
      });
    deps.assertOnboardLockOwned();
    return bindResolvedAgentAuthority(resolved, prepared.authoritativeRebuildAgentAuthority);
  }
  if (prepared.kind === "qualified-resume") {
    const unchanged = requireUnchangedQualifiedOwner(prepared.ownerSnapshot, deps.loadSession());
    const resolvedBeforeMutation =
      prepared.authoritativeRebuildAgentAuthority !== null && unchanged.agent
        ? resolveCurrentQualifiedAuthority(
            unchanged.agent,
            prepared,
            deps,
            "Qualified harness authority did not survive portable recovery",
          )
        : null;
    if (resolvedBeforeMutation) {
      assertPinnedRebuildAuthority(
        resolvedBeforeMutation,
        prepared.authoritativeRebuildAgentAuthority,
      );
    }
    const owner = reconcileCheckpointAuthority(unchanged, null, deps);
    assertOwningRegistryAuthority(owner, deps);
    if (!owner.agent) {
      throw new Error("Qualified harness authority did not survive portable recovery");
    }
    const resolved =
      resolvedBeforeMutation ??
      resolveCurrentQualifiedAuthority(
        owner.agent,
        prepared,
        deps,
        "Qualified harness authority did not survive portable recovery",
      );
    deps.assertOnboardLockOwned();
    return bindResolvedAgentAuthority(resolved, prepared.authoritativeRebuildAgentAuthority);
  }
  if (prepared.kind === "deferred-resume") {
    if (prepared.authoritativeRebuildAgentAuthority !== null) {
      throw new Error("Authoritative rebuild agent authority is missing before runtime effects");
    }
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
  if (prepared.authoritativeRebuildAgentAuthority !== null) {
    const resolvedBeforeMutation = deps.resolveSandboxAgent(
      {
        agent: prepared.migration.owner.session.agent,
        harnessPackage: prepared.migration.harnessPackage,
        harnessPackageMigration: prepared.migration.harnessPackageMigration,
      },
      { storeRoot: prepared.storeRoot, env: prepared.environment },
    );
    assertPinnedRebuildAuthority(
      resolvedBeforeMutation,
      prepared.authoritativeRebuildAgentAuthority,
    );
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
  deps.assertOnboardLockOwned();
  return bindResolvedAgentAuthority(resolved, prepared.authoritativeRebuildAgentAuthority);
}

/** Build the writer-locked harness package boundary used by one onboarding command. */
export function createOnboardHarnessPackageBoundary(
  overrides: Pick<
    OnboardHarnessPackageBoundaryDependencies,
    "assertOnboardLockOwned" | "compareAndSwapSession" | "loadSession"
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
    "assertOnboardLockOwned" | "compareAndSwapSession" | "loadSession"
  > &
    Partial<OnboardHarnessPackageBoundaryDependencies>,
): Promise<PreparedOnboardHarnessOperation> {
  const environment = input.environment ?? process.env;
  const boundary = createOnboardHarnessPackageBoundary({
    ...dependencyOverrides,
  });
  const prepared = await boundary.prepare({
    agentFlag: input.agentFlag,
    authoritativeRebuildAgentAuthority: input.authoritativeRebuildAgentAuthority,
    canPrompt: input.canPrompt,
    environment,
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
    revalidateSessionAuthority: (expected, operation) =>
      requireCurrentSessionHarnessPackageAuthority(
        expected,
        operation,
        { env: environment },
        {
          loadSession: dependencyOverrides.loadSession,
          resolveSandboxAgent:
            dependencyOverrides.resolveSandboxAgent ?? PRODUCTION_DEPENDENCIES.resolveSandboxAgent,
        },
      ).authority,
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
