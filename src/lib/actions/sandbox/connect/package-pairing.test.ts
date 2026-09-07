// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { settleConnectPackagePairing } from "./package-pairing";

const RECEIPT = Object.freeze({
  kind: "agent-runtime" as const,
  id: "future-harness",
  packageVersion: "1.0.0",
  contentDigest: "a".repeat(64),
});

function resolvedAgent(options: { readonly pairing?: boolean; readonly identity?: boolean } = {}) {
  return {
    recordedAgent: "future-harness",
    effectiveAgentId: "future-harness",
    harnessPackage: RECEIPT,
    harnessPackageMigration: null,
    definition: {
      name: "future-harness",
      displayName: "Future Harness",
      runtime: {
        kind: "gateway" as const,
        ...(options.pairing
          ? {
              device_pairing_settlement: {
                command: ["/usr/local/bin/future-pairing"],
                timeout_seconds: 30,
              },
            }
          : {}),
      },
      managedImage: options.identity ? { runtime_identity: { uid: 1200, gid: 1201 } } : undefined,
    },
  } as never;
}

describe("receipt-backed connect pairing", () => {
  it("leaves a receiptless sandbox to the legacy compatibility path", async () => {
    const resolveAgent = vi.fn();
    await expect(
      settleConnectPackagePairing("alpha", {
        getSandbox: () => null,
        resolveAgent,
        settlePairing: vi.fn(),
      }),
    ).resolves.toEqual({ kind: "not-package" });
    expect(resolveAgent).not.toHaveBeenCalled();
  });

  it("does not run an OpenClaw fallback for an unknown package without pairing", async () => {
    const settlePairing = vi.fn();
    await expect(
      settleConnectPackagePairing("alpha", {
        getSandbox: () => ({ agent: "future-harness", harnessPackage: RECEIPT }) as never,
        resolveAgent: () => resolvedAgent(),
        settlePairing,
      }),
    ).resolves.toEqual({ kind: "not-required" });
    expect(settlePairing).not.toHaveBeenCalled();
  });

  it("executes the receipt declaration with the package runtime identity", async () => {
    const settlePairing = vi.fn(async () => ({ kind: "settled" as const }));
    await expect(
      settleConnectPackagePairing("alpha", {
        getSandbox: () => ({ agent: "future-harness", harnessPackage: RECEIPT }) as never,
        resolveAgent: () => resolvedAgent({ pairing: true, identity: true }),
        settlePairing,
      }),
    ).resolves.toEqual({ kind: "settled" });
    expect(settlePairing).toHaveBeenCalledWith(
      "alpha",
      "future-harness",
      { command: ["/usr/local/bin/future-pairing"], timeout_seconds: 30 },
      { uid: 1200, gid: 1201 },
    );
  });

  it("fails closed when a pairing declaration has no managed runtime identity", async () => {
    const settlePairing = vi.fn();
    const result = await settleConnectPackagePairing("alpha", {
      getSandbox: () => ({ agent: "future-harness", harnessPackage: RECEIPT }) as never,
      resolveAgent: () => resolvedAgent({ pairing: true }),
      settlePairing,
    });
    expect(result).toEqual({
      kind: "incomplete",
      message: expect.stringContaining("has no package runtime identity"),
    });
    expect(settlePairing).not.toHaveBeenCalled();
  });
});
