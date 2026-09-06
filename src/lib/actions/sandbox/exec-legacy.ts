// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxEntry } from "../../state/registry";

/**
 * Resolve the historical OpenClaw Google Chat approval owner only for a
 * pre-package registry row. Receipt-backed packages need a typed command hook
 * before core can safely interpret package-specific argv after public exec.
 */
export function resolveLegacyGoogleChatApprovalAgent(
  entry: Pick<SandboxEntry, "agent" | "harnessPackage"> | null,
): string | null {
  if (!entry) return null;
  if (entry.harnessPackage) {
    throw new Error(
      "Receipt-backed harness packages do not declare a Google Chat approval command hook.",
    );
  }
  return entry.agent ?? "openclaw";
}

/** Exact-ID ownership retained only for the pre-package command protocol. */
export function legacyAgentOwnsGoogleChatApproval(agent: string | null): boolean {
  return agent === "openclaw";
}

/** Parse only the historical OpenClaw Google Chat approval argv. */
export function isLegacyGoogleChatPairingApproval(command: readonly string[]): boolean {
  return (
    command.length >= 5 &&
    command[0] === "openclaw" &&
    command[1] === "pairing" &&
    command[2] === "approve" &&
    command[3] === "googlechat" &&
    Boolean(command[4]) &&
    !command[4]!.startsWith("-")
  );
}
