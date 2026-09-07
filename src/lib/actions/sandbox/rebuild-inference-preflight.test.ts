// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResolvedSandboxAgent } from "../../onboard/sandbox-agent";
import {
  runRebuildInferencePreflight,
  type ReceiptRebuildInferencePreflightInput,
} from "./rebuild-preflight-phase";

const PACKAGE_RECEIPT = {
  kind: "agent-runtime",
  id: "future-terminal",
  packageVersion: "1.0.0",
  contentDigest: "a".repeat(64),
} as const;

function preflightInput(
  rebuildPreflight: "inference-invocation" | undefined,
  harnessPackage: ResolvedSandboxAgent["harnessPackage"] = PACKAGE_RECEIPT,
): ReceiptRebuildInferencePreflightInput {
  return {
    sandboxName: "future-box",
    gatewayName: "nemoclaw-8080",
    targetConfig: {
      agentAuthority: { harnessPackage },
      agentDefinition: {
        name: "future-terminal",
        runtime: {
          kind: "terminal",
          interactive_command: "future-terminal",
          smoke_boundary: {
            kind: "managed-launcher",
            launcher: "/usr/local/lib/nemoclaw/future-managed-exec",
            home: "/usr/local/lib/nemoclaw",
          },
        },
        inference: rebuildPreflight ? { route_probe: { rebuild_preflight: rebuildPreflight } } : {},
      },
      resumeConfig: {
        provider: "compatible-endpoint",
        model: "future/model",
        preferredInferenceApi: "openai-completions",
      },
    },
    bail: ((message: string) => {
      throw new Error(message);
    }) as ReceiptRebuildInferencePreflightInput["bail"],
  };
}

describe("receipt-backed rebuild inference preflight", () => {
  afterEach(() => vi.restoreAllMocks());

  it("runs the core-owned invocation for any package that selects it", () => {
    const probe = vi.fn(() => ({ ok: true }) as const);

    expect(runRebuildInferencePreflight(preflightInput("inference-invocation"), probe)).toBe(true);
    expect(probe).toHaveBeenCalledWith({
      sandboxName: "future-box",
      gatewayName: "nemoclaw-8080",
      agentName: "future-terminal",
      provider: "compatible-endpoint",
      model: "future/model",
      preferredInferenceApi: "openai-completions",
      probeBoundary: {
        kind: "managed-launcher",
        launcher: "/usr/local/lib/nemoclaw/future-managed-exec",
        home: "/usr/local/lib/nemoclaw",
      },
    });
  });

  it("does not run an undeclared package probe or revive the no-receipt path", () => {
    const probe = vi.fn(() => ({ ok: true }) as const);

    expect(runRebuildInferencePreflight(preflightInput(undefined), probe)).toBe(true);
    expect(runRebuildInferencePreflight(preflightInput("inference-invocation", null), probe)).toBe(
      true,
    );
    expect(probe).not.toHaveBeenCalled();
  });

  it("fails before mutation when the retained sandbox rejects its route", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const probe = vi.fn(
      () =>
        ({
          ok: false,
          detail: "sandbox inference invocation probe returned HTTP 401",
          httpStatus: 401,
        }) as const,
    );

    expect(() =>
      runRebuildInferencePreflight(preflightInput("inference-invocation"), probe),
    ).toThrow("Recorded inference route smoke check failed");
  });
});
