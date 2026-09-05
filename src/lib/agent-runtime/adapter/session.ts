// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AnySchemaObject } from "ajv";

import type {
  HarnessSessionExportIndexOutput,
  HarnessSessionExportIndexRequest,
  HarnessSessionExportPlan,
  HarnessSessionExportPlanRequest,
  HarnessSessionListOutput,
  HarnessSessionListOutputRequest,
  HarnessSessionListPlan,
  HarnessSessionListPlanRequest,
  HarnessSessionMutationOutput,
  HarnessSessionMutationOutputRequest,
  HarnessSessionMutationPlan,
  HarnessSessionMutationPlanRequest,
} from "@nvidia/nemoclaw-harness-contract";
import { defineHarnessAdapterContract, defineHarnessAdapterOperation } from "./contract";

export type {
  HarnessSessionExportIndexOutput,
  HarnessSessionExportIndexRequest,
  HarnessSessionExportPlan,
  HarnessSessionExportPlanRequest,
  HarnessSessionListOutput,
  HarnessSessionListOutputRequest,
  HarnessSessionListPlan,
  HarnessSessionListPlanRequest,
  HarnessSessionMutationOutput,
  HarnessSessionMutationOutputRequest,
  HarnessSessionMutationPlan,
  HarnessSessionMutationPlanRequest,
} from "@nvidia/nemoclaw-harness-contract";

const SESSION_ADAPTER_SOURCE_MAX_BYTES = 512 * 1024;
const SESSION_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
const SESSION_ADAPTER_VALUE_MAX_BYTES = SESSION_OUTPUT_MAX_BYTES + 1024 * 1024;

const sessionManifestSchema: AnySchemaObject = Object.freeze({
  type: "object",
  required: ["sessions"],
  properties: {
    sessions: {
      type: "object",
      additionalProperties: false,
      required: ["operations"],
      properties: {
        operations: {
          type: "array",
          maxItems: 4,
          uniqueItems: true,
          items: { enum: ["list", "delete", "reset", "export"] },
        },
      },
    },
  },
});

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

const listPlanRequestSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["arguments", "useListSubcommand"],
  properties: {
    arguments: {
      type: "array",
      maxItems: 255,
      items: commandArgumentSchema,
    },
    useListSubcommand: { type: "boolean" },
  },
});

const listPlanSchema: AnySchemaObject = Object.freeze({
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "reason"],
      properties: {
        kind: { const: "unsupported" },
        reason: { type: "string", minLength: 1, maxLength: 8192 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "command"],
      properties: { kind: { const: "stream" }, command: commandSchema },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "command"],
      properties: { kind: { const: "capture" }, command: commandSchema },
    },
  ],
});

const listOutputRequestSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["output", "jsonOutput", "hiddenSessionIdPrefix"],
  properties: {
    output: { type: "string", maxLength: SESSION_OUTPUT_MAX_BYTES },
    jsonOutput: { type: "boolean" },
    hiddenSessionIdPrefix: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      pattern: "^[^\\u0000-\\u001f\\u007f]+$",
    },
  },
});

const listOutputSchema: AnySchemaObject = Object.freeze({
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "output"],
      properties: {
        kind: { const: "output" },
        output: { type: "string", maxLength: SESSION_OUTPUT_MAX_BYTES },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "reason"],
      properties: {
        kind: { const: "refused" },
        reason: { type: "string", minLength: 1, maxLength: 8192 },
      },
    },
  ],
});

const optionalAgentSchema: AnySchemaObject = Object.freeze({
  oneOf: [
    { type: "null" },
    { type: "string", minLength: 1, maxLength: 64, pattern: "^[^\\u0000-\\u001f\\u007f]+$" },
  ],
});

const sessionKeySchema: AnySchemaObject = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 256,
  pattern: "^[^\\u0000-\\u001f\\u007f]+$",
});

const sessionJsonValueDefinition: AnySchemaObject = Object.freeze({
  oneOf: [
    { type: "null" },
    { type: "boolean" },
    { type: "number" },
    { type: "string", maxLength: SESSION_OUTPUT_MAX_BYTES },
    {
      type: "array",
      maxItems: 20_000,
      items: { $ref: "#/$defs/sessionJsonValue" },
    },
    {
      type: "object",
      maxProperties: 10_000,
      propertyNames: { type: "string", maxLength: 1024 },
      additionalProperties: { $ref: "#/$defs/sessionJsonValue" },
    },
  ],
});

function withSessionJsonDefinition(schema: AnySchemaObject): AnySchemaObject {
  return Object.freeze({
    ...schema,
    $defs: { sessionJsonValue: sessionJsonValueDefinition },
  });
}

const mutationPlanRequestSchema: AnySchemaObject = Object.freeze({
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["operation", "key", "agent", "keepTranscript", "jsonOutput", "verboseOutput"],
      properties: {
        operation: { const: "delete" },
        key: sessionKeySchema,
        agent: optionalAgentSchema,
        keepTranscript: { type: "boolean" },
        jsonOutput: { type: "boolean" },
        verboseOutput: { type: "boolean" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["operation", "key", "agent", "reason", "jsonOutput", "verboseOutput"],
      properties: {
        operation: { const: "reset" },
        key: sessionKeySchema,
        agent: optionalAgentSchema,
        reason: { enum: ["reset", "new"] },
        jsonOutput: { type: "boolean" },
        verboseOutput: { type: "boolean" },
      },
    },
  ],
});

const unsupportedOrRefusedPlanSchemas: AnySchemaObject[] = ["unsupported", "refused"].map(
  (kind) => ({
    type: "object",
    additionalProperties: false,
    required: ["kind", "reason"],
    properties: {
      kind: { const: kind },
      reason: { type: "string", minLength: 1, maxLength: 8192 },
    },
  }),
);

const mutationPlanSchema: AnySchemaObject = withSessionJsonDefinition({
  oneOf: [
    ...unsupportedOrRefusedPlanSchemas,
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "command"],
      properties: { kind: { const: "stream" }, command: commandSchema },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "method", "params"],
      properties: {
        kind: { const: "admin-rpc" },
        method: { enum: ["sessions.delete", "sessions.reset"] },
        params: {
          type: "object",
          maxProperties: 32,
          propertyNames: { type: "string", minLength: 1, maxLength: 128 },
          additionalProperties: { $ref: "#/$defs/sessionJsonValue" },
        },
      },
    },
  ],
});

const mutationOutputRequestSchema: AnySchemaObject = withSessionJsonDefinition({
  type: "object",
  additionalProperties: false,
  required: ["request", "plan", "payload"],
  properties: {
    request: mutationPlanRequestSchema,
    plan: mutationPlanSchema.oneOf[3],
    payload: {
      type: "object",
      maxProperties: 10_000,
      propertyNames: { type: "string", maxLength: 1024 },
      additionalProperties: { $ref: "#/$defs/sessionJsonValue" },
    },
  },
});

const mutationOutputSchema: AnySchemaObject = withSessionJsonDefinition({
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "reason"],
      properties: {
        kind: { const: "refused" },
        reason: { type: "string", minLength: 1, maxLength: 8192 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "operation", "key", "removedTranscript", "entry"],
      properties: {
        kind: { const: "completed" },
        operation: { const: "delete" },
        key: sessionKeySchema,
        removedTranscript: { type: "boolean" },
        entry: { $ref: "#/$defs/sessionJsonValue" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "operation", "key", "reason", "entry"],
      properties: {
        kind: { const: "completed" },
        operation: { const: "reset" },
        key: sessionKeySchema,
        reason: { enum: ["reset", "new"] },
        entry: { $ref: "#/$defs/sessionJsonValue" },
      },
    },
  ],
});

const sandboxPathSchema: AnySchemaObject = Object.freeze({
  type: "string",
  minLength: 10,
  maxLength: 4096,
  pattern: "^/sandbox/[A-Za-z0-9._/-]+$",
});

const selectedKeysSchema: AnySchemaObject = Object.freeze({
  oneOf: [{ const: "all" }, { type: "array", maxItems: 10_000, items: sessionKeySchema }],
});

const exportPlanRequestSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["agent", "keys", "format", "includeTrajectory", "stagingFiles"],
  properties: {
    agent: optionalAgentSchema,
    keys: { type: "array", maxItems: 10_000, items: sessionKeySchema },
    format: { enum: ["dir", "tar"] },
    includeTrajectory: { type: "boolean" },
    stagingFiles: {
      type: "object",
      additionalProperties: false,
      required: ["tar", "jsonl"],
      properties: { tar: sandboxPathSchema, jsonl: sandboxPathSchema },
    },
  },
});

const exportPlanSchema: AnySchemaObject = Object.freeze({
  oneOf: [
    ...unsupportedOrRefusedPlanSchemas,
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "agent", "format", "selectedKeys", "sourceDirectory", "indexCommand"],
      properties: {
        kind: { const: "indexed-files" },
        agent: { type: "string", minLength: 1, maxLength: 128 },
        format: { enum: ["dir", "tar"] },
        selectedKeys: selectedKeysSchema,
        sourceDirectory: sandboxPathSchema,
        indexCommand: commandSchema,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "agent", "format", "selectedKeys", "remoteFile", "command", "allowEmpty"],
      properties: {
        kind: { const: "native-file" },
        agent: { type: "string", minLength: 1, maxLength: 128 },
        format: { const: "jsonl" },
        selectedKeys: { const: "all" },
        remoteFile: sandboxPathSchema,
        command: commandSchema,
        allowEmpty: { type: "boolean" },
      },
    },
  ],
});

const exportIndexRequestSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["output", "agent", "selectedKeys", "includeTrajectory", "hiddenSessionIdPrefix"],
  properties: {
    output: { type: "string", maxLength: SESSION_OUTPUT_MAX_BYTES },
    agent: { type: "string", minLength: 1, maxLength: 128 },
    selectedKeys: selectedKeysSchema,
    includeTrajectory: { type: "boolean" },
    hiddenSessionIdPrefix: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      pattern: "^[^\\u0000-\\u001f\\u007f]+$",
    },
  },
});

const exportIndexOutputSchema: AnySchemaObject = Object.freeze({
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "reason"],
      properties: {
        kind: { const: "refused" },
        reason: { type: "string", minLength: 1, maxLength: 8192 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "sessions", "relativeFiles"],
      properties: {
        kind: { const: "selection" },
        sessions: {
          type: "array",
          maxItems: 10_000,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["key", "sessionId"],
            properties: {
              key: sessionKeySchema,
              sessionId: { type: "string", minLength: 1, maxLength: 255 },
            },
          },
        },
        relativeFiles: {
          type: "array",
          maxItems: 20_000,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 255 },
        },
      },
    },
  ],
});

/** Fixed receipt-backed boundary for native session listing. */
export const HARNESS_SESSION_ADAPTER_CONTRACT = defineHarnessAdapterContract({
  displayName: "session adapter",
  modulePath: "host/session-adapter.cts",
  manifestSchema: sessionManifestSchema,
  sourceMaxBytes: SESSION_ADAPTER_SOURCE_MAX_BYTES,
  requestMaxBytes: SESSION_ADAPTER_VALUE_MAX_BYTES,
  resultMaxBytes: SESSION_ADAPTER_VALUE_MAX_BYTES,
  operations: {
    buildListPlan: defineHarnessAdapterOperation<
      HarnessSessionListPlanRequest,
      HarnessSessionListPlan
    >({
      exportName: "buildSessionListPlan",
      requestSchema: listPlanRequestSchema,
      resultSchema: listPlanSchema,
      resultDescription: "session list plan",
    }),
    interpretListOutput: defineHarnessAdapterOperation<
      HarnessSessionListOutputRequest,
      HarnessSessionListOutput
    >({
      exportName: "interpretSessionListOutput",
      requestSchema: listOutputRequestSchema,
      resultSchema: listOutputSchema,
      resultDescription: "session list output",
    }),
    buildMutationPlan: defineHarnessAdapterOperation<
      HarnessSessionMutationPlanRequest,
      HarnessSessionMutationPlan
    >({
      exportName: "buildSessionMutationPlan",
      requestSchema: mutationPlanRequestSchema,
      resultSchema: mutationPlanSchema,
      resultDescription: "session mutation plan",
    }),
    interpretMutationOutput: defineHarnessAdapterOperation<
      HarnessSessionMutationOutputRequest,
      HarnessSessionMutationOutput
    >({
      exportName: "interpretSessionMutationOutput",
      requestSchema: mutationOutputRequestSchema,
      resultSchema: mutationOutputSchema,
      resultDescription: "session mutation output",
    }),
    buildExportPlan: defineHarnessAdapterOperation<
      HarnessSessionExportPlanRequest,
      HarnessSessionExportPlan
    >({
      exportName: "buildSessionExportPlan",
      requestSchema: exportPlanRequestSchema,
      resultSchema: exportPlanSchema,
      resultDescription: "session export plan",
    }),
    interpretExportIndex: defineHarnessAdapterOperation<
      HarnessSessionExportIndexRequest,
      HarnessSessionExportIndexOutput
    >({
      exportName: "interpretSessionExportIndex",
      requestSchema: exportIndexRequestSchema,
      resultSchema: exportIndexOutputSchema,
      resultDescription: "session export index",
    }),
  },
});
