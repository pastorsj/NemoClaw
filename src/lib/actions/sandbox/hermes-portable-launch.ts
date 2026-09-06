// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Product qualification helpers for the separately receipted Hermes Portable launch lane. */
export function isHermesPortableDisposition<T extends { readonly kind: string }>(
  disposition: T,
): disposition is Extract<T, { readonly kind: "hermes" }> {
  return disposition.kind === "hermes";
}

export function isHermesPortableRegistryAgent(
  entry: {
    readonly agent?: string | null;
  } | null,
): boolean {
  return entry?.agent === "hermes";
}

export function hasMatchingHermesPortableLaunchAgents(input: {
  readonly selectedAgent?: string | null;
  readonly capturedAgent?: string | null;
  readonly currentAgent?: string | null;
}): boolean {
  return (
    input.selectedAgent === "hermes" &&
    input.capturedAgent === "hermes" &&
    input.currentAgent === "hermes"
  );
}
