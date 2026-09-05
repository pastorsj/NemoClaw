// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AnySchemaObject } from "ajv";
import type {
  HarnessMessagingIntegration,
  HarnessMessagingIntegrationRequest,
} from "@nvidia/nemoclaw-harness-contract";

import { defineHarnessAdapterContract, defineHarnessAdapterOperation } from "./contract";

const MESSAGING_ADAPTER_SOURCE_MAX_BYTES = 128 * 1024;
const MESSAGING_ADAPTER_VALUE_MAX_BYTES = 128 * 1024;

export type {
  HarnessMessagingAdapterModule,
  HarnessMessagingDisabledIntegration,
  HarnessMessagingIntegration,
  HarnessMessagingIntegrationRequest,
  HarnessMessagingSupportedIntegration,
} from "@nvidia/nemoclaw-harness-contract";

const canonicalIdSchema: AnySchemaObject = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 256,
  pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
});

const messagingManifestSchema: AnySchemaObject = Object.freeze({
  type: "object",
  required: ["name", "messaging"],
  properties: {
    name: canonicalIdSchema,
    messaging: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["support", "channels"],
          properties: {
            support: { const: "channels" },
            channels: {
              type: "array",
              minItems: 1,
              maxItems: 32,
              uniqueItems: true,
              items: canonicalIdSchema,
            },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["support"],
          properties: { support: { const: "disabled" } },
        },
      ],
    },
  },
});

const messagingRequestSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["packageId"],
  properties: { packageId: canonicalIdSchema },
});

const messagingIntegrationSchema: AnySchemaObject = Object.freeze({
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "packageId", "channelIds"],
      properties: {
        kind: { const: "channels" },
        packageId: canonicalIdSchema,
        channelIds: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          uniqueItems: true,
          items: canonicalIdSchema,
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "packageId", "reason"],
      properties: {
        kind: { const: "disabled" },
        packageId: canonicalIdSchema,
        reason: { type: "string", minLength: 1, maxLength: 8192 },
      },
    },
  ],
});

/** Fixed receipt-backed boundary for one package's static messaging profile. */
export const HARNESS_MESSAGING_ADAPTER_CONTRACT = defineHarnessAdapterContract({
  displayName: "messaging adapter",
  modulePath: "host/messaging-adapter.cts",
  manifestSchema: messagingManifestSchema,
  sourceMaxBytes: MESSAGING_ADAPTER_SOURCE_MAX_BYTES,
  requestMaxBytes: MESSAGING_ADAPTER_VALUE_MAX_BYTES,
  resultMaxBytes: MESSAGING_ADAPTER_VALUE_MAX_BYTES,
  operations: {
    describeIntegration: defineHarnessAdapterOperation<
      HarnessMessagingIntegrationRequest,
      HarnessMessagingIntegration
    >({
      exportName: "describeMessagingIntegration",
      requestSchema: messagingRequestSchema,
      resultSchema: messagingIntegrationSchema,
      resultDescription: "messaging integration",
    }),
  },
});
