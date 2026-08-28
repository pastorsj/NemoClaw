// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createHarnessPackageFixture,
  type HarnessPackageFixture,
} from "../../../../test/helpers/harness-packages";
import { loadAgent } from "../../agent/defs";
import { installHarnessPackage } from "../../harness/package-install";
import { resolvePinnedHarnessPackage } from "../../harness/package-store";
import type { HarnessPackageMigration } from "../../harness/package-identity";
import {
  prepareLegacyHarnessMigration,
  reconcileLegacyHarnessMigration,
  type LegacyHarnessMigrationDependencies,
} from "../../state/harness-migration";
import { createSession, type Session } from "../../state/onboard-session";
import type { SandboxRegistry } from "../../state/registry/types";
import {
  prepareOnboardHarnessOperation,
  type BoundOnboardHarnessPackage,
  type OnboardHarnessPackageBoundaryDependencies,
  type PrepareOnboardHarnessOperationInput,
  type PreparedOnboardHarnessOperation,
} from "./boundary";
import { selectOnboardHarnessPackage } from "../package-selection";
import { prepareOnboardSession, type OnboardSessionBootstrapDeps } from "../session-bootstrap";
import { resolveSandboxAgent } from "../sandbox-agent";

const SOURCE_REVISION = "e".repeat(40);
const MIGRATED_AT = "2026-08-28T12:34:56.789Z";

let fixture: HarnessPackageFixture;

function operationInput(
  overrides: Partial<PrepareOnboardHarnessOperationInput> = {},
): PrepareOnboardHarnessOperationInput {
  return {
    agentFlag: null,
    canPrompt: false,
    environment: {},
    log: vi.fn(),
    prompt: vi.fn(async () => "1"),
    resume: false,
    rootDir: fixture.fixtureRoot,
    ...overrides,
  };
}

function legacySession(agent: string | null, sandboxName: string | null = null): Session {
  return createSession({
    agent,
    sandboxName,
    sessionId: "package-ordering-session",
    startedAt: "2026-08-28T10:00:00.000Z",
    updatedAt: "2026-08-28T10:00:00.000Z",
  });
}

function boundaryDependencies(
  getSession: () => Session | null,
  overrides: Partial<OnboardHarnessPackageBoundaryDependencies> = {},
): Pick<OnboardHarnessPackageBoundaryDependencies, "assertWriterLockOwned" | "loadSession"> &
  Partial<OnboardHarnessPackageBoundaryDependencies> {
  return {
    assertWriterLockOwned: vi.fn(),
    loadSession: getSession,
    getBundledRoot: () => fixture.bundledRoot,
    getSourceIdentity: vi.fn(() => ({
      kind: "bundled" as const,
      nemoclawBuildIdentity: {
        nemoclawVersion: "0.0.113",
        sourceRevision: SOURCE_REVISION,
      },
    })),
    getStoreRoot: () => fixture.storeRoot,
    prepareLegacyMigration: (input) =>
      prepareLegacyHarnessMigration(input, {
        loadRegistry: () => ({ defaultSandbox: null, sandboxes: {} }),
        now: () => new Date(MIGRATED_AT),
      }),
    resolveSandboxAgent,
    selectHarnessPackage: selectOnboardHarnessPackage,
    ...overrides,
  };
}

function bootstrapDependencies(
  readSession: () => Session | null,
  writeSession: (session: Session | null) => void,
  events: string[],
): OnboardSessionBootstrapDeps {
  return {
    loadSession: readSession,
    clearSession: vi.fn(() => {
      events.push("clear-session");
      writeSession(null);
    }),
    createSession: vi.fn((overrides?: Partial<Session>) => createSession(overrides)),
    saveSession: vi.fn((session) => {
      events.push("bootstrap");
      writeSession(session);
      return session;
    }),
    updateSession: vi.fn((mutator) => {
      const current = readSession() ?? createSession();
      const next = mutator(current) ?? current;
      writeSession(next);
      return next;
    }),
    applySessionRecovery: vi.fn(),
    setOnboardBrandingAgent: vi.fn(),
    getResumeConfigConflicts: vi.fn(() => []),
    recordResumeConflict: vi.fn(async () => undefined),
    resolvePath: path.resolve,
    cliName: () => "nemoclaw",
    error: vi.fn(),
    exitProcess: vi.fn((code: number): never => {
      throw new Error(`exit ${String(code)}`);
    }),
    requireHostMountRuntimeSupport: vi.fn(),
    resolveResumeCheckpoint: vi.fn(() => ({ status: "none" as const })),
  };
}

async function runRecoveredWorkflow(
  operation: PreparedOnboardHarnessOperation,
  recover: (insideRecoveredOperation: () => Promise<void>) => Promise<void>,
  afterBind: (authority: BoundOnboardHarnessPackage) => Promise<void>,
): Promise<void> {
  await recover(async () => {
    operation.beforeRuntimeEffects();
    await afterBind(operation.requireBoundAuthority());
  });
}

async function runPreparedHarnessWorkflow<T>(
  input: PrepareOnboardHarnessOperationInput,
  dependencies: ReturnType<typeof boundaryDependencies>,
  runRecovered: (operation: PreparedOnboardHarnessOperation) => Promise<T>,
): Promise<T> {
  const operation = await prepareOnboardHarnessOperation(input, dependencies);
  return runRecovered(operation);
}

beforeEach(() => {
  fixture = createHarnessPackageFixture();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fixture.cleanup();
});

describe("onboarding harness package ordering", () => {
  it("runs lock, read-only selection, recovery, binding, bootstrap, then runtime", async () => {
    const installed = fixture.install("openclaw");
    let session: Session | null = legacySession("hermes");
    const priorSession = structuredClone(session);
    const events: string[] = [];
    const storeBefore = fs.readdirSync(fixture.storeRoot, { recursive: true });
    await runPreparedHarnessWorkflow(
      operationInput(),
      boundaryDependencies(() => session, {
        assertWriterLockOwned: vi.fn(() => events.push("lock-asserted")),
        selectHarnessPackage: async (input, overrides) => {
          events.push("prepare");
          return selectOnboardHarnessPackage(input, overrides);
        },
      }),
      async (operation) => {
        expect(session).toEqual(priorSession);
        expect(fs.readdirSync(fixture.storeRoot, { recursive: true })).toEqual(storeBefore);
        await runRecoveredWorkflow(
          operation,
          async (insideRecoveredOperation) => {
            events.push("recovery");
            expect(session).toEqual(priorSession);
            await insideRecoveredOperation();
          },
          async (authority) => {
            events.push("bind");
            await prepareOnboardSession(
              {
                resume: false,
                fresh: true,
                freshHarnessBinding: authority.freshHarnessBinding!,
                requestedFromDockerfile: null,
                requestedSandboxName: null,
                cannotPrompt: true,
                nonInteractive: true,
              },
              bootstrapDependencies(
                () => session,
                (next) => {
                  session = next;
                },
                events,
              ),
            );
            events.push("runtime");
          },
        );
      },
    );

    expect(events).toEqual([
      "lock-asserted",
      "prepare",
      "lock-asserted",
      "recovery",
      "lock-asserted",
      "lock-asserted",
      "bind",
      "clear-session",
      "bootstrap",
      "runtime",
    ]);
    expect(session).toMatchObject({
      agent: null,
      harnessPackage: installed.identity,
      harnessPackageMigration: null,
    });
  });

  it("binds the prepared package through the production locked-runtime hook", async () => {
    fixture.install("openclaw");
    vi.stubEnv("HOME", fixture.fixtureRoot);
    const events: string[] = [];
    const operation = await prepareOnboardHarnessOperation(
      operationInput(),
      boundaryDependencies(() => null, {
        selectHarnessPackage: async (input, overrides) => {
          events.push("selection");
          return selectOnboardHarnessPackage(input, overrides);
        },
        resolveSandboxAgent: (entry, options) => {
          events.push("bind");
          return resolveSandboxAgent(entry, options);
        },
      }),
    );

    events.push("recovery");
    const prepared = await operation.prepareBoundRuntime(
      { acceptThirdPartySoftware: true },
      true,
      () => null,
    );
    events.push("runtime");
    prepared.lockedRuntime.environmentScope?.restore();

    expect(events).toEqual(["selection", "recovery", "bind", "runtime"]);
    expect(prepared.harnessAuthority.freshHarnessBinding).toMatchObject({
      kind: "package",
      recordedAgent: null,
    });
  });

  it.each([
    ["missing", (packageRoot: string) => fs.rmSync(packageRoot, { recursive: true, force: true })],
    [
      "corrupt",
      (packageRoot: string) =>
        fs.writeFileSync(path.join(packageRoot, "runtime/payload.txt"), "tampered\n"),
    ],
  ] as const)(
    "rejects a freshly selected package that becomes %s during recovery",
    async (_failure, damage) => {
      const installed = fixture.install("openclaw");
      const operation = await prepareOnboardHarnessOperation(
        operationInput(),
        boundaryDependencies(() => null),
      );
      damage(installed.packageRoot);

      expect(() => operation.beforeRuntimeEffects()).toThrow();
      expect(() => operation.requireBoundAuthority()).toThrow("was not bound");
    },
  );

  it("rejects fresh candidate qualification lost during recovery", async () => {
    const candidate = { ...loadAgent("openclaw"), name: "pi" };
    const resolveCandidate = vi.fn().mockReturnValueOnce(null);
    const operation = await prepareOnboardHarnessOperation(
      operationInput({ agentFlag: "pi" }),
      boundaryDependencies(() => null, {
        resolveQualifiedAgent: resolveCandidate,
        selectHarnessPackage: async () => ({
          kind: "qualified-agent",
          recordedAgent: "pi",
          harnessPackage: null,
          resolvedPackage: null,
          effectiveDefinition: candidate,
        }),
      }),
    );

    expect(() => operation.beforeRuntimeEffects()).toThrow(
      "qualified harness authority did not survive portable recovery",
    );
    expect(resolveCandidate).toHaveBeenCalledOnce();
    expect(() => operation.requireBoundAuthority()).toThrow("was not bound");
  });

  it("does not enter portable recovery when no harness package is installed", async () => {
    const recover = vi.fn();
    const session = legacySession("hermes");

    await expect(
      runPreparedHarnessWorkflow(
        operationInput(),
        boundaryDependencies(() => session),
        recover,
      ),
    ).rejects.toThrow("nemoclaw harness install");

    expect(recover).not.toHaveBeenCalled();
    expect(session).toEqual(legacySession("hermes"));
    expect(fs.readdirSync(fixture.storeRoot)).toEqual([]);
  });

  it.each([
    ["missing", (packageRoot: string) => fs.rmSync(packageRoot, { recursive: true, force: true })],
    [
      "corrupt",
      (packageRoot: string) =>
        fs.writeFileSync(path.join(packageRoot, "runtime/payload.txt"), "tampered\n"),
    ],
  ] as const)(
    "rejects a pinned package that becomes %s during recovery",
    async (_failure, damage) => {
      const pinned = fixture.install("openclaw");
      const session = createSession({
        agent: null,
        harnessPackage: pinned.identity,
        harnessPackageMigration: null,
      });
      const resolveExact = vi.fn(resolveSandboxAgent);
      const afterBind = vi.fn();
      const operation = await prepareOnboardHarnessOperation(
        operationInput({ resume: true }),
        boundaryDependencies(() => session, { resolveSandboxAgent: resolveExact }),
      );

      await expect(
        runRecoveredWorkflow(
          operation,
          async (insideRecoveredOperation) => {
            damage(pinned.packageRoot);
            await insideRecoveredOperation();
          },
          afterBind,
        ),
      ).rejects.toThrow();

      expect(resolveExact).toHaveBeenCalledTimes(2);
      expect(afterBind).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["session id", (session: Session) => ({ ...session, sessionId: "changed-session" })],
    ["agent", (session: Session) => ({ ...session, agent: "hermes" })],
    [
      "package identity",
      (session: Session) => ({
        ...session,
        harnessPackage: { ...session.harnessPackage!, contentDigest: "b".repeat(64) },
      }),
    ],
    [
      "migration",
      (session: Session) => ({
        ...session,
        harnessPackageMigration: {
          ...session.harnessPackageMigration!,
          migratedAt: "2026-08-28T13:34:56.789Z",
        },
      }),
    ],
  ] as const)("rejects post-recovery %s drift before a second exact read", async (_name, drift) => {
    const pinned = fixture.install("openclaw");
    const migration: HarnessPackageMigration = {
      schemaVersion: 1,
      source: "legacy-current-bundle",
      legacyAgent: null,
      migratedAt: MIGRATED_AT,
    };
    let session: Session | null = createSession({
      agent: null,
      harnessPackage: pinned.identity,
      harnessPackageMigration: migration,
    });
    const resolveExact = vi.fn(resolveSandboxAgent);
    const operation = await prepareOnboardHarnessOperation(
      operationInput({ resume: true }),
      boundaryDependencies(() => session, { resolveSandboxAgent: resolveExact }),
    );

    session = drift(structuredClone(session));

    expect(() => operation.beforeRuntimeEffects()).toThrow(
      "package authority changed during portable recovery",
    );
    expect(resolveExact).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["flag", { agentFlag: "nemocua", environment: {} }],
    ["environment", { agentFlag: null, environment: { NEMOCLAW_AGENT: "nemocua" } }],
  ] as const)("rejects a candidate resume %s mismatch before recovery", async (_name, selector) => {
    const session = legacySession("pi");
    const recover = vi.fn();
    const candidate = { ...loadAgent("openclaw"), name: "pi" };

    await expect(
      runPreparedHarnessWorkflow(
        operationInput({ ...selector, resume: true }),
        boundaryDependencies(() => session, {
          resolveQualifiedAgent: vi.fn(() => candidate),
        }),
        recover,
      ),
    ).rejects.toThrow("does not match resumed harness 'pi'");

    expect(recover).not.toHaveBeenCalled();
  });

  it("rejects a qualified candidate resolver that returns another harness", async () => {
    const session = legacySession("pi");
    const recover = vi.fn();

    await expect(
      runPreparedHarnessWorkflow(
        operationInput({ resume: true }),
        boundaryDependencies(() => session, {
          resolveQualifiedAgent: vi.fn(() => loadAgent("openclaw")),
        }),
        recover,
      ),
    ).rejects.toThrow("resolved as unexpected harness 'openclaw'");
    expect(recover).not.toHaveBeenCalled();
  });

  it.each(["pi", "nemocua"] as const)(
    "requalifies the package-free %s agent after benign recovery updates",
    async (agentId) => {
      let session: Session | null = legacySession(agentId);
      const candidate = { ...loadAgent("openclaw"), name: agentId };
      const resolveCandidate = vi.fn(() => candidate);
      const operation = await prepareOnboardHarnessOperation(
        operationInput({ resume: true }),
        boundaryDependencies(() => session, {
          resolveQualifiedAgent: resolveCandidate,
        }),
      );
      session = { ...session, updatedAt: "2026-08-28T11:00:00.000Z" };

      operation.beforeRuntimeEffects();
      const authority = operation.requireBoundAuthority();

      expect(resolveCandidate).toHaveBeenCalledTimes(2);
      expect(authority).toMatchObject({
        effectiveDefinition: { name: agentId },
        freshHarnessBinding: null,
        selectedAgent: { name: agentId },
        selectionIsAuthoritative: true,
      });
    },
  );

  it("rejects candidate qualification lost during portable recovery", async () => {
    const session = legacySession("pi");
    const candidate = { ...loadAgent("openclaw"), name: "pi" };
    const resolveCandidate = vi.fn().mockReturnValueOnce(candidate).mockReturnValueOnce(null);
    const operation = await prepareOnboardHarnessOperation(
      operationInput({ resume: true }),
      boundaryDependencies(() => session, {
        resolveQualifiedAgent: resolveCandidate,
      }),
    );

    expect(() => operation.beforeRuntimeEffects()).toThrow("did not survive portable recovery");
    expect(resolveCandidate).toHaveBeenCalledTimes(2);
  });

  it("rejects a legacy environment mismatch before migration or recovery", async () => {
    const session = legacySession("hermes");
    const prepareMigration = vi.fn();
    const recover = vi.fn();

    await expect(
      runPreparedHarnessWorkflow(
        operationInput({
          environment: { NEMOCLAW_AGENT: "openclaw" },
          resume: true,
        }),
        boundaryDependencies(() => session, {
          prepareLegacyMigration: prepareMigration,
        }),
        recover,
      ),
    ).rejects.toThrow("does not match resumed harness 'hermes'");

    expect(prepareMigration).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  });

  it("recovers unchanged legacy owner bytes before package install and owner CAS", async () => {
    let session: Session | null = legacySession(null, "owner");
    let registry: SandboxRegistry = {
      defaultSandbox: null,
      sandboxes: {
        owner: { name: "owner", agent: null, createdAt: "2026-08-28T09:00:00.000Z" },
      },
    };
    const priorSession = structuredClone(session);
    const priorRegistry = structuredClone(registry);
    const events: string[] = ["lock"];
    const reconcileDependencies: Partial<LegacyHarnessMigrationDependencies> = {
      assertWriterLockOwned: vi.fn(),
      compareAndSwapSession: (matches, mutator) => {
        events.push("session-cas");
        const candidate = structuredClone(session!);
        const matched = matches(candidate);
        session = matched ? structuredClone(mutator(candidate) ?? candidate) : session;
        return matched ? "updated" : "mismatch";
      },
      installPackage: (source, options) => {
        events.push("package-install");
        return installHarnessPackage(source, options);
      },
      loadRegistry: () => structuredClone(registry),
      loadSession: () => structuredClone(session),
      resolvePinnedPackage: (identity, options) => {
        events.push("exact-read");
        return resolvePinnedHarnessPackage(identity, options);
      },
      saveRegistry: (next) => {
        events.push("registry-save");
        registry = structuredClone(next);
      },
      withRegistryLock: (operation) => operation(),
    };
    const operation = await prepareOnboardHarnessOperation(
      operationInput({ resume: true }),
      boundaryDependencies(() => session, {
        prepareLegacyMigration: (input) => {
          events.push("legacy-prepare");
          return prepareLegacyHarnessMigration(input, {
            loadRegistry: () => structuredClone(registry),
            now: () => new Date(MIGRATED_AT),
          });
        },
        reconcileLegacyMigration: (prepared) => {
          events.push("bind");
          return reconcileLegacyHarnessMigration(prepared, reconcileDependencies);
        },
      }),
    );
    expect(session).toEqual(priorSession);
    expect(registry).toEqual(priorRegistry);

    await runRecoveredWorkflow(
      operation,
      async (insideRecoveredOperation) => {
        events.push("recovery");
        expect(session).toEqual(priorSession);
        expect(registry).toEqual(priorRegistry);
        session = { ...session!, updatedAt: "2026-08-28T11:00:00.000Z" };
        registry.sandboxes.owner = {
          ...registry.sandboxes.owner!,
          openshellVersion: "0.0.106",
        };
        await insideRecoveredOperation();
      },
      async (authority) => {
        events.push("runtime");
        expect(authority.effectiveDefinition?.packageRoot).toContain(fixture.storeRoot);
      },
    );

    expect(events).toEqual([
      "lock",
      "legacy-prepare",
      "recovery",
      "bind",
      "package-install",
      "exact-read",
      "session-cas",
      "registry-save",
      "runtime",
    ]);
    expect(session?.harnessPackage).toEqual(registry.sandboxes.owner?.harnessPackage);
    expect(session?.harnessPackageMigration).toEqual(
      registry.sandboxes.owner?.harnessPackageMigration,
    );
    expect(session?.updatedAt).toBe("2026-08-28T11:00:00.000Z");
    expect(registry.sandboxes.owner?.openshellVersion).toBe("0.0.106");
  });
});
