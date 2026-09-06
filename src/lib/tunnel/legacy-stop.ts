// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxEntry } from "../state/registry";

/** Preserve the pre-receipt OpenClaw stop path after package authority is absent. */
export function isLegacyGatewayStopTarget(sandbox: SandboxEntry | null): boolean {
  return !sandbox?.agent || sandbox.agent === "openclaw";
}
