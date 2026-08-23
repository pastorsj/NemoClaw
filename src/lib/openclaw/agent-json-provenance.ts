// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  openClawAgentIncompleteTurnSignalGrammar,
  openClawAgentJsonProvenanceLinesGrammar,
  type OpenClawIncompleteTurnSignal,
} from "./cli-grammar";
import { redactFull } from "../security/redact";

const PEM_PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu;
const SECRET_KV_PATTERN =
  /\b([A-Z0-9_.-]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)[A-Z0-9_.-]*)\s*[:=]\s*["']?[^"'\s;,)]*/giu;
const ANSI_OSC_PATTERN = /\x1B\][\s\S]*?(?:\x07|\x1B\\|$)/gu;
const ANSI_CSI_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/gu;
const CONTROL_PATTERN = /[\u0000-\u0007\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const MAX_PROVENANCE_LINES = 64;
const MAX_PROVENANCE_LINE_LENGTH = 4096;
const REDACTION_MARKER_PATTERN = /(<REDACTED(?:_PRIVATE_KEY)?>)/gu;

function preserveRedactionMarkers(value: string): string {
  return value
    .split(REDACTION_MARKER_PATTERN)
    .map((part) =>
      part === "<REDACTED>" || part === "<REDACTED_PRIVATE_KEY>" ? part : redactFull(part),
    )
    .join("");
}

function redactProvenanceDetail(value: string): string {
  const terminalSafe = value
    .replace(ANSI_OSC_PATTERN, "")
    .replace(ANSI_CSI_PATTERN, "")
    .replace(/[\r\n]+/gu, " ")
    .replace(/\u0008/gu, "")
    .replace(CONTROL_PATTERN, "");
  return preserveRedactionMarkers(
    terminalSafe.replace(PEM_PRIVATE_KEY_PATTERN, "<REDACTED_PRIVATE_KEY>"),
  ).replace(SECRET_KV_PATTERN, "$1=<REDACTED>");
}

function sanitizePackageLines(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_PROVENANCE_LINES ||
    !value.every((line) => typeof line === "string" && line.length <= MAX_PROVENANCE_LINE_LENGTH)
  ) {
    throw new Error("OpenClaw harness CLI-grammar module returned invalid provenance lines.");
  }
  return value.map(redactProvenanceDetail);
}

function sanitizeIncompleteTurnSignal(value: unknown): OpenClawIncompleteTurnSignal | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenClaw harness CLI-grammar module returned an invalid turn signal.");
  }
  const record = value as Record<string, unknown>;
  const markers = sanitizePackageLines(record.markers).map((marker) => marker.trim());
  if (markers.length === 0 || markers.some((marker) => marker.length === 0)) {
    throw new Error("OpenClaw harness CLI-grammar module returned an invalid turn signal.");
  }
  if (record.timeoutPhase === undefined) return { markers };
  if (
    typeof record.timeoutPhase !== "string" ||
    record.timeoutPhase.length === 0 ||
    record.timeoutPhase.length > 128
  ) {
    throw new Error("OpenClaw harness CLI-grammar module returned an invalid turn signal.");
  }
  const timeoutPhase = redactProvenanceDetail(record.timeoutPhase).trim();
  if (timeoutPhase.length === 0) {
    throw new Error("OpenClaw harness CLI-grammar module returned an invalid turn signal.");
  }
  return { markers, timeoutPhase };
}

export type { OpenClawIncompleteTurnSignal };

/** Extract package-defined OpenClaw agent output provenance with core-owned redaction. */
export function openClawAgentJsonProvenanceLines(raw: string): string[] {
  return sanitizePackageLines(openClawAgentJsonProvenanceLinesGrammar(raw, redactProvenanceDetail));
}

/** Detect package-defined incomplete-turn markers in an OpenClaw agent response. */
export function openClawAgentIncompleteTurnSignal(
  raw: string,
): OpenClawIncompleteTurnSignal | null {
  return sanitizeIncompleteTurnSignal(openClawAgentIncompleteTurnSignalGrammar(raw));
}
