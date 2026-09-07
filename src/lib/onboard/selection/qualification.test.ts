// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  buildSelectionQualificationRequest,
  readPackageSelectionQualification,
} from "./qualification";

const NONCE = "a".repeat(64);
const DECLARATION = {
  command: ["/usr/local/bin/future-selection-qualify"],
  timeout_seconds: 21,
} as const;

function qualificationInput() {
  return {
    sandboxName: "future-sandbox",
    packageId: "future-harness",
    declaration: DECLARATION,
    provider: "nvidia-prod",
    model: "nvidia/model-a",
    preferredInferenceApi: "openai-completions",
    endpointUrl: null,
  } as const;
}

describe("receipt-backed package selection qualification", () => {
  it("executes an unknown package's declared qualifier without native dispatch", () => {
    const runCaptureOpenshell = vi.fn(
      (_args: string[], _options: unknown) => `__NEMOCLAW_SELECTION_QUALIFIED__=${NONCE}\n`,
    );
    const revalidateAuthority = vi.fn();

    expect(
      readPackageSelectionQualification(
        { ...qualificationInput(), revalidateAuthority },
        {
          createNonce: () => NONCE,
          getGatewayName: () => "nemoclaw-18081",
          runCaptureOpenshell,
        },
      ),
    ).toEqual({
      changed: false,
      providerChanged: false,
      modelChanged: false,
      existingProvider: "nvidia-prod",
      existingModel: "nvidia/model-a",
      unknown: false,
    });
    const invocation = runCaptureOpenshell.mock.calls[0]?.[0] ?? [];
    expect(invocation.slice(0, 9)).toEqual([
      "sandbox",
      "exec",
      "--name",
      "future-sandbox",
      "--gateway",
      "nemoclaw-18081",
      "--",
      "/usr/local/bin/future-selection-qualify",
      expect.any(String),
    ]);
    expect(invocation.at(-1)).toBe(NONCE);
    expect(JSON.parse(Buffer.from(invocation.at(-2)!, "base64url").toString("utf8"))).toEqual({
      schemaVersion: 1,
      packageId: "future-harness",
      selection: {
        upstreamProvider: "nvidia-prod",
        model: "nvidia/model-a",
        providerKey: "inference",
        baseUrl: "https://inference.local/v1",
        api: "openai-completions",
        endpointUrl: null,
      },
    });
    expect(runCaptureOpenshell.mock.calls[0]?.[1]).toEqual({
      ignoreError: true,
      timeout: 21_000,
      killProcessTreeOnTimeout: true,
    });
    expect(revalidateAuthority).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["missing marker", ""],
    ["wrong nonce", `__NEMOCLAW_SELECTION_QUALIFIED__=${"b".repeat(64)}\n`],
    [
      "ambiguous marker",
      `__NEMOCLAW_SELECTION_QUALIFIED__=${NONCE}\n__NEMOCLAW_SELECTION_QUALIFIED__=${NONCE}\n`,
    ],
    ["additional output", `native diagnostic\n__NEMOCLAW_SELECTION_QUALIFIED__=${NONCE}\n`],
  ])("fails closed on %s", (_case, output) => {
    expect(
      readPackageSelectionQualification(qualificationInput(), {
        createNonce: () => NONCE,
        getGatewayName: () => "nemoclaw-18081",
        runCaptureOpenshell: () => output,
      }),
    ).toMatchObject({ changed: true, unknown: true });
  });

  it("fails closed when package authority changes after execution", () => {
    const revalidateAuthority = vi
      .fn()
      .mockReturnValueOnce(undefined)
      .mockImplementationOnce(() => {
        throw new Error("receipt changed");
      });
    expect(
      readPackageSelectionQualification(
        {
          ...qualificationInput(),
          revalidateAuthority,
        },
        {
          createNonce: () => NONCE,
          getGatewayName: () => "nemoclaw-18081",
          runCaptureOpenshell: () => `__NEMOCLAW_SELECTION_QUALIFIED__=${NONCE}\n`,
        },
      ),
    ).toMatchObject({ changed: true, unknown: true });
  });

  it("rejects credential-bearing compatible endpoints before execution", () => {
    expect(
      buildSelectionQualificationRequest({
        packageId: "future-harness",
        provider: "compatible-endpoint",
        model: "model-a",
        preferredInferenceApi: null,
        endpointUrl: "https://user:password@example.test/v1",
      }),
    ).toBeNull();
  });
});
