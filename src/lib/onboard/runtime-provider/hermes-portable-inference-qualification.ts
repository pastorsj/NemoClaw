// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Product qualification for the published Hermes Portable Ollama recovery lane.
 *
 * This is not ordinary harness-package dispatch. Callers already hold the
 * dedicated published-recovery operation or receipt and use this boundary to
 * prove that its registry/request projection still names that exact product.
 */
export function assertHermesPortableInferenceSandbox(input: {
  readonly agent?: string | null;
  readonly provider?: string | null;
}): void {
  if (input.agent !== "hermes" || input.provider !== "ollama-local") {
    throw new Error(
      "Host-local inference lifecycle invalid: published inference requalification is restricted to Hermes Portable Ollama",
    );
  }
}

export function assertHermesPortableInferenceStartupRequest(input: {
  /** A receipt object cannot enter this exact no-receipt product lane. */
  readonly application: unknown;
  readonly service: string;
  readonly hostOllama: boolean;
  readonly hasResumeReceipt: boolean;
  readonly recover: boolean;
}): void {
  if (
    input.application !== "hermes" ||
    input.service !== "ollama" ||
    input.hostOllama ||
    !input.hasResumeReceipt ||
    input.recover
  ) {
    throw new Error("Hermes Portable published inference recovery authority is invalid.");
  }
}
