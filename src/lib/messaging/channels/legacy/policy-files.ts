// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { ROOT } from "../../../state/paths";

const CHANNELS_ROOT = path.join(ROOT, "src", "lib", "messaging", "channels");

/** Resolve historical in-tree policy files only for rows that have no package receipt. */
export function resolveLegacyMessagingPolicyFile(
  channelId: string,
  agent: string | null | undefined,
): { readonly agent: "openclaw" | "hermes"; readonly file: string } | null {
  const legacyAgent = agent == null ? "openclaw" : agent;
  if (legacyAgent !== "openclaw" && legacyAgent !== "hermes") return null;
  return {
    agent: legacyAgent,
    file: path.join(CHANNELS_ROOT, channelId, "policy", `${legacyAgent}.yaml`),
  };
}
