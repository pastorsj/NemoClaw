// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AnySchemaObject } from "ajv";
import type {
  HarnessAgentRosterApplyPlan,
  HarnessAgentRosterApplyRequest,
  HarnessAgentRosterCommandPlan,
  HarnessAgentRosterCommandRequest,
  HarnessAgentRosterInspectionPlan,
  HarnessAgentRosterInspectionRequest,
} from "@nvidia/nemoclaw-harness-contract";

import { defineHarnessAdapterContract, defineHarnessAdapterOperation } from "./contract";

export type {
  HarnessAgentRosterApplyPlan,
  HarnessAgentRosterApplyRequest,
  HarnessAgentRosterCommandPlan,
  HarnessAgentRosterCommandRequest,
  HarnessAgentRosterInspectionPlan,
  HarnessAgentRosterInspectionRequest,
} from "@nvidia/nemoclaw-harness-contract";

const AGENT_ROSTER_SOURCE_MAX_BYTES = 512 * 1024;
const AGENT_ROSTER_OUTPUT_MAX_BYTES = 63 * 1024 * 1024;
const AGENT_ROSTER_VALUE_MAX_BYTES = 64 * 1024 * 1024;

const commandArgumentSchema: AnySchemaObject = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 32 * 1024,
  pattern: "^[^\\u0000]+$",
});

const commandSchema: AnySchemaObject = Object.freeze({
  type: "array",
  minItems: 1,
  maxItems: 256,
  items: commandArgumentSchema,
});

const jsonValueDefinition: AnySchemaObject = Object.freeze({
  oneOf: [
    { type: "null" },
    { type: "boolean" },
    { type: "number" },
    { type: "string", maxLength: 64 * 1024 },
    { type: "array", maxItems: 4096, items: { $ref: "#/$defs/jsonValue" } },
    {
      type: "object",
      maxProperties: 1024,
      propertyNames: { type: "string", maxLength: 256 },
      additionalProperties: { $ref: "#/$defs/jsonValue" },
    },
  ],
});

function withJsonValueDefinition(schema: AnySchemaObject): AnySchemaObject {
  return Object.freeze({ ...schema, $defs: { jsonValue: jsonValueDefinition } });
}

const manifestSchema: AnySchemaObject = Object.freeze({
  type: "object",
  required: ["agent_roster"],
  properties: {
    agent_roster: {
      type: "object",
      additionalProperties: false,
      required: ["adapter", "onboarding_environment", "support"],
      properties: {
        support: { const: "managed" },
        adapter: { const: "agent-roster" },
        onboarding_environment: { const: "NEMOCLAW_EXTRA_AGENTS_JSON" },
      },
    },
  },
});

const rosterManifestSchema: AnySchemaObject = Object.freeze({
  type: "object",
  maxProperties: 1024,
  propertyNames: { type: "string", maxLength: 256 },
  additionalProperties: { $ref: "#/$defs/jsonValue" },
});

const commandRequestSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["arguments", "operation"],
  properties: {
    operation: { enum: ["list", "add", "delete"] },
    arguments: { type: "array", maxItems: 255, items: commandArgumentSchema },
  },
});

const reasonSchema: AnySchemaObject = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 8192,
});

const commandPlanSchema: AnySchemaObject = Object.freeze({
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "command"],
      properties: { kind: { const: "stream" }, command: commandSchema },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "reason"],
      properties: { kind: { const: "unsupported" }, reason: reasonSchema },
    },
  ],
});

const inspectionRequestSchema = withJsonValueDefinition({
  type: "object",
  additionalProperties: false,
  required: ["manifest"],
  properties: { manifest: rosterManifestSchema },
});

const inspectionPlanSchema: AnySchemaObject = Object.freeze({
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "command"],
      properties: { kind: { const: "capture" }, command: commandSchema },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "reason"],
      properties: { kind: { const: "refused" }, reason: reasonSchema },
    },
  ],
});

const applyRequestSchema = withJsonValueDefinition({
  type: "object",
  additionalProperties: false,
  required: ["current_output", "manifest"],
  properties: {
    manifest: rosterManifestSchema,
    current_output: { type: "string", maxLength: AGENT_ROSTER_OUTPUT_MAX_BYTES },
  },
});

const mutationSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["agent_id", "command"],
  properties: {
    agent_id: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      pattern: "^[^\\u0000-\\u001f\\u007f]+$",
    },
    command: commandSchema,
  },
});

const applyPlanSchema: AnySchemaObject = Object.freeze({
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "reason"],
      properties: { kind: { const: "refused" }, reason: reasonSchema },
    },
    {
      type: "object",
      additionalProperties: false,
      required: [
        "kind",
        "current_count",
        "additions",
        "deletions",
        "rebuild_only_fields",
        "notices",
      ],
      properties: {
        kind: { const: "ready" },
        current_count: { type: "integer", minimum: 0, maximum: 4096 },
        additions: { type: "array", maxItems: 4096, items: mutationSchema },
        deletions: { type: "array", maxItems: 4096, items: mutationSchema },
        rebuild_only_fields: {
          type: "array",
          maxItems: 4096,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 1024 },
        },
        notices: {
          type: "array",
          maxItems: 4096,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["message"],
            properties: { message: reasonSchema },
          },
        },
      },
    },
  ],
});

/** Fixed, schema-checked agent-roster boundary. Packages cannot add commands or host callbacks. */
export const HARNESS_AGENT_ROSTER_ADAPTER_CONTRACT = defineHarnessAdapterContract({
  displayName: "agent roster adapter",
  modulePath: "host/agent-roster-adapter.cts",
  manifestSchema,
  sourceMaxBytes: AGENT_ROSTER_SOURCE_MAX_BYTES,
  requestMaxBytes: AGENT_ROSTER_VALUE_MAX_BYTES,
  resultMaxBytes: 1024 * 1024,
  operations: {
    buildCommand: defineHarnessAdapterOperation<
      HarnessAgentRosterCommandRequest,
      HarnessAgentRosterCommandPlan
    >({
      exportName: "buildAgentRosterCommand",
      requestSchema: commandRequestSchema,
      resultSchema: commandPlanSchema,
      resultDescription: "agent roster command plan",
    }),
    buildInspection: defineHarnessAdapterOperation<
      HarnessAgentRosterInspectionRequest,
      HarnessAgentRosterInspectionPlan
    >({
      exportName: "buildAgentRosterInspection",
      requestSchema: inspectionRequestSchema,
      resultSchema: inspectionPlanSchema,
      resultDescription: "agent roster inspection plan",
    }),
    buildApplyPlan: defineHarnessAdapterOperation<
      HarnessAgentRosterApplyRequest,
      HarnessAgentRosterApplyPlan
    >({
      exportName: "buildAgentRosterApplyPlan",
      requestSchema: applyRequestSchema,
      resultSchema: applyPlanSchema,
      resultDescription: "agent roster apply plan",
    }),
  },
});
