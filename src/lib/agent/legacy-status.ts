// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface LegacyStatusDefaults {
  readonly displayName: string;
  readonly tolerateMissingDefinition: boolean;
  readonly retainLoadedDefinition: boolean;
}

/**
 * Describe the one historical implicit status profile.
 *
 * Receipt-backed status resolution never uses these defaults: it resolves the
 * exact package definition and treats a missing or mismatched receipt as an
 * authority failure.
 */
export function legacyStatusDefaults(agentName: string): LegacyStatusDefaults {
  const implicitGateway = agentName === "openclaw";
  return Object.freeze({
    displayName: implicitGateway ? "OpenClaw" : agentName,
    tolerateMissingDefinition: implicitGateway,
    retainLoadedDefinition: !implicitGateway,
  });
}
