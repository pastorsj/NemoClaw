// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isPortableExperimentalProfile } from "./portable-profile";

/**
 * APF currently qualifies only the providerless repository-default product.
 * It is package-free and cannot be selected by an installed harness receipt.
 */
export function hasProviderlessApfAgentIntent(
  requestedAgent: string,
  resolvedAgent: string | null,
): boolean {
  return (
    requestedAgent !== "openclaw" ||
    (resolvedAgent !== null && (resolvedAgent !== "openclaw" || resolvedAgent !== requestedAgent))
  );
}

/** Product selection for the separately qualified Hermes Portable lifecycle. */
export function isHermesPortableProduct(
  agentName: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isPortableExperimentalProfile(env) && agentName === "hermes";
}

/** Registry identity fixed by a current schema-4 Portable receipt. */
export function isOpenClawPortableRegistryAgent(agentName: unknown): boolean {
  return agentName === "openclaw";
}

/** Intent identity fixed by the schema-5 Hermes Portable transaction. */
export function assertHermesPortableIntentAgent(agentName: string | null | undefined): void {
  if (agentName !== "hermes") {
    throw new Error("Hermes portable create intent names another agent.");
  }
}

export function isHermesPortableReceiptDisposition<T extends { readonly kind: string }>(
  disposition: T,
): disposition is Extract<T, { readonly kind: "hermes" }> {
  return disposition.kind === "hermes";
}
