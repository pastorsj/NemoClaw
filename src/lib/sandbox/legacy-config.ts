// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Configuration shape owned by a sandbox created before package receipts. */
export type LegacyConfigKind = "sealed-json" | "sealed-yaml" | null;

/**
 * Decode only the historical, pre-package configuration layouts.
 *
 * Callers must first give an installed package adapter authority over a
 * receipt-backed sandbox. Keeping this exact-name decoder in a leaf module
 * prevents current package workflows from selecting native behavior by ID.
 */
export function classifyLegacyConfigAgent(agentName: string): LegacyConfigKind {
  if (agentName === "openclaw") return "sealed-json";
  if (agentName === "hermes") return "sealed-yaml";
  return null;
}
