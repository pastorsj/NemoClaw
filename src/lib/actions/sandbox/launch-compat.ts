// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Select the historical OpenClaw protocol only for a no-receipt compatibility
 * row. Receipt-backed packages use runtime.session_qualification instead.
 */
export function usesOpenClawPairingProtocol(
  recordedAgent: string | null | undefined,
  resolvedAgent: string,
  pairingDeclared: boolean,
): boolean {
  const effectiveAgent = recordedAgent?.trim() || "openclaw";
  return effectiveAgent === "openclaw" && resolvedAgent === "openclaw" && pairingDeclared;
}

/** Portable lifecycle receipts predate package receipts and require an explicit agent value. */
export function ownsPortableOpenClawReceipt(
  recordedAgent: string | null | undefined,
  resolvedAgent: string,
): boolean {
  return recordedAgent === "openclaw" && resolvedAgent === "openclaw";
}

/** A valid explicit non-OpenClaw agent does not own a stale portable receipt. */
export function canIgnorePortableOpenClawReceipt(
  recordedAgent: string | null | undefined,
): boolean {
  return (
    typeof recordedAgent === "string" &&
    recordedAgent.length > 0 &&
    recordedAgent === recordedAgent.trim() &&
    recordedAgent !== "openclaw"
  );
}

/** True only for the explicit registry identity used by the Portable receipt. */
export function isRecordedPortableOpenClawAgent(recordedAgent: string | null | undefined): boolean {
  return recordedAgent === "openclaw";
}
