// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Explicit-null package authority written by Pi before receipt migration. */
export function allowsLegacyNullPackageAuthority(agentType: string): boolean {
  return agentType === "pi";
}

/** Image-plugin provenance written before package receipts carried authority. */
export function allowsLegacyImagePluginProvenance(agentType: string): boolean {
  return agentType === "openclaw";
}

/** Privileged config capture retained only for an unreceipted OpenClaw sandbox. */
export function allowsLegacyPrivilegedStateFileCapture(agentType: string): boolean {
  return agentType === "openclaw";
}

/** Preserved environment state written before package receipts carried authority. */
export function allowsLegacyPreservedEnvironment(agentType: string): boolean {
  return agentType === "hermes";
}
