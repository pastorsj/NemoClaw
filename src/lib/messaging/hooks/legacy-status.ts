// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingAgentId } from "../manifest";

/**
 * Preserve the pre-package status default for callers that have no receipt.
 * Receipt-backed callers pass their authoritative agent or composed manifests
 * and never select behavior through this compatibility value.
 */
export function legacyMessagingStatusAgents(): ReadonlySet<MessagingAgentId> {
  return new Set<MessagingAgentId>(["openclaw"]);
}
