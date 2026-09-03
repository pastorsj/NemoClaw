// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AnySchemaObject } from "ajv";

import { defineHarnessAdapterContract, defineHarnessAdapterOperation } from "./contract";

const MCP_ADAPTER_SOURCE_MAX_BYTES = 512 * 1024;
const MCP_ADAPTER_REQUEST_MAX_BYTES = 1024 * 1024;
const MCP_ADAPTER_RESULT_MAX_BYTES = 1024 * 1024;

export interface HarnessMcpAdapterEntry {
  readonly server: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface HarnessMcpRegistrationRequest {
  readonly entry: HarnessMcpAdapterEntry;
  readonly managedEntries: readonly HarnessMcpAdapterEntry[];
  readonly replaceExisting: boolean;
  readonly teardownRollback: boolean;
  readonly configRoot: string | null;
}

export interface HarnessMcpRemovalRequest {
  readonly entry: HarnessMcpAdapterEntry;
  readonly force: boolean;
  readonly adaptiveTeardown: boolean;
  readonly configRoot: string | null;
}

export type HarnessMcpAdapterCommand = string | readonly string[];

const stringValueSchema = Object.freeze({ type: "string", maxLength: 65_536 });
const mcpEntrySchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["server", "url", "headers"],
  properties: {
    server: { type: "string", minLength: 1, maxLength: 256 },
    url: { type: "string", minLength: 1, maxLength: 8192 },
    headers: {
      type: "object",
      maxProperties: 128,
      propertyNames: { type: "string", minLength: 1, maxLength: 256 },
      additionalProperties: stringValueSchema,
    },
  },
});

const configRootSchema = Object.freeze({
  anyOf: [{ type: "null" }, { type: "string", minLength: 1, maxLength: 4096 }],
});

const mcpRegistrationRequestSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["entry", "managedEntries", "replaceExisting", "teardownRollback", "configRoot"],
  properties: {
    entry: mcpEntrySchema,
    managedEntries: {
      type: "array",
      maxItems: 512,
      items: mcpEntrySchema,
    },
    replaceExisting: { type: "boolean" },
    teardownRollback: { type: "boolean" },
    configRoot: configRootSchema,
  },
});

const mcpRemovalRequestSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["entry", "force", "adaptiveTeardown", "configRoot"],
  properties: {
    entry: mcpEntrySchema,
    force: { type: "boolean" },
    adaptiveTeardown: { type: "boolean" },
    configRoot: configRootSchema,
  },
});

const mcpCommandSchema: AnySchemaObject = Object.freeze({
  anyOf: [
    { type: "string", minLength: 1, maxLength: MCP_ADAPTER_RESULT_MAX_BYTES },
    {
      type: "array",
      minItems: 1,
      maxItems: 512,
      items: { type: "string", minLength: 1, maxLength: 65_536 },
    },
  ],
});

const mcpCapabilitySchema: AnySchemaObject = Object.freeze({
  type: "object",
  required: ["mcp"],
  properties: {
    mcp: {
      type: "object",
      required: ["support", "adapter"],
      properties: {
        support: { const: "bridge" },
        adapter: { type: "string", minLength: 1, maxLength: 256 },
      },
    },
  },
});

/** The first fixed capability implemented through the generic harness adapter boundary. */
export const HARNESS_MCP_ADAPTER_CONTRACT = defineHarnessAdapterContract({
  capability: "mcp",
  displayName: "MCP adapter",
  modulePath: "host/mcp-adapter.cts",
  manifestSchema: mcpCapabilitySchema,
  sourceMaxBytes: MCP_ADAPTER_SOURCE_MAX_BYTES,
  requestMaxBytes: MCP_ADAPTER_REQUEST_MAX_BYTES,
  resultMaxBytes: MCP_ADAPTER_RESULT_MAX_BYTES,
  operations: {
    register: defineHarnessAdapterOperation<
      HarnessMcpRegistrationRequest,
      HarnessMcpAdapterCommand
    >({
      exportName: "buildMcpRegistrationCommand",
      requestSchema: mcpRegistrationRequestSchema,
      resultSchema: mcpCommandSchema,
      resultDescription: "command",
    }),
    remove: defineHarnessAdapterOperation<HarnessMcpRemovalRequest, HarnessMcpAdapterCommand>({
      exportName: "buildMcpRemovalCommand",
      requestSchema: mcpRemovalRequestSchema,
      resultSchema: mcpCommandSchema,
      resultDescription: "command",
    }),
  },
});
