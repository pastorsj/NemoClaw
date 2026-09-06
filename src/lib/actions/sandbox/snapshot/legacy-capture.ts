// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../../../agent/defs";
import type * as sandboxState from "../../../state/sandbox";

const LEGACY_OPENCLAW_CONFIG_DIRECTORY = "/sandbox/.openclaw";
const LEGACY_OPENCLAW_CONFIG_NAME = "openclaw.json";

type LegacyStateFileCapture = (
  sandboxName: string,
  request: sandboxState.StateFileCaptureRequest,
  authority: {
    readonly directory: string;
    readonly spec: sandboxState.StateFileCaptureRequest["spec"];
  },
) => sandboxState.StateFileCaptureResult | null;

/** Decode the historical OpenClaw config capture only after the caller proves no package receipt. */
export function createLegacyOpenClawStateFileCapture(
  sandboxName: string,
  agentDefinition: AgentDefinition,
  capture: LegacyStateFileCapture,
): sandboxState.StateFileCapture | null {
  if (agentDefinition.name !== "openclaw") return null;
  const authority = {
    directory: LEGACY_OPENCLAW_CONFIG_DIRECTORY,
    spec: { path: LEGACY_OPENCLAW_CONFIG_NAME, strategy: "copy" as const },
  };
  return (request) => capture(sandboxName, request, authority);
}
