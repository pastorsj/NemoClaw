// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isValidCliOpenShellProviderIdentifier } from "./provider-metadata-cli";

const MAX_ATTACHMENT_OUTPUT_BYTES = 64 * 1024;
const ANSI_OSC_PATTERN = /\x1B\][\s\S]*?(?:\x07|\x1B\\|$)/gu;
const ANSI_CSI_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/gu;

/** Parse the bounded, non-secret provider attachment inventory for one sandbox. */
export function parseCliOpenShellProviderAttachmentNames(output: string): string[] | null {
  if (Buffer.byteLength(output, "utf8") > MAX_ATTACHMENT_OUTPUT_BYTES) return null;
  const clean = output
    .replace(ANSI_OSC_PATTERN, "")
    .replace(ANSI_CSI_PATTERN, "")
    .replace(/\r/gu, "")
    .trim();
  if (/^No providers attached to sandbox\b[^\n]*$/u.test(clean)) return [];

  const lines = clean
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const headerIndex = lines.findIndex((line) =>
    /^NAME\s+TYPE\s+CREDENTIAL_KEYS\s+CONFIG_KEYS$/u.test(line),
  );
  if (headerIndex < 0 || headerIndex === lines.length - 1) return null;

  const names: string[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const match = line.match(/^(\S+)\s+(\S+)\s+(\d+)\s+(\d+)$/u);
    const name = match?.[1];
    if (!name || !isValidCliOpenShellProviderIdentifier(name) || names.includes(name)) return null;
    names.push(name);
  }
  return names;
}
