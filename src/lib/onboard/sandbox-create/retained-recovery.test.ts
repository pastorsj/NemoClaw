// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  installPostCreateRecoveryRetryOwner,
  persistPostCreateRecovery,
  persistRetainedSandboxRecoveryMessage,
  runAsyncWithPostCreateRecovery,
  runWithPostCreateRecovery,
} from "./orchestration";

const UNVERIFIED_RECOVERY_CONTEXT = {
  gatewayName: "nemoclaw",
  gatewayPort: 8080,
  lifecycleGeneration: "generation-1",
  verifiedEffectivePolicyIdentity: null,
  createAttemptNonce: "c".repeat(62),
  policyCreationReceipt: null,
} as const;

const OPENCLAW_HARNESS_PACKAGE = {
  kind: "agent-runtime" as const,
  id: "openclaw",
  packageVersion: "1.2.3",
  contentDigest: "a".repeat(64),
};

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
            sandboxName: "alpha",
            harnessPackage: OPENCLAW_HARNESS_PACKAGE,
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
      verifiedEffectivePolicyIdentity: { hash: "sha256:policy-4", activeVersion: 4 },
      createAttemptNonce: "d".repeat(62),
      policyCreationReceipt: {
        schemaVersion: 1,
        origin: "sandbox-create",
        gatewayName: "nemoclaw-18080",
        gatewayPort: 18080,
        sandboxName: "alpha",
        lifecycleGeneration: "00000000-0000-4000-8000-000000000004",
        sandboxIdentityFingerprint: "f".repeat(64),
        policyHash: "sha256:policy-4",
        policyVersion: 4,
      },
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
          sandboxName: "alpha",
          harnessPackage: OPENCLAW_HARNESS_PACKAGE,
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
