// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Keep operator recovery finite and independent of any package implementation. */
export function mcpRuntimeIntentRemediationLines(sandboxName: string): readonly string[] {
  return [
    `Run \`nemoclaw ${sandboxName} mcp restart\` to restore the managed MCP configuration, then retry.`,
    `If the package runtime is unavailable or its metadata is stale, run \`nemoclaw ${sandboxName} rebuild --yes\` instead.`,
  ];
}
