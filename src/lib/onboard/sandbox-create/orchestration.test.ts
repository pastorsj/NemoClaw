// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AgentDefinition } from "../../agent/defs";
import type { SandboxEntry } from "../../state/registry";
import { runSandboxProviderPreDeleteCleanup } from "../sandbox-provider-cleanup";
import {
  assertApfCreateIntent,
  completeHermesPortableSandboxRegistration,
  createProviderEffectBoundary,
  finalizeCreatedSandboxBeforeHermesCredentialReconciliation,
  hasManagedMcpRebuildHandoff,
  installPostCreateRecoveryRetryOwner,
  readManagedDcodeCreateSelectionDrift,
  readSandboxRecreateRegistryEntry,
  prepareSourceBackupAuthority,
  requireSandboxDockerfilePatchPackageRoot,
  reconcileCreatedHermesCredentialEnvironment,
  persistPostCreateRecovery,
  persistRetainedSandboxRecoveryMessage,
  requireSelectedAgentPackageRoot,
  runAuthorityBoundProviderCleanup,
  runAsyncWithPostCreateRecovery,
  runWithPostCreateRecovery,
} from "./orchestration";

const UNVERIFIED_RECOVERY_CONTEXT = {
  gatewayName: "nemoclaw",
  gatewayPort: 8080,
  lifecycleGeneration: "generation-1",
  createAttemptNonce: "a".repeat(62),
} as const;

const RECOVERY_HARNESS_PACKAGE = {
  kind: "agent-runtime" as const,
  id: "openclaw",
  packageVersion: "1.0.0",
  contentDigest: "f".repeat(64),
};

describe("selected agent package authority", () => {
  const SOURCE_PACKAGE = {
    kind: "agent-runtime" as const,
    id: "hermes",
    packageVersion: "0.13.0",
    contentDigest: "a".repeat(64),
  };
  const SOURCE_ENTRY = {
    name: "alpha",
    agent: "hermes",
    harnessPackage: SOURCE_PACKAGE,
  };
  const SOURCE_DEFINITION = {
    name: "hermes",
    packageRoot: `/state/harnesses/objects/${SOURCE_PACKAGE.contentDigest}`,
  } as AgentDefinition;

  it("keeps the OpenClaw null sentinel separate from its effective package root", () => {
    const packageRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-package-")),
    );
    try {
      const effectiveAgent = {
        name: "openclaw",
        displayName: "OpenClaw",
        packageRoot,
      } as AgentDefinition;
      expect(requireSelectedAgentPackageRoot(null, effectiveAgent)).toBe(packageRoot);
    } finally {
      fs.rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("rejects mismatched and missing package authority before creation", () => {
    const missingRoot = path.join(os.tmpdir(), `nemoclaw-missing-package-${String(process.pid)}`);
    expect(() =>
      requireSelectedAgentPackageRoot(
        { name: "hermes" } as AgentDefinition,
        { name: "openclaw", packageRoot: missingRoot } as AgentDefinition,
      ),
    ).toThrow("does not match effective definition");
    expect(() =>
      requireSelectedAgentPackageRoot(null, {
        name: "openclaw",
        packageRoot: missingRoot,
      } as AgentDefinition),
    ).toThrow("package root is missing");
  });

  it("rejects a same-name definition from a different package root", () => {
    const recordedRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-recorded-package-")),
    );
    const effectiveRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-effective-package-")),
    );
    try {
      expect(() =>
        requireSelectedAgentPackageRoot(
          { name: "hermes", packageRoot: recordedRoot } as AgentDefinition,
          { name: "hermes", packageRoot: effectiveRoot } as AgentDefinition,
        ),
      ).toThrow("package root does not match its effective definition");
    } finally {
      fs.rmSync(recordedRoot, { recursive: true, force: true });
      fs.rmSync(effectiveRoot, { recursive: true, force: true });
    }
  });

  it("uses the separately trusted OpenClaw root to patch a Hermes custom Dockerfile", () => {
    const hermesRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-package-")),
    );
    const openClawRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-package-")),
    );
    try {
      const hermes = { name: "hermes", packageRoot: hermesRoot } as AgentDefinition;
      const openClaw = {
        name: "openclaw",
        packageRoot: openClawRoot,
      } as AgentDefinition;
      expect(requireSandboxDockerfilePatchPackageRoot("/tmp/Containerfile", hermes, openClaw)).toBe(
        openClawRoot,
      );
      expect(requireSandboxDockerfilePatchPackageRoot(null, hermes, openClaw)).toBe(hermesRoot);
    } finally {
      fs.rmSync(hermesRoot, { recursive: true, force: true });
      fs.rmSync(openClawRoot, { recursive: true, force: true });
    }
  });

  it("selects pre-recreate backup authority from the registered source agent", () => {
    const resolveSandboxAgent = vi.fn(() => ({
      recordedAgent: "hermes",
      effectiveAgentId: "hermes",
      definition: SOURCE_DEFINITION,
      harnessPackage: SOURCE_PACKAGE,
      harnessPackageMigration: null,
    }));
    const getSandbox = vi.fn(() => structuredClone(SOURCE_ENTRY));

    const authority = prepareSourceBackupAuthority("alpha", SOURCE_ENTRY, {
      getSandbox: getSandbox as never,
      resolveSandboxAgent: resolveSandboxAgent as never,
    });

    expect(authority).toMatchObject({
      agentDefinition: SOURCE_DEFINITION,
      harnessPackage: SOURCE_PACKAGE,
    });
    expect(() => authority?.validateBeforePublish?.()).not.toThrow();
    expect(resolveSandboxAgent).toHaveBeenCalledTimes(2);
  });

  it("does not treat a fresh route reservation as a source sandbox", () => {
    const resolveSandboxAgent = vi.fn();
    const reservation: SandboxEntry = {
      name: "alpha",
      pendingRouteReservation: true,
      reservationSessionId: "session-alpha",
      provider: "compatible-endpoint",
      model: "test-model",
      gatewayName: "nemoclaw",
      harnessPackage: SOURCE_PACKAGE,
    };

    expect(
      prepareSourceBackupAuthority("alpha", reservation, {
        getSandbox: vi.fn(),
        resolveSandboxAgent: resolveSandboxAgent as never,
      }),
    ).toBeNull();
    expect(resolveSandboxAgent).not.toHaveBeenCalled();
  });

  it("keeps backup authority for a route reservation over a registered sandbox", () => {
    const resolveSandboxAgent = vi.fn(() => ({
      recordedAgent: "hermes",
      effectiveAgentId: "hermes",
      definition: SOURCE_DEFINITION,
      harnessPackage: SOURCE_PACKAGE,
      harnessPackageMigration: null,
    }));
    const registeredReservation: SandboxEntry = {
      ...SOURCE_ENTRY,
      pendingRouteReservation: true,
      reservationSessionId: "session-alpha",
      createdAt: "2026-08-30T00:00:00.000Z",
    };

    const authority = prepareSourceBackupAuthority("alpha", registeredReservation, {
      getSandbox: () => structuredClone(registeredReservation),
      resolveSandboxAgent: resolveSandboxAgent as never,
    });

    expect(authority).toMatchObject({
      agentDefinition: SOURCE_DEFINITION,
      harnessPackage: SOURCE_PACKAGE,
    });
    expect(resolveSandboxAgent).toHaveBeenCalledOnce();
  });

  it("rejects source registry or package-object drift before backup publication", () => {
    let currentEntry = structuredClone(SOURCE_ENTRY) as SandboxEntry;
    const changedDefinition = {
      ...SOURCE_DEFINITION,
      packageRoot: "/state/harnesses/objects/replaced",
    } as AgentDefinition;
    const resolveSandboxAgent = vi
      .fn()
      .mockReturnValueOnce({
        recordedAgent: "hermes",
        effectiveAgentId: "hermes",
        definition: SOURCE_DEFINITION,
        harnessPackage: SOURCE_PACKAGE,
        harnessPackageMigration: null,
      })
      .mockReturnValue({
        recordedAgent: "hermes",
        effectiveAgentId: "hermes",
        definition: changedDefinition,
        harnessPackage: SOURCE_PACKAGE,
        harnessPackageMigration: null,
      });
    const getSandbox = vi.fn(() => currentEntry);
    const packageDriftAuthority = prepareSourceBackupAuthority("alpha", SOURCE_ENTRY, {
      getSandbox: getSandbox as never,
      resolveSandboxAgent: resolveSandboxAgent as never,
    });

    expect(() => packageDriftAuthority?.validateBeforePublish?.()).toThrow("source agent package");

    currentEntry = { ...SOURCE_ENTRY, model: "changed-model" };
    const rowDriftAuthority = prepareSourceBackupAuthority("alpha", SOURCE_ENTRY, {
      getSandbox: getSandbox as never,
      resolveSandboxAgent: vi.fn(() => ({
        recordedAgent: "hermes",
        effectiveAgentId: "hermes",
        definition: SOURCE_DEFINITION,
        harnessPackage: SOURCE_PACKAGE,
        harnessPackageMigration: null,
      })) as never,
    });
    expect(() => rowDriftAuthority?.validateBeforePublish?.()).toThrow("source registry row");
  });
});

describe("created Hermes credential environment reconciliation", () => {
  const plan = { agent: "hermes" } as never;

  it("finalizes sandbox registration before reconciling credentials (#9833)", async () => {
    const events: string[] = [];

    await finalizeCreatedSandboxBeforeHermesCredentialReconciliation(
      async () => {
        events.push("registration:start");
        await Promise.resolve();
        events.push("registration:complete");
        return { sandboxName: "alpha" };
      },
      () => events.push("credentials:reconcile"),
    );

    expect(events).toEqual([
      "registration:start",
      "registration:complete",
      "credentials:reconcile",
    ]);
  });

  it("restarts and rechecks the managed gateway after changing the env file", () => {
    const events: string[] = [];
    const restart = { status: 0, stdout: "managed completion", stderr: "" };

    reconcileCreatedHermesCredentialEnvironment(
      { sandboxName: "alpha", plan },
      {
        revalidateSandboxIdentity: (operation) => events.push(`identity:${operation}`),
        reconcileCredentialEnv: () => {
          events.push("reconcile");
          return { changed: true };
        },
        restartGateway: () => {
          events.push("restart");
          return restart;
        },
        parseRestartCompletion: (result) => {
          events.push("parse");
          return result === restart ? {} : null;
        },
        waitForGateway: () => {
          events.push("wait");
          return true;
        },
      },
      vi.fn(),
    );

    expect(events).toEqual([
      expect.stringMatching(/^identity:reconciling/u),
      "reconcile",
      expect.stringMatching(/^identity:confirming/u),
      "restart",
      "parse",
      "wait",
      expect.stringMatching(/^identity:completing/u),
    ]);
  });

  it("does not restart when the env file was already reconciled", () => {
    const restartGateway = vi.fn();
    const waitForGateway = vi.fn();

    reconcileCreatedHermesCredentialEnvironment(
      { sandboxName: "alpha", plan },
      {
        revalidateSandboxIdentity: vi.fn(),
        reconcileCredentialEnv: () => ({ changed: false }),
        restartGateway,
        parseRestartCompletion: vi.fn(),
        waitForGateway,
      },
      vi.fn(),
    );

    expect(restartGateway).not.toHaveBeenCalled();
    expect(waitForGateway).not.toHaveBeenCalled();
  });

  it("refuses a same-name replacement at the credential mutation edge (#9833)", () => {
    const expectedIdentity = "identity-a";
    let liveIdentity = expectedIdentity;
    const mutations: string[] = [];
    const revalidateSandboxIdentity = vi.fn(() => {
      liveIdentity === expectedIdentity ||
        (() => {
          throw new Error("sandbox identity changed");
        })();
      liveIdentity = "identity-b";
    });

    expect(() =>
      reconcileCreatedHermesCredentialEnvironment(
        { sandboxName: "alpha", plan },
        {
          revalidateSandboxIdentity,
          reconcileCredentialEnv: ((_plan: never, revalidate?: (operation: string) => void) => {
            revalidate?.("mutating credential environment");
            mutations.push(liveIdentity);
            return { changed: true };
          }) as never,
          restartGateway: vi.fn(),
          parseRestartCompletion: vi.fn(),
          waitForGateway: vi.fn(),
        },
        vi.fn(),
      ),
    ).toThrow(/sandbox identity changed/u);
    expect(mutations).toEqual([]);
  });

  it("fails onboarding when the changed gateway cannot prove restart completion", () => {
    const recordRecovery = vi.fn();
    expect(() =>
      reconcileCreatedHermesCredentialEnvironment(
        { sandboxName: "alpha", plan },
        {
          revalidateSandboxIdentity: vi.fn(),
          reconcileCredentialEnv: () => ({ changed: true }),
          restartGateway: () => ({ status: 1, stdout: "", stderr: "failed" }),
          parseRestartCompletion: () => null,
          waitForGateway: vi.fn(),
        },
        recordRecovery,
      ),
    ).toThrow("managed gateway restart did not complete");
    expect(recordRecovery).toHaveBeenCalledOnce();
  });
});

describe("retained create recovery persistence", () => {
  it.each([
    ["available fingerprint", "f".repeat(64)],
    ["unavailable fingerprint", null],
  ])(
    "keeps the create-attempt authority after session sanitization with %s (#9211)",
    async (_case, fingerprint) => {
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-recovery-"));
      const nonce = "a".repeat(62);
      const createAttemptLabel = `ai.nvidia.nemoclaw.create-attempt=${nonce}`;
      const message =
        `Create-attempt label: ${createAttemptLabel}. ` +
        `${fingerprint ? `Durable sandbox identity fingerprint: ${fingerprint}. ` : ""}` +
        "Recovery guidance follows after the authority fields. " +
        "x".repeat(400);

      try {
        vi.stubEnv("HOME", tempHome);
        vi.resetModules();
        const session = await import("../../state/onboard-session");
        session.saveSession(
          session.createSession({
            agent: "openclaw",
            harnessPackage: RECOVERY_HARNESS_PACKAGE,
            sandboxName: "alpha",
          }),
        );

        expect(
          persistRetainedSandboxRecoveryMessage(
            {
              sandboxName: "alpha",
              message,
              ...(fingerprint ? { sandboxIdentityFingerprint: fingerprint } : {}),
              recoveryContext: UNVERIFIED_RECOVERY_CONTEXT,
            },
            session.markRetainedSandboxRecovery,
          ),
        ).toBe(true);

        const stored = session.loadSession();
        expect(stored?.status).toBe("recovery_required");
        expect(stored?.resumable).toBe(false);
        expect(stored?.cancellationRecovery?.reason).toBe(
          "retained_after_sandbox_creation_failure",
        );
        expect(stored?.cancellationRecovery?.sandboxName).toBe("alpha");
        expect(stored?.machine.state).not.toBe("failed");
        expect(stored?.steps.sandbox?.status).not.toBe("failed");
        expect(stored?.failure?.message).toContain(createAttemptLabel);
        expect(stored?.steps.sandbox?.error).toContain(createAttemptLabel);
        const fingerprintExpectation = fingerprint
          ? expect.stringContaining(fingerprint)
          : expect.not.stringContaining("Durable sandbox identity fingerprint:");
        expect(stored?.failure?.message).toEqual(fingerprintExpectation);
        expect(stored?.steps.sandbox?.error).toEqual(fingerprintExpectation);
      } finally {
        vi.resetModules();
        fs.rmSync(tempHome, { force: true, recursive: true });
        vi.unstubAllEnvs();
      }
    },
  );

  it("forwards the full verified recovery tuple to durable state (#9833)", () => {
    const recoveryContext = {
      gatewayName: "nemoclaw-18080",
      gatewayPort: 18080,
      lifecycleGeneration: "00000000-0000-4000-8000-000000000004",
      createAttemptNonce: "b".repeat(62),
    } as const;
    const markRetainedSandboxRecovery = vi.fn(() => true);
    const input = {
      stage: "registry publication" as const,
      sandboxName: "alpha",
      gatewayName: recoveryContext.gatewayName,
      lifecycleGeneration: recoveryContext.lifecycleGeneration,
      exactIdentity: "f".repeat(64),
      recoveryContext,
      markRetainedSandboxRecovery,
    };

    persistPostCreateRecovery(input);

    expect(markRetainedSandboxRecovery).toHaveBeenCalledWith(
      "alpha",
      expect.stringContaining(recoveryContext.lifecycleGeneration),
      "f".repeat(64),
      recoveryContext,
    );
  });

  it("reports persistence failure when no onboard session owns the recovery (#9211)", () => {
    const finalizeIncompleteOnboardStep = vi.fn(() => null);

    expect(
      persistRetainedSandboxRecoveryMessage(
        {
          sandboxName: "alpha",
          message: "Create-attempt label: ai.nvidia.nemoclaw.create-attempt=authority",
          recoveryContext: UNVERIFIED_RECOVERY_CONTEXT,
        },
        finalizeIncompleteOnboardStep,
      ),
    ).toBe(false);
    expect(finalizeIncompleteOnboardStep).toHaveBeenCalledExactlyOnceWith(
      "alpha",
      "Create-attempt label: ai.nvidia.nemoclaw.create-attempt=authority",
      undefined,
      UNVERIFIED_RECOVERY_CONTEXT,
    );
  });

  it("reports persistence failure when the onboard session is already terminal (#9211)", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-recovery-"));

    try {
      vi.stubEnv("HOME", tempHome);
      vi.resetModules();
      const session = await import("../../state/onboard-session");
      session.saveSession(
        session.createSession({
          agent: "openclaw",
          harnessPackage: RECOVERY_HARNESS_PACKAGE,
          sandboxName: "alpha",
        }),
      );
      session.finalizeIncompleteOnboardStep("sandbox", "Earlier sandbox failure");

      expect(
        persistRetainedSandboxRecoveryMessage(
          {
            sandboxName: "alpha",
            message: "Create-attempt label: ai.nvidia.nemoclaw.create-attempt=unpersisted",
            recoveryContext: UNVERIFIED_RECOVERY_CONTEXT,
          },
          session.markRetainedSandboxRecovery,
        ),
      ).toBe(true);

      const stored = session.loadSession();
      expect(stored?.status).toBe("recovery_required");
      expect(stored?.failure?.message).toContain("create-attempt=unpersisted");
      expect(stored?.steps.sandbox?.error).toContain("create-attempt=unpersisted");
    } finally {
      vi.resetModules();
      fs.rmSync(tempHome, { force: true, recursive: true });
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ["registry publication", "false"],
    ["registry publication", "throw"],
    ["registry publication", "journal readback mismatch"],
    ["onboarding finalization", "false"],
    ["onboarding finalization", "throw"],
    ["onboarding finalization", "journal readback mismatch"],
  ] as const)(
    "keeps the original %s error when recovery persistence returns %s (#9833)",
    async (stage, failureMode) => {
      const operationError = new Error(`${stage} failed`);
      const recoveryFailures = {
        false: () => false,
        throw: () => {
          throw new Error("retained sandbox recovery writer threw");
        },
        "journal readback mismatch": () => {
          throw new Error("Retained sandbox recovery record did not survive durable readback.");
        },
      } satisfies Record<typeof failureMode, () => false | never>;
      const markRetainedSandboxRecovery = vi.fn(recoveryFailures[failureMode]);
      const recordRecovery = () =>
        persistPostCreateRecovery({
          stage,
          sandboxName: "alpha",
          gatewayName: "nemoclaw",
          lifecycleGeneration: "generation-1",
          exactIdentity: "f".repeat(64),
          recoveryContext: UNVERIFIED_RECOVERY_CONTEXT,
          markRetainedSandboxRecovery,
        });

      const caught =
        stage === "registry publication"
          ? await runAsyncWithPostCreateRecovery(
              async () => Promise.reject(operationError),
              recordRecovery,
            ).catch((error: unknown) => error)
          : (() => {
              try {
                return runWithPostCreateRecovery(() => {
                  throw operationError;
                }, recordRecovery);
              } catch (error) {
                return error;
              }
            })();

      expect(caught).toBeInstanceOf(AggregateError);
      expect((caught as AggregateError).errors).toEqual(
        expect.arrayContaining([
          operationError,
          expect.objectContaining({
            message: expect.stringContaining("could not save the retained sandbox recovery"),
          }),
        ]),
      );
      expect(((caught as AggregateError).errors[1] as Error).cause).toEqual(
        failureMode === "false"
          ? undefined
          : expect.objectContaining({
              message: expect.stringMatching(/writer threw|did not survive durable readback/u),
            }),
      );
    },
  );

  it.each(["registry publication", "onboarding finalization"] as const)(
    "retries %s recovery at exit without rerunning the failed operation (#9833)",
    async (stage) => {
      const exitHandlers: Array<() => void> = [];
      const owner = installPostCreateRecoveryRetryOwner({
        log: vi.fn(),
        registerExitHandler: (handler) => exitHandlers.push(handler),
      });
      const operationError = new Error(`${stage} failed`);
      const operation = vi.fn(() => {
        throw operationError;
      });
      const recordRecovery = vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("retained recovery write failed");
        })
        .mockImplementationOnce(() => undefined);
      const recordWithOwner = () => owner.record(recordRecovery);

      const caught =
        stage === "registry publication"
          ? await runAsyncWithPostCreateRecovery(async () => operation(), recordWithOwner).catch(
              (error: unknown) => error,
            )
          : (() => {
              try {
                return runWithPostCreateRecovery(operation, recordWithOwner);
              } catch (error) {
                return error;
              }
            })();

      expect(caught).toBeInstanceOf(AggregateError);
      expect(operation).toHaveBeenCalledOnce();
      expect(recordRecovery).toHaveBeenCalledOnce();

      exitHandlers[0]();
      expect(recordRecovery).toHaveBeenCalledTimes(2);
      expect(operation).toHaveBeenCalledOnce();

      exitHandlers[0]();
      expect(recordRecovery).toHaveBeenCalledTimes(2);
    },
  );
});

describe("APF create policy selection", () => {
  it("requires APF effects to use the generic post-create gate (#9833)", () => {
    expect(() =>
      assertApfCreateIntent({
        apfInterceptorRequested: true,
      }),
    ).toThrow(/missing deferred-effect authority/u);
    expect(() =>
      assertApfCreateIntent({
        apfInterceptorRequested: true,
        deferSandboxEffectsUntilIdentityVerification: true,
      }),
    ).not.toThrow();
    expect(() => assertApfCreateIntent(null)).not.toThrow();
  });
});

describe("deferred provider effect authority", () => {
  it("carries identity authority through every provider cleanup effect (#9833)", () => {
    let liveIdentity = "identity-a";
    const operations: string[] = [];
    const revalidateSandboxIdentity = vi.fn((operation: string) => {
      operations.push(operation);
      liveIdentity === "identity-a" ||
        (() => {
          throw new Error("sandbox identity changed");
        })();
    });
    const runProviderPreDeleteCleanup = vi.fn((_sandboxName, deps) => {
      expect(deps.revalidateSandboxIdentity).toBe(revalidateSandboxIdentity);
      deps.revalidateSandboxIdentity?.("detaching provider");
      liveIdentity = "identity-b";
      deps.revalidateSandboxIdentity?.("confirming provider detach");
      return { detached: [], failures: [] };
    });

    expect(() =>
      runAuthorityBoundProviderCleanup({
        sandboxName: "alpha",
        revalidateSandboxIdentity,
        runProviderPreDeleteCleanup,
        runOpenshell: vi.fn(),
        redact: (value) => value,
      }),
    ).toThrow(/sandbox identity changed/u);
    expect(runProviderPreDeleteCleanup).toHaveBeenCalledOnce();
    expect(operations).toEqual([
      "cleaning up providers for sandbox 'alpha'",
      "detaching provider",
      "confirming provider detach",
    ]);
  });

  it("refuses provider cleanup when a sandbox appears after verified absence (#9833)", () => {
    let observationCount = 0;
    const revalidateSandboxIdentity = vi.fn();
    const runOpenshell = vi.fn(() => ({
      pid: 1,
      output: [null, "", ""],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
    }));

    expect(() =>
      runAuthorityBoundProviderCleanup({
        sandboxName: "alpha",
        observeSandbox: () =>
          observationCount++ === 0
            ? { state: "missing", liveIdentityFingerprint: null }
            : { state: "ready", liveIdentityFingerprint: "f".repeat(64) },
        revalidateSandboxIdentity,
        runProviderPreDeleteCleanup: runSandboxProviderPreDeleteCleanup,
        runOpenshell,
        redact: (value) => value,
        tolerateMissingSandbox: true,
      }),
    ).toThrow(/appeared after absence was verified/u);
    expect(revalidateSandboxIdentity).toHaveBeenCalledOnce();
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("refuses every deferred provider attachment before a same-name replacement can receive credentials (#9833)", async () => {
    const revalidateSandboxIdentity = vi.fn();
    const runOpenshell = vi.fn(() => ({ status: 0 }));
    const boundary = createProviderEffectBoundary({
      deferred: true,
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
      preparationInput: {
        openshellDriver: "docker",
        inferenceProvider: null,
        messagingProviders: [],
        messagingProviderRequests: [],
        extraProviders: [],
        gatewayName: "nemoclaw",
      },
      preparationDeps: {
        providerExistsInGateway: vi.fn(() => true),
        runOpenshell: runOpenshell as never,
        cleanupCreateSources: vi.fn(),
      },
      runVerifiedSandboxCreateEffects: null,
      activateDeferredProviderEffects: (revalidate) => {
        revalidate("cleaning up providers for sandbox 'alpha'");
        return ["first", "second"];
      },
      revalidateSandboxIdentityBeforeCreate: vi.fn(),
    });
    const runAfterVerifiedCreate = boundary.runAfterVerifiedCreate;
    expect(runAfterVerifiedCreate).toBeTypeOf("function");

    await expect(
      runAfterVerifiedCreate?.({
        sandboxName: "alpha",
        gatewayName: "nemoclaw",
        gatewayPort: 18790,
        lifecycleGeneration: "generation-1",
        lifecycleLiveIdentityFingerprint: "a".repeat(64),
        route: "direct" as never,
        revalidateSandboxIdentity,
      }),
    ).rejects.toThrow("OpenShell cannot attach providers to the immutable identity");

    expect(runOpenshell).not.toHaveBeenCalledWith(
      expect.arrayContaining(["sandbox", "provider", "attach"]),
      expect.anything(),
    );
    expect(revalidateSandboxIdentity).toHaveBeenCalledWith(
      "attaching deferred providers to sandbox 'alpha'",
    );
  });
});

describe("managed MCP rebuild handoff", () => {
  const targetIntentFingerprint = "a".repeat(64);
  const recreateTransaction = {
    version: 2 as const,
    id: "recreate-1",
    targetGeneration: "generation-1",
    targetIntentFingerprint,
    harnessPackage: null,
  };

  it("accepts only a handoff bound to the same recreate transaction", () => {
    expect(
      hasManagedMcpRebuildHandoff({
        recreate: true,
        toolDisclosure: "progressive",
        observabilityEnabled: false,
        recreateJournalTargetIntentFingerprint: targetIntentFingerprint,
        recreateTransaction,
      }),
    ).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["mismatched", "b".repeat(64)],
  ])("rejects a %s outer rebuild handoff", (_label, handoff) => {
    expect(
      hasManagedMcpRebuildHandoff({
        recreate: true,
        toolDisclosure: "progressive",
        observabilityEnabled: false,
        ...(handoff ? { recreateJournalTargetIntentFingerprint: handoff } : {}),
        recreateTransaction,
      }),
    ).toBe(false);
  });
});

describe("sandbox recreate registry authority", () => {
  it("re-reads the durable source row for Hermes portable recreation (#10056)", () => {
    const durable = { name: "alpha", lifecycleGeneration: "source-generation" } as SandboxEntry;
    const readRegistry = vi.fn(() => durable);

    expect(
      readSandboxRecreateRegistryEntry({
        sandboxName: "alpha",
        recreateTransaction: true,
        existingEntry: null,
        readRegistry,
      }),
    ).toBe(durable);
    expect(readRegistry).toHaveBeenCalledExactlyOnceWith("alpha");
  });

  it("keeps the inspected entry when no recreate transaction exists", () => {
    const inspected = { name: "alpha" } as SandboxEntry;
    const readRegistry = vi.fn(() => null);

    expect(
      readSandboxRecreateRegistryEntry({
        sandboxName: "alpha",
        recreateTransaction: false,
        existingEntry: inspected,
        readRegistry,
      }),
    ).toBe(inspected);
    expect(readRegistry).not.toHaveBeenCalled();
  });
});

describe("managed DCode sandbox create selection", () => {
  it.each([null, "https://openrouter.ai/api/v1"])(
    "passes the selected endpoint to live drift validation: %s (#9555)",
    (endpointUrl) => {
      const readDcodeSelectionDrift = vi.fn(() => ({
        changed: false,
        providerChanged: false,
        modelChanged: false,
        existingProvider: "openrouter",
        existingModel: "openrouter:nvidia/nemotron-3-ultra-550b-a55b",
        unknown: false,
      }));

      readManagedDcodeCreateSelectionDrift(
        {
          sandboxName: "saved",
          provider: "compatible-endpoint",
          model: "nvidia/nemotron-3-ultra-550b-a55b",
          preferredInferenceApi: "openai-completions",
          createIntent: { endpointUrl },
        },
        readDcodeSelectionDrift,
      );

      expect(readDcodeSelectionDrift).toHaveBeenCalledWith(
        "saved",
        "compatible-endpoint",
        "nvidia/nemotron-3-ultra-550b-a55b",
        "openai-completions",
        endpointUrl,
      );
    },
  );
});

describe("Hermes portable registration adapter", () => {
  it("returns the durable normalized registry entry after registration (#9211)", async () => {
    const events: string[] = [];
    const raw = { name: "alpha", dashboardPort: 0 } as SandboxEntry;
    const durable = { name: "alpha", dashboardPort: null } as SandboxEntry;
    const completeRegistration = vi.fn(async () => {
      events.push("complete");
      return raw;
    });
    const readRegistry = vi.fn(() => {
      events.push("read");
      return durable;
    });

    await expect(
      completeHermesPortableSandboxRegistration({
        sandboxName: "alpha",
        completeRegistration,
        readRegistry,
      }),
    ).resolves.toBe(durable);
    expect(completeRegistration).toHaveBeenCalledOnce();
    expect(readRegistry).toHaveBeenCalledExactlyOnceWith("alpha");
    expect(events).toEqual(["complete", "read"]);
  });

  it("rejects a missing durable registry entry after registration (#9211)", async () => {
    const completeRegistration = vi.fn(async () => undefined);
    const readRegistry = vi.fn(() => null);

    await expect(
      completeHermesPortableSandboxRegistration({
        sandboxName: "alpha",
        completeRegistration,
        readRegistry,
      }),
    ).rejects.toThrow("Hermes portable sandbox registration returned no authority");
    expect(completeRegistration).toHaveBeenCalledOnce();
    expect(readRegistry).toHaveBeenCalledExactlyOnceWith("alpha");
  });
});
