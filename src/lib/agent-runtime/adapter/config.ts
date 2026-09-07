// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AnySchemaObject } from "ajv";
import type {
  HarnessConfigCommand,
  HarnessConfigRestoreRequest,
  HarnessConfigRestoreResult,
  HarnessConfigTransactionCommand,
  HarnessConfigUpdatePlan,
  HarnessConfigUpdateRequest,
  HarnessInferenceConfigRequest,
  HarnessInferenceConfigSupport,
  HarnessInferenceConfigUpdatePlan,
  HarnessInferenceConfigUpdateRequest,
  HarnessConfigUrlPolicy,
  HarnessConfigUrlRequest,
  HarnessExitZeroCommand,
  HarnessMutableConfigPlan,
  HarnessMutableConfigRequest,
} from "@nvidia/nemoclaw-harness-contract";

import { defineHarnessAdapterContract, defineHarnessAdapterOperation } from "./contract";

const CONFIG_ADAPTER_SOURCE_MAX_BYTES = 1024 * 1024;
const CONFIG_ADAPTER_VALUE_MAX_BYTES = 40 * 1024 * 1024;
const CONFIG_DOCUMENT_MAX_BYTES = 16 * 1024 * 1024;

export type {
  HarnessConfigCommand,
  HarnessConfigCommandSuccess,
  HarnessConfigRestoreRequest,
  HarnessConfigRestoreResult,
  HarnessConfigRestoreWritePlan,
  HarnessConfigTarget,
  HarnessConfigTransactionCommand,
  HarnessConfigUpdatePlan,
  HarnessConfigUpdateRequest,
  HarnessInferenceConfigRequest,
  HarnessInferenceConfigPostCommit,
  HarnessInferenceConfigSupport,
  HarnessInferenceConfigUpdatePlan,
  HarnessInferenceConfigUpdateRequest,
  HarnessInferenceApi,
  HarnessInferenceReasoning,
  HarnessInferenceRoute,
  HarnessSandboxReconcileDeclaration,
  HarnessSandboxReconcileRequest,
  HarnessSandboxReconcileResult,
  HarnessSandboxReconcileTrigger,
  HarnessConfigUrlPolicy,
  HarnessConfigUrlRequest,
  HarnessExitZeroCommand,
  HarnessManagedExtension,
  HarnessMutableConfigPlan,
  HarnessMutableConfigRequest,
} from "@nvidia/nemoclaw-harness-contract";

const canonicalSandboxPathSchema: AnySchemaObject = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 4096,
  pattern:
    "^/sandbox/(?!\\.{1,2}(?:/|$))(?!.*\\/\\.{1,2}(?:/|$))[^/\\\\\\u0000-\\u001f\\u007f]+(?:/[^/\\\\\\u0000-\\u001f\\u007f]+)*$",
});

const relativeFileSchema: AnySchemaObject = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 4096,
  pattern:
    "^(?!\\.{1,2}(?:/|$))(?!.*\\/\\.{1,2}(?:/|$))[^/\\\\\\u0000-\\u001f\\u007f]+(?:/[^/\\\\\\u0000-\\u001f\\u007f]+)*$",
});

const configTargetSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["directory", "file", "format", "sensitiveFiles"],
  properties: {
    directory: canonicalSandboxPathSchema,
    file: relativeFileSchema,
    format: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z0-9-]+$" },
    sensitiveFiles: {
      type: "array",
      maxItems: 32,
      uniqueItems: true,
      items: canonicalSandboxPathSchema,
    },
  },
});

const exitZeroSuccessSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: { kind: { const: "exit-zero" } },
});

const configTransactionSuccessSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["kind", "action", "configDirectory", "protectedFiles"],
  properties: {
    kind: { const: "config-transaction" },
    action: { type: "string", minLength: 1, maxLength: 128 },
    configDirectory: canonicalSandboxPathSchema,
    protectedFiles: {
      type: "array",
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
      items: relativeFileSchema,
    },
  },
});

function configCommandSchema(successSchema: AnySchemaObject): AnySchemaObject {
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["command", "timeoutSeconds", "failureMessage", "success"],
    properties: {
      command: {
        type: "array",
        minItems: 1,
        maxItems: 512,
        items: {
          type: "string",
          minLength: 1,
          maxLength: 65_536,
          pattern: "^[^\\u0000]+$",
        },
      },
      timeoutSeconds: { type: "integer", minimum: 1, maximum: 3600 },
      failureMessage: { type: "string", minLength: 1, maxLength: 8192 },
      recoveryGuidance: {
        type: "array",
        maxItems: 16,
        items: { type: "string", minLength: 1, maxLength: 8192 },
      },
      success: successSchema,
    },
  });
}

const commandSchema = configCommandSchema({
  oneOf: [exitZeroSuccessSchema, configTransactionSuccessSchema],
});
const exitZeroCommandSchema = configCommandSchema(exitZeroSuccessSchema);

const sandboxReconcileCommandSchema: AnySchemaObject = Object.freeze({
  type: "array",
  minItems: 1,
  maxItems: 32,
  items: {
    type: "string",
    minLength: 1,
    maxLength: 4096,
    pattern: "^[^\\u0000\\r\\n]+$",
  },
});

const sandboxReconcileManifestSchema: AnySchemaObject = Object.freeze({
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: { kind: { const: "not-required" } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "trigger", "command", "timeout_seconds"],
      properties: {
        kind: { const: "command" },
        trigger: { enum: ["after-config-sync", "when-config-changes"] },
        command: sandboxReconcileCommandSchema,
        timeout_seconds: { type: "integer", minimum: 1, maximum: 120 },
      },
    },
  ],
});

const configManifestSchema: AnySchemaObject = Object.freeze({
  type: "object",
  required: ["name", "config", "inference"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 256 },
    config: {
      type: "object",
      required: ["dir", "config_file", "format"],
      properties: {
        dir: canonicalSandboxPathSchema,
        config_file: relativeFileSchema,
        format: { type: "string", minLength: 1, maxLength: 64 },
      },
    },
    inference: {
      type: "object",
      required: ["config_update"],
      properties: {
        config_update: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["support", "provider_api_overrides", "post_commit"],
              properties: {
                support: { const: "mutable" },
                provider_api_overrides: {
                  type: "array",
                  maxItems: 32,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["provider", "api"],
                    properties: {
                      provider: {
                        type: "string",
                        minLength: 1,
                        maxLength: 256,
                        pattern: "^[A-Za-z0-9._-]+$",
                      },
                      api: {
                        enum: ["openai-completions", "anthropic-messages", "openai-responses"],
                      },
                    },
                  },
                },
                post_commit: {
                  type: "object",
                  additionalProperties: false,
                  required: ["config_sync", "gateway_restart", "sandbox_reconcile"],
                  properties: {
                    config_sync: { enum: ["best-effort", "required"] },
                    gateway_restart: { enum: ["not-required", "when-api-changes"] },
                    sandbox_reconcile: sandboxReconcileManifestSchema,
                  },
                },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["support", "reason"],
              properties: {
                support: { const: "unsupported" },
                reason: { type: "string", minLength: 1, maxLength: 8192 },
              },
            },
          ],
        },
      },
    },
  },
});

const updateRequestSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["config", "serializedConfig", "expectedConfigSha256", "target"],
  properties: {
    config: { type: "object" },
    serializedConfig: { type: "string", maxLength: CONFIG_DOCUMENT_MAX_BYTES },
    expectedConfigSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    target: configTargetSchema,
  },
});

const inferenceRequestSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["target"],
  properties: { target: configTargetSchema },
});

const inferenceSupportSchema: AnySchemaObject = Object.freeze({
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "providerApiOverrides"],
      properties: {
        kind: { const: "mutable" },
        providerApiOverrides: {
          type: "array",
          maxItems: 32,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["provider", "api"],
            properties: {
              provider: {
                type: "string",
                minLength: 1,
                maxLength: 256,
                pattern: "^[A-Za-z0-9._-]+$",
              },
              api: {
                enum: ["openai-completions", "anthropic-messages", "openai-responses"],
              },
            },
          },
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "reason"],
      properties: {
        kind: { const: "unsupported" },
        reason: { type: "string", minLength: 1, maxLength: 8192 },
      },
    },
  ],
});

const inferenceApiSchema: AnySchemaObject = Object.freeze({
  enum: ["openai-completions", "anthropic-messages", "openai-responses"],
});

const inferenceUpdateRequestSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["target", "config", "route", "contextWindow", "reasoning"],
  properties: {
    target: configTargetSchema,
    config: { type: "object" },
    route: {
      type: "object",
      additionalProperties: false,
      required: [
        "upstreamProvider",
        "model",
        "providerKey",
        "primaryModelRef",
        "baseUrl",
        "api",
        "compatibility",
      ],
      properties: {
        upstreamProvider: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          pattern: "^[^\\u0000\\r\\n]+$",
        },
        model: {
          type: "string",
          minLength: 1,
          maxLength: 4096,
          pattern: "^[A-Za-z0-9._:/-]+$",
        },
        providerKey: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          pattern: "^[A-Za-z0-9._-]+$",
        },
        primaryModelRef: {
          anyOf: [
            { type: "null" },
            {
              type: "string",
              minLength: 1,
              maxLength: 4096,
              pattern: "^[A-Za-z0-9._:/-]+$",
            },
          ],
        },
        baseUrl: {
          type: "string",
          minLength: 1,
          maxLength: 4096,
          pattern: "^https://inference[.]local(?:/v1)?$",
        },
        api: inferenceApiSchema,
        compatibility: { anyOf: [{ type: "null" }, { type: "object" }] },
      },
    },
    contextWindow: {
      anyOf: [{ type: "null" }, { type: "integer", minimum: 1, maximum: 2_147_483_647 }],
    },
    reasoning: {
      type: "object",
      additionalProperties: false,
      required: ["effort", "explicit"],
      properties: {
        effort: { anyOf: [{ type: "null" }, { enum: ["low", "medium", "high"] }] },
        explicit: { type: "boolean" },
      },
    },
  },
});

const inferencePostCommitSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["configSync", "gatewayRestart", "sandboxReconcile"],
  properties: {
    configSync: { enum: ["best-effort", "required"] },
    gatewayRestart: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind"],
          properties: { kind: { const: "not-required" } },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "previousApi"],
          properties: {
            kind: { const: "when-api-changes" },
            previousApi: { anyOf: [{ type: "null" }, inferenceApiSchema] },
          },
        },
      ],
    },
    sandboxReconcile: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind"],
          properties: { kind: { const: "not-required" } },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "trigger", "command", "timeoutSeconds"],
          properties: {
            kind: { const: "command" },
            trigger: { enum: ["after-config-sync", "when-config-changes"] },
            command: sandboxReconcileCommandSchema,
            timeoutSeconds: { type: "integer", minimum: 1, maximum: 120 },
          },
        },
      ],
    },
  },
});

const inferenceUpdateResultSchema: AnySchemaObject = Object.freeze({
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
      required: ["kind", "config", "changed", "postCommit"],
      properties: {
        kind: { const: "mutation" },
        config: { type: "object" },
        changed: { type: "boolean" },
        postCommit: inferencePostCommitSchema,
      },
    },
  ],
});

const updateResultSchema: AnySchemaObject = Object.freeze({
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "reason"],
      properties: {
        kind: { const: "immutable" },
        reason: { type: "string", minLength: 1, maxLength: 8192 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "content", "validation", "write", "restart"],
      properties: {
        kind: { const: "transaction" },
        content: { type: "string", maxLength: CONFIG_DOCUMENT_MAX_BYTES },
        validation: { anyOf: [{ type: "null" }, exitZeroCommandSchema] },
        write: commandSchema,
        restart: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "guidance"],
          properties: {
            kind: { enum: ["managed", "external"] },
            guidance: {
              type: "array",
              maxItems: 16,
              items: { type: "string", minLength: 1, maxLength: 8192 },
            },
          },
        },
      },
    },
  ],
});

const urlRequestSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["config", "key", "relativePath"],
  properties: {
    config: { type: "object" },
    key: { type: "string", minLength: 1, maxLength: 4096, pattern: "^[^\\u0000]+$" },
    relativePath: {
      type: "array",
      maxItems: 128,
      items: { type: "string", maxLength: 1024, pattern: "^[^\\u0000]+$" },
    },
  },
});

const urlResultSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["allowPrivateUrls", "allowOpenShellBridge"],
  properties: {
    allowPrivateUrls: { type: "boolean" },
    allowOpenShellBridge: { type: "boolean" },
  },
});

const mutableRequestSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["target", "sandboxUid", "sandboxGid"],
  properties: {
    target: configTargetSchema,
    sandboxUid: { anyOf: [{ type: "null" }, { type: "string", pattern: "^[1-9][0-9]*$" }] },
    sandboxGid: { anyOf: [{ type: "null" }, { type: "string", pattern: "^[1-9][0-9]*$" }] },
  },
});

const mutableResultSchema: AnySchemaObject = Object.freeze({
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "reason"],
      properties: {
        kind: { const: "not-required" },
        reason: { type: "string", minLength: 1, maxLength: 8192 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "directoryMode", "directoryOwner", "fileMode", "fileOwner", "repair"],
      properties: {
        kind: { const: "stat" },
        directoryMode: { type: "string", pattern: "^[0-7]{3,4}$" },
        directoryOwner: { type: "string", minLength: 1, maxLength: 256 },
        fileMode: { type: "string", pattern: "^[0-7]{3,4}$" },
        fileOwner: { type: "string", minLength: 1, maxLength: 256 },
        repair: { anyOf: [{ type: "null" }, exitZeroCommandSchema] },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "probe"],
      properties: { kind: { const: "probe" }, probe: exitZeroCommandSchema },
    },
  ],
});

const managedExtensionSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["id", "directory", "configPaths"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 256 },
    directory: {
      anyOf: [
        { type: "null" },
        { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._+~-]*$" },
      ],
    },
    configPaths: {
      type: "array",
      maxItems: 8,
      uniqueItems: true,
      items: canonicalSandboxPathSchema,
    },
  },
});

const restoreRequestSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [
    "backupContent",
    "currentContent",
    "managedChannelNames",
    "previousManagedExtensions",
    "freshManagedExtensions",
  ],
  properties: {
    backupContent: { type: "string", maxLength: CONFIG_DOCUMENT_MAX_BYTES },
    currentContent: {
      anyOf: [{ type: "null" }, { type: "string", maxLength: CONFIG_DOCUMENT_MAX_BYTES }],
    },
    managedChannelNames: {
      type: "array",
      maxItems: 512,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 256 },
    },
    previousManagedExtensions: {
      anyOf: [{ type: "null" }, { type: "array", maxItems: 128, items: managedExtensionSchema }],
    },
    freshManagedExtensions: {
      anyOf: [{ type: "null" }, { type: "array", maxItems: 128, items: managedExtensionSchema }],
    },
  },
});

const restoreResultSchema: AnySchemaObject = Object.freeze({
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "content", "write"],
      properties: {
        kind: { const: "merged" },
        content: { type: "string", maxLength: CONFIG_DOCUMENT_MAX_BYTES },
        write: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["kind"],
              properties: { kind: { const: "atomic" } },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["kind", "hashFiles"],
              properties: {
                kind: { const: "config-anchors" },
                hashFiles: {
                  type: "array",
                  minItems: 1,
                  maxItems: 32,
                  uniqueItems: true,
                  items: relativeFileSchema,
                },
              },
            },
          ],
        },
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

export const HARNESS_CONFIG_ADAPTER_CONTRACT = defineHarnessAdapterContract({
  displayName: "configuration adapter",
  modulePath: "host/config-adapter.cts",
  manifestSchema: configManifestSchema,
  sourceMaxBytes: CONFIG_ADAPTER_SOURCE_MAX_BYTES,
  requestMaxBytes: CONFIG_ADAPTER_VALUE_MAX_BYTES,
  resultMaxBytes: CONFIG_ADAPTER_VALUE_MAX_BYTES,
  operations: {
    describeInference: defineHarnessAdapterOperation<
      HarnessInferenceConfigRequest,
      HarnessInferenceConfigSupport
    >({
      exportName: "describeInferenceConfig",
      requestSchema: inferenceRequestSchema,
      resultSchema: inferenceSupportSchema,
      resultDescription: "inference configuration support",
    }),
    prepareInference: defineHarnessAdapterOperation<
      HarnessInferenceConfigUpdateRequest,
      HarnessInferenceConfigUpdatePlan
    >({
      exportName: "prepareInferenceConfig",
      requestSchema: inferenceUpdateRequestSchema,
      resultSchema: inferenceUpdateResultSchema,
      resultDescription: "inference configuration update plan",
    }),
    prepareUpdate: defineHarnessAdapterOperation<
      HarnessConfigUpdateRequest,
      HarnessConfigUpdatePlan
    >({
      exportName: "prepareConfigUpdate",
      requestSchema: updateRequestSchema,
      resultSchema: updateResultSchema,
      resultDescription: "configuration update plan",
    }),
    classifyUrl: defineHarnessAdapterOperation<HarnessConfigUrlRequest, HarnessConfigUrlPolicy>({
      exportName: "classifyConfigUrl",
      requestSchema: urlRequestSchema,
      resultSchema: urlResultSchema,
      resultDescription: "configuration URL policy",
    }),
    describeMutable: defineHarnessAdapterOperation<
      HarnessMutableConfigRequest,
      HarnessMutableConfigPlan
    >({
      exportName: "describeMutableConfig",
      requestSchema: mutableRequestSchema,
      resultSchema: mutableResultSchema,
      resultDescription: "mutable configuration plan",
    }),
  },
});

export const HARNESS_CONFIG_RESTORE_CONTRACT = defineHarnessAdapterContract({
  displayName: "configuration restore adapter",
  modulePath: "host/restore-adapter.cts",
  manifestSchema: configManifestSchema,
  sourceMaxBytes: CONFIG_ADAPTER_SOURCE_MAX_BYTES,
  requestMaxBytes: CONFIG_ADAPTER_VALUE_MAX_BYTES,
  resultMaxBytes: CONFIG_ADAPTER_VALUE_MAX_BYTES,
  operations: {
    mergeState: defineHarnessAdapterOperation<
      HarnessConfigRestoreRequest,
      HarnessConfigRestoreResult
    >({
      exportName: "mergeConfigState",
      requestSchema: restoreRequestSchema,
      resultSchema: restoreResultSchema,
      resultDescription: "configuration restore result",
    }),
  },
});
