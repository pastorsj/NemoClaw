// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  createProviderEffectBoundary,
  installPostCreateRecoveryRetryOwner,
  runSandboxCreateWithIdentityVerification,
} from "./orchestration";

describe("sandbox create identity checks", () => {
  const exactIdentity = "a".repeat(64);
  const verifiedCreateBoundary = () => ({
    captureVerifiedCreateBoundary: vi.fn(() => "verified"),
    persistCreateIdentity: vi.fn(),
    revalidateVerifiedCreateIdentity: vi.fn(),
  });
  const exactIdentityBoundary = () => ({
    captureCreatedSandboxIdentity: vi.fn(() => exactIdentity),
    persistCreatedSandboxIdentity: vi.fn(),
    revalidateCreatedSandboxIdentity: vi.fn(),
    ...verifiedCreateBoundary(),
  });

  it("refuses sandbox creation before mutation when the final check fails (#9833)", async () => {
    const create = vi.fn(async () => "created");

    await expect(
      runSandboxCreateWithIdentityVerification({
        sandboxName: "alpha",
        revalidate: () => {
          throw new Error("create boundary changed before the selected route");
        },
        ...exactIdentityBoundary(),
        create,
        cleanupTemporarySources: vi.fn(),
      }),
    ).rejects.toThrow(/create boundary changed before/u);
    expect(create).not.toHaveBeenCalled();
  });

  it("checks the named Ready sandbox before registration can continue (#9833)", async () => {
    const events: string[] = [];
    const result = await runSandboxCreateWithIdentityVerification({
      sandboxName: "alpha",
      revalidate: (sandboxIsLive) => events.push(sandboxIsLive ? "ready-check" : "create-check"),
      create: async (verifyCreatedSandbox) => {
        events.push("create");
        await verifyCreatedSandbox("created");
        return "created";
      },
      captureCreatedSandboxIdentity: () => {
        events.push("capture-identity");
        return exactIdentity;
      },
      persistCreatedSandboxIdentity: () => events.push("persist-identity"),
      revalidateCreatedSandboxIdentity: () => events.push("identity-check"),
      captureVerifiedCreateBoundary: () => {
        events.push("boundary-check");
        return "verified";
      },
      persistCreateIdentity: () => events.push("persist-checkpoint"),
      revalidateVerifiedCreateIdentity: () => events.push("revalidate-checkpoint"),
      cleanupTemporarySources: vi.fn(),
    });
    events.push("register");

    expect(result).toBe("created");
    expect(events).toEqual([
      "create-check",
      "create",
      "capture-identity",
      "persist-identity",
      "identity-check",
      "boundary-check",
      "identity-check",
      "persist-checkpoint",
      "revalidate-checkpoint",
      "identity-check",
      "identity-check",
      "register",
    ]);
  });

  it("removes temporary sources but preserves the sandbox after final identity failure (#9833)", async () => {
    const events: string[] = [];
    const createAttemptNonce = "c".repeat(62);
    const revalidate = vi.fn(() => events.push("create-check"));

    const error = await runSandboxCreateWithIdentityVerification({
      sandboxName: "alpha",
      revalidate,
      create: async (verifyCreatedSandbox) => {
        events.push("create");
        await verifyCreatedSandbox("created");
        return "created";
      },
      ...exactIdentityBoundary(),
      captureCreatedSandboxCreateAttemptNonce: () => createAttemptNonce,
      revalidateVerifiedCreateIdentity: () => {
        events.push("ready-check");
        throw new Error("sandbox identity changed");
      },
      cleanupTemporarySources: () => events.push("cleanup-sources"),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toMatch(
      new RegExp(
        `Create-attempt label: ai\\.nvidia\\.nemoclaw\\.create-attempt=${createAttemptNonce}.*left sandbox 'alpha' in place.*identity fingerprint: ${exactIdentity}.*did not run OpenShell's mutable-name deletion command.*Do not delete the sandbox by mutable sandbox name.*OpenShell administrator.*identity-bound recovery or removal procedure`,
        "u",
      ),
    );
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(
            new RegExp(
              `Create-attempt label: ai\\.nvidia\\.nemoclaw\\.create-attempt=${createAttemptNonce}.*left sandbox 'alpha' in place.*identity fingerprint: ${exactIdentity}.*did not run OpenShell's mutable-name deletion command.*Do not delete the sandbox by mutable sandbox name.*OpenShell administrator.*identity-bound recovery or removal procedure`,
              "u",
            ),
          ),
        }),
      ]),
    );
    expect(events).toEqual(["create-check", "create", "ready-check", "cleanup-sources"]);
  });

  it("records recovery before returning a post-create identity failure (#9833)", async () => {
    const persistRetainedSandboxRecovery = vi.fn(() => true);

    await expect(
      runSandboxCreateWithIdentityVerification({
        sandboxName: "alpha",
        revalidate: vi.fn(),
        create: async (verifyCreatedSandbox) => {
          await verifyCreatedSandbox("created");
          return "created";
        },
        ...exactIdentityBoundary(),
        revalidateVerifiedCreateIdentity: () => {
          throw new Error("sandbox identity changed");
        },
        persistRetainedSandboxRecovery,
        cleanupTemporarySources: vi.fn(),
      }),
    ).rejects.toThrow("automatic sandbox cleanup was not safe");

    expect(persistRetainedSandboxRecovery).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("left sandbox 'alpha' in place"),
      exactIdentity,
      "verified",
      "created",
    );
  });

  it("retains the exact create identity when checkpoint persistence fails (#9833)", async () => {
    const verifiedEvidence = { lifecycleGeneration: "generation-4" } as const;
    const persistRetainedSandboxRecovery = vi.fn(() => true);

    await expect(
      runSandboxCreateWithIdentityVerification({
        sandboxName: "alpha",
        revalidate: vi.fn(),
        create: async (verifyCreatedSandbox) => {
          await verifyCreatedSandbox("created");
          return "created";
        },
        ...exactIdentityBoundary(),
        captureVerifiedCreateBoundary: () => verifiedEvidence,
        persistCreateIdentity: () => {
          throw new Error("checkpoint write failed");
        },
        persistRetainedSandboxRecovery,
        cleanupTemporarySources: vi.fn(),
      }),
    ).rejects.toThrow("automatic sandbox cleanup was not safe");

    expect(persistRetainedSandboxRecovery).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("left sandbox 'alpha' in place"),
      exactIdentity,
      verifiedEvidence,
      "created",
    );
  });

  it("records recovery when the create runner fails after verification (#9833)", async () => {
    const createFailure = new Error("runtime patch failed after verification");
    const persistRetainedSandboxRecovery = vi.fn(() => true);

    const error = await runSandboxCreateWithIdentityVerification({
      sandboxName: "alpha",
      revalidate: vi.fn(),
      create: async (verifyCreatedSandbox) => {
        await verifyCreatedSandbox("created");
        throw createFailure;
      },
      ...exactIdentityBoundary(),
      persistRetainedSandboxRecovery,
      cleanupTemporarySources: vi.fn(),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toContain(createFailure);
    expect((error as AggregateError).message).toContain(
      "post-create verification or finalization failed",
    );
    expect(persistRetainedSandboxRecovery).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("left sandbox 'alpha' in place"),
      exactIdentity,
      "verified",
      "created",
    );
  });

  it.each(["false", "throw", "journal readback mismatch"] as const)(
    "retries create-runner recovery when its durable writer returns %s (#9833)",
    async (failureMode) => {
      const exitHandlers: Array<() => void> = [];
      const retryOwner = installPostCreateRecoveryRetryOwner({
        log: vi.fn(),
        registerExitHandler: (handler) => exitHandlers.push(handler),
      });
      const createFailure = new Error("runtime patch failed after verification");
      const writerFailures = {
        false: () => false,
        throw: () => {
          throw new Error("retained recovery writer threw");
        },
        "journal readback mismatch": () => {
          throw new Error("Retained sandbox recovery record did not survive durable readback.");
        },
      } satisfies Record<typeof failureMode, () => boolean>;
      const writer = vi
        .fn()
        .mockImplementationOnce(writerFailures[failureMode])
        .mockReturnValue(true);
      const create = vi.fn(async (verifyCreatedSandbox: (created: string) => Promise<string>) => {
        await verifyCreatedSandbox("created");
        throw createFailure;
      });

      const error = await runSandboxCreateWithIdentityVerification({
        sandboxName: "alpha",
        revalidate: vi.fn(),
        create,
        ...exactIdentityBoundary(),
        persistRetainedSandboxRecovery: writer,
        retainedSandboxRecoveryRetryOwner: retryOwner,
        cleanupTemporarySources: vi.fn(),
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AggregateError);
      expect(writer).toHaveBeenCalledOnce();
      expect(create).toHaveBeenCalledOnce();

      exitHandlers[0]();
      expect(writer).toHaveBeenCalledTimes(2);
      expect(create).toHaveBeenCalledOnce();

      exitHandlers[0]();
      expect(writer).toHaveBeenCalledTimes(2);
    },
  );

  it("does not delete a same-name replacement after final identity failure (#9833)", async () => {
    let sandboxIdentity = "created";
    const revalidate = vi.fn();
    const revalidateCreatedSandboxIdentity = vi.fn();

    const error = await runSandboxCreateWithIdentityVerification({
      sandboxName: "alpha",
      revalidate,
      create: async (verifyCreatedSandbox) => {
        await verifyCreatedSandbox("created");
        return "created";
      },
      captureCreatedSandboxIdentity: () => exactIdentity,
      persistCreatedSandboxIdentity: vi.fn(),
      revalidateCreatedSandboxIdentity,
      ...verifiedCreateBoundary(),
      revalidateVerifiedCreateIdentity: () => {
        sandboxIdentity = "replacement";
        throw new Error("sandbox identity changed");
      },
      cleanupTemporarySources: vi.fn(),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(
            new RegExp(
              `left sandbox 'alpha' in place.*identity fingerprint: ${exactIdentity}.*Do not delete the sandbox by mutable sandbox name`,
              "u",
            ),
          ),
        }),
      ]),
    );
    expect(revalidateCreatedSandboxIdentity).toHaveBeenNthCalledWith(
      1,
      exactIdentity,
      "verifying created sandbox 'alpha'",
    );
    expect(revalidateCreatedSandboxIdentity).toHaveBeenNthCalledWith(
      2,
      exactIdentity,
      "recording pending create identity for sandbox 'alpha'",
    );
    expect(sandboxIdentity).toBe("replacement");
  });

  it("retains the durable checkpoint when identity-bound provider attachment is unavailable (#9833)", async () => {
    const runOpenshell = vi.fn(() => ({ status: 0 }));
    const checkpoint = { state: "absent" };
    const providerBoundary = createProviderEffectBoundary({
      deferred: true,
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
      preparationInput: {
        openshellDriver: "kubernetes",
        inferenceProvider: null,
        messagingProviders: [],
        messagingProviderRequests: [],
        extraProviders: [],
        gatewayName: "nemoclaw",
      },
      preparationDeps: {
        runOpenshell: runOpenshell as never,
        cleanupCreateSources: vi.fn(),
      },
      runVerifiedSandboxCreateEffects: null,
      activateDeferredProviderEffects: async () => ["credential-provider"],
      revalidateSandboxIdentityBeforeCreate: vi.fn(),
    });
    const error = await runSandboxCreateWithIdentityVerification({
      sandboxName: "alpha",
      revalidate: vi.fn(),
      create: async (verifyCreatedSandbox) => {
        await verifyCreatedSandbox("created");
        return "created";
      },
      ...exactIdentityBoundary(),
      persistCreateIdentity: () => {
        checkpoint.state = "verified-create";
      },
      runVerifiedCreateEffects: async () => {
        await providerBoundary.runAfterVerifiedCreate?.({
          sandboxName: "alpha",
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          lifecycleGeneration: "00000000-0000-4000-8000-000000000001",
          lifecycleLiveIdentityFingerprint: exactIdentity,
          route: "none",
          revalidateSandboxIdentity: vi.fn(),
        });
      },
      cleanupTemporarySources: vi.fn(),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect(checkpoint.state).toBe("verified-create");
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("reports temporary source cleanup failure with sandbox preservation (#9833)", async () => {
    const revalidate = vi.fn();

    const error = await runSandboxCreateWithIdentityVerification({
      sandboxName: "alpha",
      revalidate,
      create: async (verifyCreatedSandbox) => {
        await verifyCreatedSandbox("created");
        return "created";
      },
      ...exactIdentityBoundary(),
      revalidateVerifiedCreateIdentity: () => {
        throw new Error("sandbox identity changed");
      },
      cleanupTemporarySources: () => {
        throw new Error("temporary source cleanup failed");
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "temporary source cleanup failed" }),
        expect.objectContaining({ message: expect.stringContaining("left sandbox 'alpha'") }),
      ]),
    );
  });

  it("runs continuation effects only after identity verification (#9833)", async () => {
    const events: string[] = [];

    const result = await runSandboxCreateWithIdentityVerification({
      sandboxName: "alpha",
      revalidate: (sandboxIsLive) => events.push(sandboxIsLive ? "identity" : "preflight"),
      create: async (verifyCreatedSandbox) => {
        events.push("create");
        await verifyCreatedSandbox({ sandboxName: "alpha" });
        return "complete";
      },
      runVerifiedCreateEffects: async () => {
        events.push("provider-effects");
      },
      captureCreatedSandboxIdentity: () => {
        events.push("capture");
        return exactIdentity;
      },
      persistCreatedSandboxIdentity: () => events.push("persist-identity"),
      revalidateCreatedSandboxIdentity: () => events.push("identity"),
      captureVerifiedCreateBoundary: () => {
        events.push("boundary");
        return "verified";
      },
      persistCreateIdentity: () => events.push("checkpoint"),
      revalidateVerifiedCreateIdentity: () => events.push("checkpoint-revalidate"),
      cleanupTemporarySources: vi.fn(),
    });

    expect(result).toBe("complete");
    expect(events).toEqual([
      "preflight",
      "create",
      "capture",
      "persist-identity",
      "identity",
      "boundary",
      "identity",
      "checkpoint",
      "checkpoint-revalidate",
      "provider-effects",
      "identity",
      "identity",
    ]);
  });

  it("withholds checkpoint and effects when post-create boundary capture fails (#9833)", async () => {
    const persistCreateIdentity = vi.fn();
    const runVerifiedCreateEffects = vi.fn();

    const error = await runSandboxCreateWithIdentityVerification({
      sandboxName: "alpha",
      revalidate: vi.fn(),
      create: async (verifyCreatedSandbox) => {
        await verifyCreatedSandbox("created");
        return "created";
      },
      captureCreatedSandboxIdentity: () => exactIdentity,
      persistCreatedSandboxIdentity: vi.fn(),
      revalidateCreatedSandboxIdentity: vi.fn(),
      captureVerifiedCreateBoundary: () => {
        throw new Error("identity boundary capture failed");
      },
      persistCreateIdentity,
      revalidateVerifiedCreateIdentity: vi.fn(),
      runVerifiedCreateEffects,
      cleanupTemporarySources: vi.fn(),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "identity boundary capture failed" }),
      ]),
    );
    expect(persistCreateIdentity).not.toHaveBeenCalled();
    expect(runVerifiedCreateEffects).not.toHaveBeenCalled();
  });

  it("withholds effects when durable checkpoint persistence fails (#9833)", async () => {
    const revalidateVerifiedCreateIdentity = vi.fn();
    const runVerifiedCreateEffects = vi.fn();

    await expect(
      runSandboxCreateWithIdentityVerification({
        sandboxName: "alpha",
        revalidate: vi.fn(),
        create: async (verifyCreatedSandbox) => {
          await verifyCreatedSandbox("created");
          return "created";
        },
        captureCreatedSandboxIdentity: () => exactIdentity,
        persistCreatedSandboxIdentity: vi.fn(),
        revalidateCreatedSandboxIdentity: vi.fn(),
        captureVerifiedCreateBoundary: () => "verified",
        persistCreateIdentity: () => {
          throw new Error("checkpoint persistence failed");
        },
        revalidateVerifiedCreateIdentity,
        runVerifiedCreateEffects,
        cleanupTemporarySources: vi.fn(),
      }),
    ).rejects.toThrow("automatic sandbox cleanup was not safe");

    expect(revalidateVerifiedCreateIdentity).not.toHaveBeenCalled();
    expect(runVerifiedCreateEffects).not.toHaveBeenCalled();
  });

  it("retains the checkpoint and withholds effects when its reread fails (#9833)", async () => {
    const persistCreateIdentity = vi.fn();
    const runVerifiedCreateEffects = vi.fn();

    await expect(
      runSandboxCreateWithIdentityVerification({
        sandboxName: "alpha",
        revalidate: vi.fn(),
        create: async (verifyCreatedSandbox) => {
          await verifyCreatedSandbox("created");
          return "created";
        },
        captureCreatedSandboxIdentity: () => exactIdentity,
        persistCreatedSandboxIdentity: vi.fn(),
        revalidateCreatedSandboxIdentity: vi.fn(),
        captureVerifiedCreateBoundary: () => "verified",
        persistCreateIdentity,
        revalidateVerifiedCreateIdentity: () => {
          throw new Error("durable checkpoint missing");
        },
        runVerifiedCreateEffects,
        cleanupTemporarySources: vi.fn(),
      }),
    ).rejects.toThrow("automatic sandbox cleanup was not safe");

    expect(persistCreateIdentity).toHaveBeenCalledOnce();
    expect(runVerifiedCreateEffects).not.toHaveBeenCalled();
  });

  it("retains the durable checkpoint when a deferred effect fails (#9833)", async () => {
    const persistCreateIdentity = vi.fn();

    await expect(
      runSandboxCreateWithIdentityVerification({
        sandboxName: "alpha",
        revalidate: vi.fn(),
        create: async (verifyCreatedSandbox) => {
          await verifyCreatedSandbox("created");
          return "created";
        },
        captureCreatedSandboxIdentity: () => exactIdentity,
        persistCreatedSandboxIdentity: vi.fn(),
        revalidateCreatedSandboxIdentity: vi.fn(),
        captureVerifiedCreateBoundary: () => "verified",
        persistCreateIdentity,
        revalidateVerifiedCreateIdentity: vi.fn(),
        runVerifiedCreateEffects: async () => {
          throw new Error("provider effect failed");
        },
        cleanupTemporarySources: vi.fn(),
      }),
    ).rejects.toThrow("automatic sandbox cleanup was not safe");

    expect(persistCreateIdentity).toHaveBeenCalledOnce();
  });

  it("refuses continuation when identity changes during boundary capture (#9833)", async () => {
    const continuationEffect = vi.fn();
    const persistRetainedSandboxRecovery = vi.fn(() => true);
    const revalidate = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined);
    const revalidateCreatedSandboxIdentity = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("sandbox identity changed");
      });

    await expect(
      runSandboxCreateWithIdentityVerification({
        sandboxName: "alpha",
        revalidate,
        create: async (verifyCreatedSandbox) => {
          await verifyCreatedSandbox("created");
          continuationEffect();
          return "created";
        },
        captureCreatedSandboxIdentity: () => exactIdentity,
        persistCreatedSandboxIdentity: vi.fn(),
        revalidateCreatedSandboxIdentity,
        ...verifiedCreateBoundary(),
        persistRetainedSandboxRecovery,
        cleanupTemporarySources: vi.fn(),
      }),
    ).rejects.toThrow("automatic sandbox cleanup was not safe");

    expect(continuationEffect).not.toHaveBeenCalled();
    expect(persistRetainedSandboxRecovery).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("left sandbox 'alpha' in place"),
      exactIdentity,
      null,
      "created",
    );
  });

  it("stops before boundary capture when the exact identity cannot be persisted (#9833)", async () => {
    const revalidateCreatedSandboxIdentity = vi.fn();
    const captureVerifiedCreateBoundary = vi.fn();
    const persistCreateIdentity = vi.fn();
    const runVerifiedCreateEffects = vi.fn();

    await expect(
      runSandboxCreateWithIdentityVerification({
        sandboxName: "alpha",
        revalidate: vi.fn(),
        create: async (verifyCreatedSandbox) => {
          await verifyCreatedSandbox("created");
          return "created";
        },
        captureCreatedSandboxIdentity: () => exactIdentity,
        persistCreatedSandboxIdentity: () => {
          throw new Error("durable identity journal unavailable");
        },
        revalidateCreatedSandboxIdentity,
        captureVerifiedCreateBoundary,
        persistCreateIdentity,
        revalidateVerifiedCreateIdentity: vi.fn(),
        runVerifiedCreateEffects,
        cleanupTemporarySources: vi.fn(),
      }),
    ).rejects.toThrow("automatic sandbox cleanup was not safe");

    expect(revalidateCreatedSandboxIdentity).not.toHaveBeenCalled();
    expect(captureVerifiedCreateBoundary).not.toHaveBeenCalled();
    expect(persistCreateIdentity).not.toHaveBeenCalled();
    expect(runVerifiedCreateEffects).not.toHaveBeenCalled();
  });

  it("fails closed when a create implementation skips the post-create gate (#9833)", async () => {
    const cleanupTemporarySources = vi.fn();

    const error = await runSandboxCreateWithIdentityVerification({
      sandboxName: "alpha",
      revalidate: vi.fn(),
      create: async () => "created",
      ...exactIdentityBoundary(),
      cleanupTemporarySources,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toMatch(
      /left sandbox 'alpha' in place.*did not return a durable sandbox identity fingerprint.*Do not delete the sandbox by mutable sandbox name.*identity-bound recovery or removal procedure/u,
    );
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("post-create verification") }),
      ]),
    );
    expect(cleanupTemporarySources).toHaveBeenCalledOnce();
  });
});
