// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface DockerfileInstruction {
  readonly text: string;
  readonly start: number;
}

/** Parse the package's heredoc-free Dockerfile into logical instructions. */
export function readDockerfileInstructions(dockerfile: string): DockerfileInstruction[] {
  const instructions: DockerfileInstruction[] = [];
  let current = "";
  let currentStart = -1;

  for (const match of dockerfile.matchAll(/[^\n]*(?:\n|$)/gu)) {
    if (!match[0]) continue;
    const rawLine = match[0].replace(/\r?\n$/u, "");
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/(?:^|\s)<<-?\s*['"]?[A-Za-z_]/u.test(trimmed)) {
      throw new Error("Hermes package Dockerfile tests require heredoc-free instructions");
    }
    if (!current) currentStart = match.index;
    const continued = trimmed.endsWith("\\");
    const part = continued ? trimmed.slice(0, -1).trimEnd() : trimmed;
    current = current ? `${current} ${part}` : part;
    if (continued) continue;
    instructions.push({ text: current, start: currentStart });
    current = "";
    currentStart = -1;
  }

  if (current) instructions.push({ text: current, start: currentStart });
  return instructions;
}
