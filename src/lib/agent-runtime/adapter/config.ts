// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AnySchemaObject } from "ajv";

import { defineHarnessAdapterContract, defineHarnessAdapterOperation } from "./contract";

const CONFIG_ADAPTER_SOURCE_MAX_BYTES = 1024 * 1024;
const CONFIG_ADAPTER_VALUE_MAX_BYTES = 40 * 1024 * 1024;
const CONFIG_DOCUMENT_MAX_BYTES = 16 * 1024 * 1024;

export interface HarnessConfigTarget {
  readonly directory: string;
  readonly file: string;
  readonly format: string;
  readonly sensitiveFiles: readonly string[];
}

interface HarnessConfigCommandFields {
  readonly command: readonly string[];
  readonly timeoutSeconds: number;
  readonly failureMessage: string;
  readonly recoveryGuidance?: readonly string[];
}

export interface HarnessExitZeroCommand extends HarnessConfigCommandFields {
  readonly success: { readonly kind: "exit-zero" };
}

export interface HarnessConfigTransactionCommand extends HarnessConfigCommandFields {
  readonly success: {
    readonly kind: "config-transaction";
    readonly action: string;
    readonly configDirectory: string;
    readonly protectedFiles: readonly string[];
  };
}

export type HarnessConfigCommand = HarnessExitZeroCommand | HarnessConfigTransactionCommand;

export type HarnessConfigCommandSuccess = HarnessConfigCommand["success"];

export interface HarnessConfigUpdateRequest {
  readonly config: Readonly<Record<string, unknown>>;
  readonly serializedConfig: string;
  readonly expectedConfigSha256: string;
  readonly target: HarnessConfigTarget;
}

export type HarnessConfigUpdatePlan =
  | {
      readonly kind: "immutable";
      readonly reason: string;
    }
  | {
      readonly kind: "transaction";
      readonly content: string;
      readonly validation: HarnessExitZeroCommand | null;
      readonly write: HarnessConfigCommand;
      readonly restart: {
        readonly kind: "managed" | "external";
        readonly guidance: readonly string[];
      };
    };

export interface HarnessConfigUrlRequest {
  readonly config: Readonly<Record<string, unknown>>;
  readonly key: string;
  readonly relativePath: readonly string[];
}

export interface HarnessConfigUrlPolicy {
  readonly allowPrivateUrls: boolean;
  readonly allowOpenShellBridge: boolean;
}

export interface HarnessMutableConfigRequest {
  readonly target: HarnessConfigTarget;
  readonly sandboxUid: string | null;
  readonly sandboxGid: string | null;
}

export type HarnessMutableConfigPlan =
  | { readonly kind: "not-required"; readonly reason: string }
  | {
      readonly kind: "stat";
      readonly directoryMode: string;
      readonly directoryOwner: string;
      readonly fileMode: string;
      readonly fileOwner: string;
      readonly repair: HarnessExitZeroCommand | null;
    }
  | {
      readonly kind: "probe";
      readonly probe: HarnessExitZeroCommand;
    };

export interface HarnessConfigRestoreRequest {
  readonly backupContent: string;
  readonly currentContent: string | null;
  readonly managedChannelNames: readonly string[];
  readonly previousImagePluginInstalls: readonly HarnessImagePluginInstall[] | null;
  readonly freshImagePluginInstalls: readonly HarnessImagePluginInstall[] | null;
}

export interface HarnessImagePluginInstall {
  readonly id: string;
  readonly loadPaths: readonly string[];
}

export type HarnessConfigRestoreWritePlan =
  | { readonly kind: "atomic" }
  | {
      readonly kind: "config-anchors";
      readonly hashFiles: readonly string[];
    };

export type HarnessConfigRestoreResult =
  | {
      readonly kind: "merged";
      readonly content: string;
      readonly write: HarnessConfigRestoreWritePlan;
    }
  | { readonly kind: "refused"; readonly reason: string };

const canonicalAbsolutePathSchema: AnySchemaObject = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 4096,
  pattern: "^/[^\\u0000\\r\\n]*$",
});

const relativeFileSchema: AnySchemaObject = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 4096,
  pattern: "^[^/\\\\\\u0000\\r\\n][^\\\\\\u0000\\r\\n]*$",
});

const configTargetSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["directory", "file", "format", "sensitiveFiles"],
  properties: {
    directory: canonicalAbsolutePathSchema,
    file: relativeFileSchema,
    format: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z0-9-]+$" },
    sensitiveFiles: {
      type: "array",
      maxItems: 32,
      uniqueItems: true,
      items: canonicalAbsolutePathSchema,
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
    configDirectory: canonicalAbsolutePathSchema,
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

const configManifestSchema: AnySchemaObject = Object.freeze({
  type: "object",
  required: ["name", "config"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 256 },
    config: {
      type: "object",
      required: ["dir", "config_file", "format"],
      properties: {
        dir: canonicalAbsolutePathSchema,
        config_file: relativeFileSchema,
        format: { type: "string", minLength: 1, maxLength: 64 },
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

const imagePluginInstallSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["id", "loadPaths"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 256 },
    loadPaths: {
      type: "array",
      maxItems: 512,
      uniqueItems: true,
      items: canonicalAbsolutePathSchema,
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
    "previousImagePluginInstalls",
    "freshImagePluginInstalls",
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
    previousImagePluginInstalls: {
      anyOf: [{ type: "null" }, { type: "array", maxItems: 512, items: imagePluginInstallSchema }],
    },
    freshImagePluginInstalls: {
      anyOf: [{ type: "null" }, { type: "array", maxItems: 512, items: imagePluginInstallSchema }],
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
  capability: "config",
  displayName: "configuration adapter",
  modulePath: "host/config-adapter.cts",
  manifestSchema: configManifestSchema,
  sourceMaxBytes: CONFIG_ADAPTER_SOURCE_MAX_BYTES,
  requestMaxBytes: CONFIG_ADAPTER_VALUE_MAX_BYTES,
  resultMaxBytes: CONFIG_ADAPTER_VALUE_MAX_BYTES,
  operations: {
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
  capability: "config-restore",
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
