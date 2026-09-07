// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type CredentialInput = string | null | undefined;

/** Trim whitespace and strip CR characters that shells often append on paste. */
export function normalizeCredentialValue(value: CredentialInput): string {
  if (typeof value !== "string") return "";
  return value.replace(/\r/g, "").trim();
}
