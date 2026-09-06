// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AnySchemaObject } from "ajv";
import type {
  HarnessProviderBrokerPlan,
  HarnessProviderBrokerPlanRequest,
} from "@nvidia/nemoclaw-harness-contract";

import { defineHarnessAdapterContract, defineHarnessAdapterOperation } from "./contract";

export type {
  HarnessProviderBrokerOperation,
  HarnessProviderBrokerPlan,
  HarnessProviderBrokerPlanRequest,
} from "@nvidia/nemoclaw-harness-contract";

const planRequestSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["operation", "sandboxName"],
  properties: {
    operation: {
      enum: ["describe-provider", "register-refresh-provider", "ensure-broker"],
    },
    sandboxName: {
      type: "string",
      minLength: 1,
      maxLength: 63,
      pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$",
    },
  },
});

const planResultSchema: AnySchemaObject = Object.freeze({
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "reason"],
      properties: {
        kind: { const: "unsupported" },
        reason: { type: "string", minLength: 1, maxLength: 512 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "providerName"],
      properties: {
        kind: { const: "managed" },
        providerName: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$",
        },
      },
    },
  ],
});

const manifestSchema: AnySchemaObject = Object.freeze({
  type: "object",
  required: ["provider_broker"],
  properties: {
    provider_broker: {
      type: "object",
      additionalProperties: false,
      required: ["adapter", "operations", "support"],
      properties: {
        adapter: { const: "provider-broker" },
        operations: {
          type: "array",
          minItems: 3,
          maxItems: 3,
          uniqueItems: true,
          items: {
            enum: ["describe-provider", "register-refresh-provider", "ensure-broker"],
          },
        },
        support: { const: "managed" },
      },
    },
  },
});

export const HARNESS_PROVIDER_BROKER_ADAPTER_CONTRACT = defineHarnessAdapterContract({
  displayName: "provider-broker adapter",
  modulePath: "host/provider-broker-adapter.cts",
  manifestSchema,
  sourceMaxBytes: 256 * 1024,
  requestMaxBytes: 16 * 1024,
  resultMaxBytes: 16 * 1024,
  operations: {
    plan: defineHarnessAdapterOperation<
      HarnessProviderBrokerPlanRequest,
      HarnessProviderBrokerPlan
    >({
      exportName: "buildProviderBrokerPlan",
      requestSchema: planRequestSchema,
      resultSchema: planResultSchema,
      resultDescription: "provider-broker plan",
    }),
  },
});
