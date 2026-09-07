// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AnySchemaObject } from "ajv";
import type {
  HarnessProviderAuthPlan,
  HarnessProviderAuthPlanRequest,
} from "@nvidia/nemoclaw-harness-contract";

import { defineHarnessAdapterContract, defineHarnessAdapterOperation } from "./contract";

const requestSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["availableCredentialEnvs", "requestedMethod"],
  properties: {
    requestedMethod: { type: ["string", "null"], maxLength: 128 },
    availableCredentialEnvs: {
      type: "array",
      maxItems: 8,
      uniqueItems: true,
      items: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,127}$" },
    },
  },
});

const resultSchema: AnySchemaObject = Object.freeze({
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
      required: ["kind", "methodId"],
      properties: {
        kind: { const: "managed" },
        methodId: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          pattern: "^[a-z][a-z0-9-]*$",
        },
      },
    },
  ],
});

const manifestSchema: AnySchemaObject = Object.freeze({
  type: "object",
  required: ["provider_auth"],
  properties: {
    provider_auth: {
      type: "object",
      required: ["adapter", "operation", "support"],
      properties: {
        adapter: { const: "provider-auth" },
        operation: { const: "resolve-auth-method" },
        support: { const: "managed" },
      },
    },
  },
});

/** The sole pure package operation used to normalize provider authentication choice. */
export const HARNESS_PROVIDER_AUTH_ADAPTER_CONTRACT = defineHarnessAdapterContract({
  displayName: "provider-auth adapter",
  modulePath: "host/provider-auth-adapter.cts",
  manifestSchema,
  sourceMaxBytes: 256 * 1024,
  requestMaxBytes: 16 * 1024,
  resultMaxBytes: 16 * 1024,
  operations: {
    resolve: defineHarnessAdapterOperation<HarnessProviderAuthPlanRequest, HarnessProviderAuthPlan>(
      {
        exportName: "resolveProviderAuthMethod",
        requestSchema,
        resultSchema,
        resultDescription: "provider authentication plan",
      },
    ),
  },
});
