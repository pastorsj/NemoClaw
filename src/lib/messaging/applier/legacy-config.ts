// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingAgentId } from "../manifest";

/**
 * Decode the config root used by serialized plans that predate packageBuild.
 * Receipt-backed plans never call this compatibility boundary.
 */
export function resolveLegacyMessagingConfigRoot(agent: MessagingAgentId): string {
  if (agent === "openclaw") return "/sandbox/.openclaw";
  if (agent === "hermes") return "/sandbox/.hermes";
  throw new Error(`Legacy messaging plan for ${agent} has no bounded config root.`);
}
