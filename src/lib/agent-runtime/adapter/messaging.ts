// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AnySchemaObject } from "ajv";
import type {
  HarnessMessagingChannelProfile,
  HarnessMessagingDisabledIntegration,
  HarnessMessagingIntegrationRequest,
  HarnessMessagingProfileReference,
} from "@nvidia/nemoclaw-harness-contract";

import { defineHarnessAdapterContract, defineHarnessAdapterOperation } from "./contract";
import { prepareHarnessAdapterValue } from "./schema";

const MESSAGING_ADAPTER_SOURCE_MAX_BYTES = 128 * 1024;
const MESSAGING_ADAPTER_VALUE_MAX_BYTES = 128 * 1024;

export type {
  HarnessMessagingAdapterModule,
  HarnessMessagingDisabledIntegration,
  HarnessMessagingIntegration,
  HarnessMessagingIntegrationRequest,
  HarnessMessagingProfileReference,
  HarnessMessagingSupportedIntegration,
} from "@nvidia/nemoclaw-harness-contract";

const canonicalIdSchema: AnySchemaObject = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 256,
  pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
});

const boundedStringSchema: AnySchemaObject = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 8192,
});

const policyKeySchema: AnySchemaObject = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 256,
  pattern: "^[a-z][a-z0-9_-]*$",
});

const packageItemIdSchema: AnySchemaObject = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 256,
  pattern: "^[a-z][A-Za-z0-9-]*$",
});

const stringListSchema: AnySchemaObject = Object.freeze({
  type: "array",
  maxItems: 128,
  items: boundedStringSchema,
});

const configRenderSchema: AnySchemaObject = Object.freeze({
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["id", "kind", "target", "path", "value"],
      properties: {
        id: canonicalIdSchema,
        kind: { const: "json-fragment" },
        target: boundedStringSchema,
        when: boundedStringSchema,
        path: boundedStringSchema,
        value: true,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["id", "kind", "target", "lines"],
      properties: {
        id: canonicalIdSchema,
        kind: { const: "env-lines" },
        target: boundedStringSchema,
        when: boundedStringSchema,
        lines: stringListSchema,
      },
    },
  ],
});

const policyEntrySchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["presetName", "policyKeys"],
  properties: {
    presetName: canonicalIdSchema,
    policyKeys: {
      type: "array",
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
      items: policyKeySchema,
    },
    requiredAtCreate: { type: "boolean" },
    validationWarningLines: stringListSchema,
  },
});

const runtimeProfileSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    channelName: canonicalIdSchema,
    visibility: {
      type: "object",
      additionalProperties: false,
      required: ["configKeys", "logPatterns"],
      properties: { configKeys: stringListSchema, logPatterns: stringListSchema },
    },
    nodePreloads: {
      type: "array",
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["module"],
        properties: {
          module: canonicalIdSchema,
          injectInto: {
            type: "array",
            maxItems: 2,
            uniqueItems: true,
            items: { enum: ["boot", "connect"] },
          },
          optional: { type: "boolean" },
          installMessage: boundedStringSchema,
          installedMessage: boundedStringSchema,
        },
      },
    },
    envAliases: {
      type: "array",
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["envKey", "match", "value"],
        properties: {
          envKey: boundedStringSchema,
          targetEnvKey: boundedStringSchema,
          match: boundedStringSchema,
          value: boundedStringSchema,
          message: boundedStringSchema,
        },
      },
    },
    secretScans: {
      type: "array",
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "pattern"],
        properties: {
          path: boundedStringSchema,
          pattern: boundedStringSchema,
          message: boundedStringSchema,
          exitCode: { type: "integer", minimum: 1, maximum: 255 },
        },
      },
    },
  },
});

const packageInstallSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["id", "manager", "spec"],
  properties: {
    id: packageItemIdSchema,
    manager: { enum: ["node-package", "python-package"] },
    spec: boundedStringSchema,
    pin: { type: "boolean" },
    integrity: boundedStringSchema,
    integrityByVersion: {
      type: "object",
      maxProperties: 128,
      additionalProperties: boundedStringSchema,
    },
    tarballUrl: boundedStringSchema,
    tarballUrlByVersion: {
      type: "object",
      maxProperties: 128,
      additionalProperties: boundedStringSchema,
    },
    runtimeLock: {
      type: "object",
      additionalProperties: false,
      required: [
        "cachePath",
        "installCacheEnvKey",
        "lockFile",
        "projectsRoot",
        "verifierPath",
        "offline",
        "legacyPeerDeps",
      ],
      properties: {
        cachePath: boundedStringSchema,
        installCacheEnvKey: boundedStringSchema,
        lockFile: boundedStringSchema,
        projectsRoot: boundedStringSchema,
        verifierPath: boundedStringSchema,
        offline: { const: true },
        legacyPeerDeps: { const: true },
      },
    },
    required: { type: "boolean" },
  },
});

const buildProfileSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["configRoot", "packageManagers"],
  properties: {
    configRoot: { type: "string", pattern: "^~/[A-Za-z0-9._-]+$", maxLength: 256 },
    packageManagers: {
      type: "array",
      maxItems: 2,
      uniqueItems: true,
      items: { enum: ["node-package", "python-package"] },
    },
    renderFinalizers: {
      type: "array",
      maxItems: 2,
      uniqueItems: true,
      items: { enum: ["allow-rendered-plugins", "inherit-api-server-toolsets"] },
    },
    postRenderRepair: {
      type: "object",
      additionalProperties: false,
      required: ["command"],
      properties: {
        command: {
          type: "array",
          minItems: 1,
          maxItems: 16,
          items: boundedStringSchema,
        },
      },
    },
    nodeArchiveRemediation: { enum: ["package-helper"] },
    postCreateCredentialReconciliation: { enum: ["restart-runtime"] },
    credentialPolicyReconciliation: { enum: ["teams-outlook-shared-login"] },
    degradedDiagnostics: { enum: ["gateway-log-tail"] },
  },
});

const channelProfileSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["channelId", "config", "policy", "lifecycle"],
  properties: {
    channelId: canonicalIdSchema,
    config: {
      type: "object",
      additionalProperties: false,
      required: ["renders"],
      properties: {
        renders: { type: "array", maxItems: 64, items: configRenderSchema },
        statePaths: stringListSchema,
      },
    },
    policy: { type: "array", maxItems: 16, items: policyEntrySchema },
    lifecycle: {
      type: "object",
      additionalProperties: false,
      required: ["hookIds"],
      properties: {
        runtime: runtimeProfileSchema,
        packageInstalls: { type: "array", maxItems: 32, items: packageInstallSchema },
        hookIds: {
          type: "array",
          maxItems: 64,
          uniqueItems: true,
          items: canonicalIdSchema,
        },
      },
    },
  },
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
      required: ["kind", "packageId", "channelIds", "profilePath", "build"],
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
        profilePath: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          pattern: "^[a-z][a-z0-9-]*(?:/[a-z][a-z0-9-]*)*\\.json$",
        },
        build: buildProfileSchema,
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
      HarnessMessagingProfileReference | HarnessMessagingDisabledIntegration
    >({
      exportName: "describeMessagingIntegration",
      requestSchema: messagingRequestSchema,
      resultSchema: messagingIntegrationSchema,
      resultDescription: "messaging integration",
    }),
  },
});

const channelProfilesSchema: AnySchemaObject = Object.freeze({
  type: "array",
  minItems: 1,
  maxItems: 32,
  items: channelProfileSchema,
});

/** Validate receipt-bound package data before core projects it onto channel services. */
export function validateHarnessMessagingChannelProfiles(
  value: unknown,
): readonly HarnessMessagingChannelProfile[] {
  return prepareHarnessAdapterValue({
    value,
    schema: channelProfilesSchema,
    maxBytes: MESSAGING_ADAPTER_VALUE_MAX_BYTES,
    label: "Installed harness messaging channel profile",
  }) as readonly HarnessMessagingChannelProfile[];
}
