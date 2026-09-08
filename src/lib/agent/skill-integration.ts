// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import type { HarnessSkillCapability } from "@nvidia/nemoclaw-harness-contract";

export const SKILL_NAME_TOKEN = "{name}";
export const SKILL_SOURCE_TOKEN = "{source}";

export interface AgentSkillIntegration {
  readonly writableRoot: string;
  readonly listCommand: readonly string[];
  readonly addCommand: readonly string[] | null;
  readonly removeCommand: readonly string[] | null;
}

/** Normalize the validated package capability for the native skill workflow. */
export function buildAgentSkillIntegration(
  capability: HarnessSkillCapability,
): AgentSkillIntegration | null {
  if (capability.support !== "managed") return null;
  return Object.freeze({
    writableRoot: capability.install_root,
    listCommand: capability.list_command,
    addCommand: capability.add_command ?? null,
    removeCommand: capability.remove_command ?? null,
  });
}

export function renderAgentSkillCommand(
  binary: string,
  command: readonly string[],
  replacements: Readonly<{ name?: string; source?: string }> = {},
): string[] {
  if (!path.posix.isAbsolute(binary)) throw new Error("Agent skill binary must be absolute");
  return [
    binary,
    ...command.map((argument) => {
      if (argument === SKILL_NAME_TOKEN) {
        if (!replacements.name) throw new Error("Agent skill command requires a name");
        return replacements.name;
      }
      if (argument === SKILL_SOURCE_TOKEN) {
        if (!replacements.source) throw new Error("Agent skill command requires a source");
        return replacements.source;
      }
      return argument;
    }),
  ];
}
