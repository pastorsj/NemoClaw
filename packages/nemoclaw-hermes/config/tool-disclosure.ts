// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type ToolDisclosure = "progressive" | "direct";

const DEFAULT_TOOL_DISCLOSURE: ToolDisclosure = "progressive";
const TOOL_DISCLOSURE_ENV = "NEMOCLAW_TOOL_DISCLOSURE";

/** Read the closed tool-disclosure enum used while building this package's config. */
export function readToolDisclosureEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): ToolDisclosure {
  const value = (env[TOOL_DISCLOSURE_ENV] || DEFAULT_TOOL_DISCLOSURE).trim().toLowerCase();
  if (value !== "progressive" && value !== "direct") {
    throw new Error(`${TOOL_DISCLOSURE_ENV} must be progressive or direct`);
  }
  return value;
}
