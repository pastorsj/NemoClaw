// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect } from "vitest";

export function safeTmpHelpers(source: string): string {
  const start = source.indexOf("_nemoclaw_safe_replace_tmp_file() {");
  const end = source.indexOf("_START_LOG=", Math.max(start, 0));
  expect(start, "Expected safe temp helpers in packages/nemoclaw-openclaw/start.sh").not.toBe(-1);
  expect(end, "Expected safe temp helpers in packages/nemoclaw-openclaw/start.sh").toBeGreaterThan(
    start,
  );
  return source.slice(start, end);
}

/** Extract a shell function without mistaking heredoc braces for its closing brace. */
export function extractShellFunctionFromSource(source: string, name: string): string {
  const header = `${name}() {`;
  const start = source.indexOf(header);
  if (start === -1) {
    throw new Error(`Expected ${name} in shell source`);
  }

  const bodyStart = start + header.length;
  const lines = source.slice(bodyStart).split(/(?<=\n)/);
  let offset = 0;
  let heredocEnd: string | undefined;
  for (const line of lines) {
    const bareLine = line.replace(/\r?\n$/, "");
    if (heredocEnd) {
      offset += line.length;
      if (bareLine === heredocEnd) heredocEnd = undefined;
      continue;
    }

    const heredoc = line.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (heredoc) heredocEnd = heredoc[1];
    if (bareLine === "}") {
      return `${name}() {${source.slice(bodyStart, bodyStart + offset)}\n}`;
    }
    offset += line.length;
  }

  throw new Error(`Expected closing brace for ${name} in shell source`);
}
