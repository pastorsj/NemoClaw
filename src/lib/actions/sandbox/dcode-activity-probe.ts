// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  DEEP_AGENTS_CODE_PACKAGE_ID,
  getDcodeActivityProbe,
  type DcodeActivityProbe,
} from "../../agent/deep-agents-code-specifications";

export const DCODE_AGENT_NAME = DEEP_AGENTS_CODE_PACKAGE_ID;
export type DcodeProbeState = string;

export function getDcodeActivityProbeSpecification(): DcodeActivityProbe {
  return getDcodeActivityProbe();
}

/** Escape a probe literal before embedding it in a generated regular expression. */
function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Parse a single dcode probe sentinel from sandbox command output. */
export function parseDcodeProbeState(output: string): DcodeProbeState | null {
  const activityProbe = getDcodeActivityProbeSpecification();
  const escapedPrefix = escapeRegexLiteral(activityProbe.prefix);
  const stateAlternation = Object.values(activityProbe.states).map(escapeRegexLiteral).join("|");
  const matches = [...output.matchAll(new RegExp(`^${escapedPrefix}(${stateAlternation})$`, "gm"))];
  if (matches.length !== 1) return null;
  return (matches[0][1] as DcodeProbeState | undefined) ?? null;
}
