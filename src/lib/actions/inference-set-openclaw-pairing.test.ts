// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  completeInferencePostCommit,
  finalizeInferenceMutation,
} from "./inference-set-gateway-restart";
import {
  type LegacyOpenClawPairingDeps,
  type LegacyOpenClawPairingTarget,
  settleLegacyOpenClawPairing,
} from "./inference-set/legacy";

const TARGET: LegacyOpenClawPairingTarget = {
  sandboxName: "alpha",
  gatewayName: "nemoclaw-8080",
  openclawVersion: "2026.7.1",
  stateDirectory: "/sandbox/.openclaw",
};
const DEVICE_IDENTITY_SHA256 = "a".repeat(64);

function observation(state: "settled" | "pairing-only") {
  return { state, deviceIdentitySha256: DEVICE_IDENTITY_SHA256 } as const;
}

function pairingDeps(
  options: {
    observePairing?: LegacyOpenClawPairingDeps["observePairing"];
    approval?: ReturnType<LegacyOpenClawPairingDeps["approveScopeRequest"]>;
  } = {},
): LegacyOpenClawPairingDeps {
  return {
    observePairing: vi.fn(options.observePairing ?? (() => observation("settled"))),
    publishScopeRequest: vi.fn(),
    approveScopeRequest: vi.fn(() => options.approval ?? "approved"),
  };
}

describe("settleLegacyOpenClawPairing", () => {
  it("accepts exact settled scope state without publishing a request (#9527)", () => {
    const deps = pairingDeps();

    expect(settleLegacyOpenClawPairing(TARGET, deps)).toEqual({
      ok: true,
    });
    expect(deps.publishScopeRequest).not.toHaveBeenCalled();
    expect(deps.approveScopeRequest).not.toHaveBeenCalled();
  });

  it("approves one device-bound request and requires final settled state (#9527)", () => {
    const order: string[] = [];
    const deps = pairingDeps();
    vi.mocked(deps.observePairing).mockImplementation(() => {
      order.push("observe");
      const state = order.length === 1 ? "pairing-only" : "settled";
      return { state, deviceIdentitySha256: DEVICE_IDENTITY_SHA256 };
    });
    vi.mocked(deps.publishScopeRequest).mockImplementation(() => order.push("publish"));
    vi.mocked(deps.approveScopeRequest).mockImplementation(() => {
      order.push("approve");
      return "approved";
    });

    expect(settleLegacyOpenClawPairing(TARGET, deps)).toEqual({
      ok: true,
    });
    expect(deps.publishScopeRequest).toHaveBeenCalledWith(TARGET);
    expect(deps.approveScopeRequest).toHaveBeenCalledWith(TARGET, DEVICE_IDENTITY_SHA256);
    expect(order).toEqual(["observe", "publish", "approve", "observe"]);
  });

  it("accepts an ambiguous approval only when final state is settled (#9527)", () => {
    const deps = pairingDeps({
      observePairing: vi
        .fn()
        .mockReturnValueOnce(observation("pairing-only"))
        .mockReturnValueOnce(observation("settled")),
      approval: "ambiguous",
    });

    expect(settleLegacyOpenClawPairing(TARGET, deps)).toEqual({
      ok: true,
    });
  });

  it("rejects an ambiguous approval when final state stays pairing-only (#9527)", () => {
    const deps = pairingDeps({
      observePairing: vi.fn(() => observation("pairing-only")),
      approval: "ambiguous",
    });

    expect(settleLegacyOpenClawPairing(TARGET, deps)).toEqual({
      ok: false,
      failureLayer: "approval-ambiguous",
    });
  });

  it("rejects unavailable initial state without exposing observer output (#9527)", () => {
    const deps = pairingDeps({
      observePairing: vi.fn(() => {
        throw new Error("token=do-not-report");
      }),
    });

    const result = settleLegacyOpenClawPairing(TARGET, deps);

    expect(result).toEqual({
      ok: false,
      failureLayer: "initial-state-unavailable",
    });
    expect(JSON.stringify(result)).not.toContain("do-not-report");
    expect(deps.publishScopeRequest).not.toHaveBeenCalled();
    expect(deps.approveScopeRequest).not.toHaveBeenCalled();
  });

  it("reports approval-rejected when scope state stays pairing-only (#9527)", () => {
    const deps = pairingDeps({
      observePairing: vi.fn(() => observation("pairing-only")),
      approval: "rejected",
    });

    expect(settleLegacyOpenClawPairing(TARGET, deps)).toEqual({
      ok: false,
      failureLayer: "approval-rejected",
    });
  });

  it("rejects approved scope state that does not settle (#9527)", () => {
    const deps = pairingDeps({
      observePairing: vi.fn(() => observation("pairing-only")),
    });

    expect(settleLegacyOpenClawPairing(TARGET, deps)).toEqual({
      ok: false,
      failureLayer: "final-state-unsettled",
    });
  });

  it("collapses request publication errors into a credential-free classification (#9527)", () => {
    const deps = pairingDeps({
      observePairing: vi.fn(() => observation("pairing-only")),
    });
    vi.mocked(deps.publishScopeRequest).mockImplementation(() => {
      throw new Error("credential=do-not-report");
    });

    const result = settleLegacyOpenClawPairing(TARGET, deps);

    expect(result).toEqual({
      ok: false,
      failureLayer: "pairing-operation-failed",
    });
    expect(JSON.stringify(result)).not.toContain("do-not-report");
    expect(deps.approveScopeRequest).not.toHaveBeenCalled();
  });

  it("rejects unavailable final state after one approval attempt (#9527)", () => {
    const deps = pairingDeps({
      observePairing: vi
        .fn()
        .mockReturnValueOnce(observation("pairing-only"))
        .mockImplementationOnce(() => {
          throw new Error("raw paired state");
        }),
    });

    expect(settleLegacyOpenClawPairing(TARGET, deps)).toEqual({
      ok: false,
      failureLayer: "final-state-unavailable",
    });
    expect(deps.approveScopeRequest).toHaveBeenCalledOnce();
  });

  it("fails closed when receipt-backed package reconciliation does not converge", () => {
    const appendAuditEntry = vi.fn();
    const log = vi.fn();
    const reconcilePackageSandbox = vi.fn(() => {
      throw new Error("credential=do-not-report");
    });
    const identity = {
      kind: "agent-runtime",
      id: "future-harness",
      packageVersion: "1.0.0",
      contentDigest: "a".repeat(64),
    } as const;
    const mutation = finalizeInferenceMutation(
      {
        agentName: "future-harness",
        configChanged: true,
        nextApi: "openai-completions",
        packageIdentity: identity,
        postCommit: {
          configSync: "required",
          gatewayRestart: {
            kind: "when-api-changes",
            previousApi: "openai-completions",
          },
          sandboxReconcile: {
            kind: "command",
            trigger: "when-config-changes",
            command: ["/usr/local/lib/nemoclaw/inference-reconcile"],
            timeoutSeconds: 30,
          },
        },
        result: {
          sandboxName: "alpha",
          provider: "nvidia-prod",
          model: "nvidia/model-b",
          primaryModelRef: "inference/nvidia/model-b",
          inSandboxConfigSynced: true,
        },
      },
      { appendAuditEntry, log },
    );

    expect(() =>
      completeInferencePostCommit(mutation, {
        appendAuditEntry,
        log,
        restartSandboxGateway: vi.fn(
          () =>
            ({
              ok: true,
              restarted: true,
              healthPassed: true,
              forwardRecovered: true,
            }) as const,
        ),
        reconcilePackageSandbox,
      }),
    ).toThrow("installed package reconciliation did not converge");
    expect(reconcilePackageSandbox).toHaveBeenCalledWith("alpha", identity, {
      kind: "command",
      trigger: "when-config-changes",
      command: ["/usr/local/lib/nemoclaw/inference-reconcile"],
      timeoutSeconds: 30,
    });
    expect(log.mock.calls.flat().join("\n")).not.toContain("Inference route synced");
    expect(appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "inference_set",
        sandbox: "alpha",
        reason:
          "inference set future-harness:nvidia-prod:nvidia/model-b (package reconciliation pending)",
      }),
    );
    expect(JSON.stringify(appendAuditEntry.mock.calls)).not.toContain("credential=");
  });
});
