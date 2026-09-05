// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AnySchemaObject } from "ajv";

import type {
  HarnessSessionListOutput,
  HarnessSessionListOutputRequest,
  HarnessSessionListPlan,
  HarnessSessionListPlanRequest,
} from "@nvidia/nemoclaw-harness-contract";
import { defineHarnessAdapterContract, defineHarnessAdapterOperation } from "./contract";

export type {
  HarnessSessionListOutput,
  HarnessSessionListOutputRequest,
  HarnessSessionListPlan,
  HarnessSessionListPlanRequest,
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
          maxItems: 1,
          uniqueItems: true,
          items: { const: "list" },
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
  },
});
