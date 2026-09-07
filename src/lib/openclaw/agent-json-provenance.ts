// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Compatibility names for callers that predate the typed structured-turn
 * envelope declaration. New receipt-backed dispatch imports the generic
 * semantic implementation from the sandbox agent boundary.
 */
import {
  parseStructuredTurnJsonDocuments,
  structuredTurnIncompleteSignal,
  structuredTurnProvenanceLines,
  structuredTurnResponseRecord,
  structuredTurnUnframedJsonText,
  type StructuredTurnIncompleteSignal,
} from "../actions/sandbox/agent/structured-turn-envelope";

export type OpenClawIncompleteTurnSignal = StructuredTurnIncompleteSignal;

export const parseOpenClawJsonDocuments = parseStructuredTurnJsonDocuments;
export const openClawUnframedJsonText = structuredTurnUnframedJsonText;
export const openClawAgentResponseRecord = structuredTurnResponseRecord;
export const openClawAgentIncompleteTurnSignal = structuredTurnIncompleteSignal;

export function openClawAgentJsonProvenanceLines(raw: string): string[] {
  return structuredTurnProvenanceLines(raw).map((line) =>
    line.replace(/^\[agent provenance\]/u, "[openclaw provenance]"),
  );
}
