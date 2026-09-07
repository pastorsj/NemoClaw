// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AnySchemaObject } from "ajv";

import type {
  HarnessInitialStartupProfileRequest,
  HarnessInitialStartupProfileResult,
  HarnessPrepareStartupProfileRequest,
  HarnessPrepareStartupProfileResult,
  HarnessReconcileStartupProfileRequest,
  HarnessReconcileStartupProfileResult,
  HarnessStartupAdapterRequest,
  HarnessStartupPlan,
  HarnessStartupSettings,
} from "@nvidia/nemoclaw-harness-contract";
import { defineHarnessAdapterContract, defineHarnessAdapterOperation } from "./contract.ts";
import { prepareHarnessAdapterValue } from "./schema.ts";

export type {
  HarnessInitialStartupProfileRequest,
  HarnessInitialStartupProfileResult,
  HarnessPrepareStartupProfileRequest,
  HarnessPrepareStartupProfileResult,
  HarnessReconcileStartupProfileRequest,
  HarnessReconcileStartupProfileResult,
  HarnessStartupAdapterRequest,
  HarnessStartupPlan,
} from "@nvidia/nemoclaw-harness-contract";

const STARTUP_ADAPTER_SOURCE_MAX_BYTES = 1024 * 1024;
const STARTUP_ADAPTER_VALUE_MAX_BYTES = 2 * 1024 * 1024;
const safeTextSchema: AnySchemaObject = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 4096,
  pattern: "^[^\\u0000-\\u001f\\u007f]+$",
});
const nullableSafeTextSchema: AnySchemaObject = Object.freeze({
  anyOf: [{ type: "null" }, safeTextSchema],
});
const jsonDefinitions = Object.freeze({
  startupJsonValue: {
    oneOf: [
      { type: "null" },
      { type: "boolean" },
      { type: "number" },
      { type: "string", maxLength: 512 * 1024 },
      {
        type: "array",
        maxItems: 4096,
        items: { $ref: "#/$defs/startupJsonValue" },
      },
      {
        type: "object",
        maxProperties: 4096,
        propertyNames: { type: "string", minLength: 1, maxLength: 1024 },
        additionalProperties: { $ref: "#/$defs/startupJsonValue" },
      },
    ],
  },
});
const jsonObjectSchema: AnySchemaObject = Object.freeze({
  type: "object",
  maxProperties: 4096,
  propertyNames: { type: "string", minLength: 1, maxLength: 1024 },
  additionalProperties: { $ref: "#/$defs/startupJsonValue" },
});
const packageIdentitySchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["kind", "id", "packageVersion", "contentDigest"],
  properties: {
    kind: { const: "agent-runtime" },
    id: { type: "string", minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9._-]+$" },
    packageVersion: safeTextSchema,
    contentDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
  },
});
const desiredStateSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [
    "configuration",
    "inference",
    "proxy",
    "dashboard",
    "tools",
    "messaging",
    "tuning",
    "corporateCa",
  ],
  properties: {
    configuration: {
      type: "object",
      additionalProperties: { $ref: "#/$defs/startupJsonValue" },
      properties: {
        agent: safeTextSchema,
        webSearch: {
          type: "object",
          additionalProperties: false,
          required: ["enabled", "provider"],
          properties: {
            enabled: { type: "boolean" },
            provider: { enum: ["brave", "tavily"] },
          },
        },
        otel: {
          type: "object",
          additionalProperties: false,
          required: ["enabled", "endpointUrl", "serviceName", "sampleRate"],
          properties: {
            enabled: { type: "boolean" },
            endpointUrl: safeTextSchema,
            serviceName: safeTextSchema,
            sampleRate: { type: "number", minimum: 0, maximum: 1 },
          },
        },
        agentTimeoutSeconds: { type: "number", exclusiveMinimum: 0, maximum: 1_000_000_000 },
        heartbeatEvery: nullableSafeTextSchema,
        extraAgents: {
          type: "object",
          additionalProperties: false,
          required: ["agents", "defaults", "main"],
          properties: {
            agents: { type: "array", maxItems: 4096, items: jsonObjectSchema },
            defaults: jsonObjectSchema,
            main: jsonObjectSchema,
          },
        },
        deviceAuth: {
          type: "object",
          additionalProperties: false,
          required: ["disabled", "optOutSource"],
          properties: {
            disabled: { type: "boolean" },
            optOutSource: { enum: ["operator", "managed-onboard"] },
          },
        },
        minimalBootstrap: { type: "boolean" },
        autoApprovalMode: { enum: ["disabled", "thread-opt-in"] },
        observabilityEnabled: { type: "boolean" },
      },
    },
    inference: {
      type: "object",
      additionalProperties: false,
      required: [
        "routeProvider",
        "upstreamProvider",
        "model",
        "routedBaseUrl",
        "upstreamEndpointUrl",
        "api",
        "primaryModelRef",
        "compatibility",
        "inputModalities",
      ],
      properties: {
        routeProvider: safeTextSchema,
        upstreamProvider: safeTextSchema,
        model: safeTextSchema,
        routedBaseUrl: safeTextSchema,
        upstreamEndpointUrl: nullableSafeTextSchema,
        api: { enum: ["openai-completions", "openai-responses", "anthropic-messages"] },
        primaryModelRef: nullableSafeTextSchema,
        compatibility: { anyOf: [{ type: "null" }, jsonObjectSchema] },
        inputModalities: {
          anyOf: [
            { type: "null" },
            {
              type: "array",
              maxItems: 2,
              uniqueItems: true,
              items: { enum: ["text", "image"] },
            },
          ],
        },
      },
    },
    proxy: {
      type: "object",
      additionalProperties: false,
      required: ["managedHost", "managedPort", "hostHttpUrl", "hostHttpsUrl", "hostNoProxy"],
      properties: {
        managedHost: safeTextSchema,
        managedPort: { type: "integer", minimum: 1, maximum: 65_535 },
        hostHttpUrl: nullableSafeTextSchema,
        hostHttpsUrl: nullableSafeTextSchema,
        hostNoProxy: { type: "array", maxItems: 256, uniqueItems: true, items: safeTextSchema },
      },
    },
    dashboard: {
      type: "object",
      additionalProperties: false,
      required: ["mode"],
      properties: {
        agent: safeTextSchema,
        mode: { enum: ["disabled", "loopback", "remote", "loopback-forwarded"] },
        url: safeTextSchema,
        browserUrl: safeTextSchema,
        port: { type: "integer", minimum: 1, maximum: 65_535 },
        bindAddress: { enum: ["127.0.0.1", "0.0.0.0"] },
        wslExposure: { type: "boolean" },
        publicPort: { anyOf: [{ type: "null" }, { type: "integer", minimum: 1, maximum: 65_535 }] },
        internalPort: {
          anyOf: [{ type: "null" }, { type: "integer", minimum: 1, maximum: 65_535 }],
        },
        tuiEnabled: { type: "boolean" },
      },
    },
    tools: {
      type: "object",
      additionalProperties: false,
      required: ["disclosure", "enabledGateways"],
      properties: {
        disclosure: { enum: ["progressive", "direct"] },
        enabledGateways: { type: "array", maxItems: 256, uniqueItems: true, items: safeTextSchema },
      },
    },
    messaging: {
      type: "object",
      additionalProperties: false,
      required: ["plan"],
      properties: { plan: { anyOf: [{ type: "null" }, jsonObjectSchema] } },
    },
    tuning: {
      type: "object",
      additionalProperties: false,
      required: ["contextWindow", "maxTokens", "reasoning", "reasoningEffort"],
      properties: {
        contextWindow: {
          anyOf: [{ type: "null" }, { type: "integer", minimum: 1, maximum: 1_000_000_000 }],
        },
        maxTokens: {
          anyOf: [{ type: "null" }, { type: "integer", minimum: 1, maximum: 1_000_000_000 }],
        },
        reasoning: { anyOf: [{ type: "null" }, { type: "boolean" }] },
        reasoningEffort: {
          anyOf: [{ type: "null" }, { enum: ["default", "low", "medium", "high"] }],
        },
      },
    },
    corporateCa: {
      type: "object",
      additionalProperties: false,
      required: ["bundleSha256"],
      properties: {
        bundleSha256: {
          anyOf: [{ type: "null" }, { type: "string", pattern: "^[a-f0-9]{64}$" }],
        },
      },
    },
  },
  $defs: jsonDefinitions,
});

const preparationInputSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [
    "inference",
    "dashboard",
    "webSearch",
    "tools",
    "messagingPlan",
    "approvalMode",
    "observabilityEnabled",
    "proxy",
    "environment",
    "corporateCa",
    "credentialProxyPresent",
  ],
  properties: {
    inference: {
      type: "object",
      additionalProperties: false,
      required: [
        "selectedProvider",
        "model",
        "endpointUrl",
        "resolvedContextWindow",
        "reasoningEnabled",
        "reasoningEffort",
        "candidates",
      ],
      properties: {
        selectedProvider: nullableSafeTextSchema,
        model: safeTextSchema,
        endpointUrl: nullableSafeTextSchema,
        resolvedContextWindow: {
          anyOf: [{ type: "null" }, { type: "integer", minimum: 1, maximum: 1_000_000_000 }],
        },
        reasoningEnabled: { anyOf: [{ type: "null" }, { type: "boolean" }] },
        reasoningEffort: {
          anyOf: [{ type: "null" }, { enum: ["low", "medium", "high"] }],
        },
        candidates: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "requestedApi",
              "routeProvider",
              "routedBaseUrl",
              "api",
              "primaryModelRef",
              "compatibility",
            ],
            properties: {
              requestedApi: {
                anyOf: [
                  { type: "null" },
                  { enum: ["openai-completions", "openai-responses", "anthropic-messages"] },
                ],
              },
              routeProvider: safeTextSchema,
              routedBaseUrl: safeTextSchema,
              api: { enum: ["openai-completions", "openai-responses", "anthropic-messages"] },
              primaryModelRef: safeTextSchema,
              compatibility: { anyOf: [{ type: "null" }, jsonObjectSchema] },
            },
          },
        },
      },
    },
    dashboard: {
      type: "object",
      additionalProperties: false,
      required: ["managed", "url", "port", "bindAddress", "wslExposure", "forwarding"],
      properties: {
        managed: { type: "boolean" },
        url: { type: "string", maxLength: 4096 },
        port: { type: "integer", minimum: 0, maximum: 65_535 },
        bindAddress: {
          anyOf: [{ type: "null" }, { type: "string", minLength: 1, maxLength: 256 }],
        },
        wslExposure: { type: "boolean" },
        forwarding: {
          type: "object",
          additionalProperties: false,
          required: ["enabled", "publicPort", "internalPort", "tuiEnabled"],
          properties: {
            enabled: { type: "boolean" },
            publicPort: {
              anyOf: [{ type: "null" }, { type: "integer", minimum: 1, maximum: 65_535 }],
            },
            internalPort: {
              anyOf: [{ type: "null" }, { type: "integer", minimum: 1, maximum: 65_535 }],
            },
            tuiEnabled: { type: "boolean" },
          },
        },
      },
    },
    webSearch: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["enabled", "provider"],
          properties: {
            enabled: { type: "boolean" },
            provider: { anyOf: [{ type: "null" }, { enum: ["brave", "tavily"] }] },
          },
        },
      ],
    },
    tools: {
      type: "object",
      additionalProperties: false,
      required: ["disclosure", "enabledGateways"],
      properties: {
        disclosure: { enum: ["progressive", "direct"] },
        enabledGateways: {
          type: "array",
          maxItems: 256,
          uniqueItems: true,
          items: safeTextSchema,
        },
      },
    },
    messagingPlan: { anyOf: [{ type: "null" }, jsonObjectSchema] },
    approvalMode: { enum: ["disabled", "thread-opt-in"] },
    observabilityEnabled: { type: "boolean" },
    proxy: {
      type: "object",
      additionalProperties: false,
      required: ["managedHost", "managedPort", "hostHttpUrl", "hostHttpsUrl", "hostNoProxy"],
      properties: {
        managedHost: safeTextSchema,
        managedPort: { type: "integer", minimum: 1, maximum: 65_535 },
        hostHttpUrl: nullableSafeTextSchema,
        hostHttpsUrl: nullableSafeTextSchema,
        hostNoProxy: { type: "array", maxItems: 256, uniqueItems: true, items: safeTextSchema },
      },
    },
    environment: {
      type: "object",
      maxProperties: 32,
      propertyNames: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,127}$" },
      additionalProperties: {
        type: "string",
        maxLength: 64 * 1024,
        pattern: "^[^\\u0000]*$",
      },
    },
    corporateCa: {
      type: "object",
      additionalProperties: false,
      required: ["bundleSha256"],
      properties: {
        bundleSha256: {
          anyOf: [{ type: "null" }, { type: "string", pattern: "^[a-f0-9]{64}$" }],
        },
      },
    },
    credentialProxyPresent: { type: "boolean" },
  },
  $defs: jsonDefinitions,
});

const prepareProfileRequestSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["packageId", "harnessPackage", "phase", "input", "previousDesiredState"],
  properties: {
    packageId: { type: "string", minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9._-]+$" },
    harnessPackage: packageIdentitySchema,
    phase: { enum: ["initial", "rebuild"] },
    input: preparationInputSchema,
    previousDesiredState: { anyOf: [{ type: "null" }, desiredStateSchema] },
  },
  $defs: jsonDefinitions,
});

const prepareProfileResultSchema: AnySchemaObject = Object.freeze({
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
      required: [
        "kind",
        "desiredState",
        "credentialProxyReplayRequired",
        "dashboardRemoteBindPrepared",
      ],
      properties: {
        kind: { const: "prepared" },
        desiredState: desiredStateSchema,
        credentialProxyReplayRequired: { type: "boolean" },
        dashboardRemoteBindPrepared: { type: "boolean" },
      },
    },
  ],
  $defs: jsonDefinitions,
});

/** Validate normalized startup intent without consulting the built-in harness catalogue. */
export function parseHarnessStartupDesiredState(value: unknown): HarnessStartupSettings {
  return prepareHarnessAdapterValue<HarnessStartupSettings>({
    value,
    schema: desiredStateSchema,
    maxBytes: STARTUP_ADAPTER_VALUE_MAX_BYTES,
    label: "Harness startup desired state",
  });
}

function profileRequestSchema(reconcile: boolean): AnySchemaObject {
  return {
    type: "object",
    additionalProperties: false,
    required: reconcile
      ? ["packageId", "harnessPackage", "desiredState", "currentPackageConfig"]
      : ["packageId", "harnessPackage", "desiredState"],
    properties: {
      packageId: {
        type: "string",
        minLength: 1,
        maxLength: 256,
        pattern: "^[A-Za-z0-9._-]+$",
      },
      harnessPackage: packageIdentitySchema,
      desiredState: desiredStateSchema,
      ...(reconcile ? { currentPackageConfig: jsonObjectSchema } : {}),
    },
    $defs: jsonDefinitions,
  };
}

function profileResultSchema(reconcile: boolean): AnySchemaObject {
  return {
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
        required: reconcile ? ["kind", "packageConfig", "changed"] : ["kind", "packageConfig"],
        properties: {
          kind: { const: "package-config" },
          packageConfig: jsonObjectSchema,
          ...(reconcile ? { changed: { type: "boolean" } } : {}),
        },
      },
    ],
    $defs: jsonDefinitions,
  };
}

const startupManifestSchema: AnySchemaObject = Object.freeze({
  type: "object",
});

const applicationEnvironmentSchema: AnySchemaObject = Object.freeze({
  type: "object",
  maxProperties: 32,
  propertyNames: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,127}$" },
  additionalProperties: { type: "string", maxLength: 64 * 1024, pattern: "^[^\\u0000]*$" },
});

const startupPlanRequestSchema: AnySchemaObject = Object.freeze({
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["packageId", "settings", "applicationEnvironment"],
      properties: {
        packageId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          pattern: "^[A-Za-z0-9._-]+$",
        },
        settings: desiredStateSchema,
        applicationEnvironment: applicationEnvironmentSchema,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: [
        "profileKind",
        "packageId",
        "harnessPackage",
        "packageConfig",
        "corporateCa",
        "applicationEnvironment",
      ],
      properties: {
        profileKind: { const: "package" },
        packageId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          pattern: "^[A-Za-z0-9._-]+$",
        },
        harnessPackage: packageIdentitySchema,
        packageConfig: jsonObjectSchema,
        corporateCa: {
          type: "object",
          additionalProperties: false,
          required: ["bundleSha256"],
          properties: {
            bundleSha256: {
              anyOf: [{ type: "null" }, { type: "string", pattern: "^[a-f0-9]{64}$" }],
            },
          },
        },
        applicationEnvironment: applicationEnvironmentSchema,
      },
    },
  ],
  $defs: jsonDefinitions,
});

// Detailed path, action, material, and environment semantics stay in the startup-plan reducer.
// This schema owns the generic JSON/result envelope before untrusted output reaches that reducer.
const startupPlanResultSchema: AnySchemaObject = Object.freeze({
  type: "object",
  maxProperties: 16,
  propertyNames: { type: "string", minLength: 1, maxLength: 128 },
  additionalProperties: { $ref: "#/$defs/startupJsonValue" },
  $defs: jsonDefinitions,
});

export const HARNESS_STARTUP_PLAN_ADAPTER_CONTRACT = defineHarnessAdapterContract({
  displayName: "startup plan",
  modulePath: "host/startup-adapter.cts",
  manifestSchema: startupManifestSchema,
  sourceMaxBytes: STARTUP_ADAPTER_SOURCE_MAX_BYTES,
  requestMaxBytes: STARTUP_ADAPTER_VALUE_MAX_BYTES,
  resultMaxBytes: STARTUP_ADAPTER_VALUE_MAX_BYTES,
  operations: {
    buildPlan: defineHarnessAdapterOperation<HarnessStartupAdapterRequest, HarnessStartupPlan>({
      exportName: "buildStartupPlan",
      requestSchema: startupPlanRequestSchema,
      resultSchema: startupPlanResultSchema,
      resultDescription: "startup plan",
    }),
  },
});

export const HARNESS_STARTUP_PROFILE_ADAPTER_CONTRACT = defineHarnessAdapterContract({
  displayName: "startup profile",
  modulePath: "host/startup-adapter.cts",
  manifestSchema: startupManifestSchema,
  sourceMaxBytes: STARTUP_ADAPTER_SOURCE_MAX_BYTES,
  requestMaxBytes: STARTUP_ADAPTER_VALUE_MAX_BYTES,
  resultMaxBytes: STARTUP_ADAPTER_VALUE_MAX_BYTES,
  operations: {
    prepareProfile: defineHarnessAdapterOperation<
      HarnessPrepareStartupProfileRequest,
      HarnessPrepareStartupProfileResult
    >({
      exportName: "prepareStartupProfile",
      requestSchema: prepareProfileRequestSchema,
      resultSchema: prepareProfileResultSchema,
      resultDescription: "prepared startup profile result",
    }),
    buildInitialProfile: defineHarnessAdapterOperation<
      HarnessInitialStartupProfileRequest,
      HarnessInitialStartupProfileResult
    >({
      exportName: "buildInitialStartupProfile",
      requestSchema: profileRequestSchema(false),
      resultSchema: profileResultSchema(false),
      resultDescription: "initial startup profile result",
    }),
    reconcileProfile: defineHarnessAdapterOperation<
      HarnessReconcileStartupProfileRequest,
      HarnessReconcileStartupProfileResult
    >({
      exportName: "reconcileStartupProfile",
      requestSchema: profileRequestSchema(true),
      resultSchema: profileResultSchema(true),
      resultDescription: "reconciled startup profile result",
    }),
  },
});
