// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Agent-specific policy warning lookup retained only for pre-receipt rows. */
export function legacyMessagingPolicyWarningAgent(
  agent: string | null,
): "openclaw" | "hermes" | undefined {
  return agent === "openclaw" || agent === "hermes" ? agent : undefined;
}
