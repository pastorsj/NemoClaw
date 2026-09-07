// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AnySchemaObject } from "ajv";
import type {
  HarnessMessagingBuildProfile,
  HarnessMessagingChannelProfile,
  HarnessMessagingDisabledIntegration,
  HarnessMessagingIntegrationRequest,
  HarnessMessagingProfileReference,
} from "@nvidia/nemoclaw-harness-contract";

import { defineHarnessAdapterContract, defineHarnessAdapterOperation } from "./contract";
import { HarnessAdapterSchemaError, prepareHarnessAdapterValue } from "./schema";

const MESSAGING_ADAPTER_SOURCE_MAX_BYTES = 128 * 1024;
const MESSAGING_ADAPTER_VALUE_MAX_BYTES = 128 * 1024;
const INSTALLER_ENV_KEY = /^[A-Z_][A-Z0-9_]*$/u;
const SECRET_LIKE_ENV_VALUE = /(?:openshell:resolve|\{\{|\}\}|token|secret|password|api[_-]?key)/iu;

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

const configVisibilitySchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["inputId", "target", "kind"],
  properties: {
    key: packageItemIdSchema,
    inputId: packageItemIdSchema,
    target: boundedStringSchema,
    kind: { enum: ["structured", "env"] },
    path: {
      type: "array",
      minItems: 1,
      maxItems: 32,
      items: boundedStringSchema,
    },
    envKey: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      pattern: "^[A-Z_][A-Z0-9_]*$",
    },
    targetInputId: packageItemIdSchema,
    whenInput: {
      type: "object",
      additionalProperties: false,
      required: ["inputId", "equals"],
      properties: {
        inputId: packageItemIdSchema,
        equals: boundedStringSchema,
        defaultValue: boundedStringSchema,
      },
    },
  },
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

const credentialProviderSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["profilePath", "profileId", "credentialEnv", "sourceInputId"],
  properties: {
    profilePath: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      pattern: "^provider-profiles/[A-Za-z0-9._-]+\\.yaml$",
    },
    profileId: canonicalIdSchema,
    credentialEnv: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      pattern: "^[A-Z_][A-Z0-9_]*$",
    },
    sourceInputId: packageItemIdSchema,
    refresh: {
      type: "object",
      additionalProperties: false,
      required: ["strategy", "scopes", "secretMaterialKeys"],
      properties: {
        strategy: { const: "google_service_account_jwt" },
        scopes: {
          type: "array",
          minItems: 1,
          maxItems: 16,
          uniqueItems: true,
          items: {
            type: "string",
            minLength: 1,
            maxLength: 512,
            pattern: "^https://[^\\s]+$",
          },
        },
        secretMaterialKeys: {
          type: "array",
          minItems: 1,
          maxItems: 16,
          uniqueItems: true,
          items: {
            type: "string",
            minLength: 1,
            maxLength: 64,
            pattern: "^[a-z][a-z0-9_]*$",
          },
        },
      },
    },
  },
});

const fixedCommandSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["argv"],
  properties: {
    argv: {
      type: "array",
      minItems: 1,
      maxItems: 16,
      items: boundedStringSchema,
    },
  },
});

const relativeConfigPathSchema: AnySchemaObject = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$",
});

const configValuePathSegmentSchema: AnySchemaObject = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z_][A-Za-z0-9_-]*$",
});

const statusProbeSchema: AnySchemaObject = Object.freeze({
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "command", "pairingCommand"],
      properties: {
        kind: { const: "channel-status-json" },
        command: fixedCommandSchema,
        timeoutOption: {
          type: "string",
          minLength: 2,
          maxLength: 64,
          pattern: "^--[a-z][a-z0-9-]*$",
        },
        pairingCommand: fixedCommandSchema,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: [
        "kind",
        "primaryCredentialPath",
        "alternateCredentialPath",
        "primaryLabel",
        "alternateLabel",
        "pairingCommand",
      ],
      properties: {
        kind: { const: "session-files" },
        primaryCredentialPath: relativeConfigPathSchema,
        alternateCredentialPath: relativeConfigPathSchema,
        primaryLabel: boundedStringSchema,
        alternateLabel: boundedStringSchema,
        pairingCommand: fixedCommandSchema,
        configuredSessionPath: {
          type: "object",
          additionalProperties: false,
          required: ["configPath", "valuePath"],
          properties: {
            configPath: relativeConfigPathSchema,
            valuePath: {
              type: "array",
              minItems: 1,
              maxItems: 16,
              items: configValuePathSegmentSchema,
            },
          },
        },
      },
    },
  ],
});

const buildFileTemplateSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["id", "pathTemplate"],
  properties: {
    id: packageItemIdSchema,
    required: { type: "boolean" },
    pathTemplate: boundedStringSchema,
    mode: {
      type: "string",
      pattern: "^0[0-7]{3}$",
    },
    content: true,
    merge: true,
  },
});

const hookOperationSchema: AnySchemaObject = Object.freeze({
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["hookId", "kind", "outputIds"],
      properties: {
        hookId: canonicalIdSchema,
        kind: { const: "config-prompt" },
        outputIds: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          uniqueItems: true,
          items: packageItemIdSchema,
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["hookId", "kind", "command", "output"],
      properties: {
        hookId: canonicalIdSchema,
        kind: { const: "sandbox-command" },
        command: fixedCommandSchema,
        output: { enum: ["bridge-health", "channel-health"] },
        context: { const: "channel-health" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["hookId", "kind", "inputIds", "outputs"],
      properties: {
        hookId: canonicalIdSchema,
        kind: { const: "build-files" },
        inputIds: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          uniqueItems: true,
          items: boundedStringSchema,
        },
        outputs: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          items: buildFileTemplateSchema,
        },
      },
    },
  ],
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
    packageInstallers: {
      type: "object",
      additionalProperties: false,
      properties: {
        "node-package": {
          type: "object",
          additionalProperties: false,
          required: ["kind", "command"],
          properties: {
            kind: { const: "verified-archive-command" },
            command: {
              type: "array",
              minItems: 2,
              maxItems: 16,
              items: boundedStringSchema,
            },
            archiveArgumentPrefix: { const: "npm-pack:" },
            packageVersionEnvironment: boundedStringSchema,
          },
        },
        "python-package": {
          type: "object",
          additionalProperties: false,
          required: ["kind", "command"],
          properties: {
            kind: { const: "batched-command" },
            command: {
              type: "array",
              minItems: 2,
              maxItems: 16,
              items: boundedStringSchema,
            },
            environment: {
              type: "object",
              maxProperties: 16,
              additionalProperties: boundedStringSchema,
            },
          },
        },
      },
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
    credentialProvider: credentialProviderSchema,
    config: {
      type: "object",
      additionalProperties: false,
      required: ["renders", "visibility"],
      properties: {
        renders: { type: "array", maxItems: 64, items: configRenderSchema },
        visibility: { type: "array", maxItems: 64, items: configVisibilitySchema },
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
        statusProbe: statusProbeSchema,
        hookOperations: {
          type: "array",
          maxItems: 64,
          items: hookOperationSchema,
        },
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

/** Reject semantically inconsistent package-manager authority at the adapter boundary. */
export function validateHarnessMessagingBuildProfile(profile: HarnessMessagingBuildProfile): void {
  const declared = new Set(profile.packageManagers);
  const installers = profile.packageInstallers ?? {};
  for (const manager of ["node-package", "python-package"] as const) {
    const installer = installers[manager];
    if (declared.has(manager) !== (installer !== undefined)) {
      throw new HarnessAdapterSchemaError(
        `Installed harness messaging build profile must declare exactly one ${manager} installer`,
      );
    }
  }
  const nodeInstaller = installers["node-package"];
  const pythonInstaller = installers["python-package"];
  for (const [manager, installer, placeholder] of [
    ["node-package", nodeInstaller, "{{archive}}"],
    ["python-package", pythonInstaller, "{{packages}}"],
  ] as const) {
    if (!installer) continue;
    const count = installer.command.filter((argument) => argument === placeholder).length;
    if (
      count !== 1 ||
      installer.command.some((argument) => argument.includes("{{") && argument !== placeholder)
    ) {
      throw new HarnessAdapterSchemaError(
        `Installed harness messaging ${manager} installer must contain exactly one ${placeholder} argument`,
      );
    }
  }
  if (
    nodeInstaller?.packageVersionEnvironment !== undefined &&
    !INSTALLER_ENV_KEY.test(nodeInstaller.packageVersionEnvironment)
  ) {
    throw new HarnessAdapterSchemaError(
      "Installed harness messaging package version environment key is invalid",
    );
  }
  for (const [key, value] of Object.entries(pythonInstaller?.environment ?? {})) {
    if (
      !INSTALLER_ENV_KEY.test(key) ||
      value.length === 0 ||
      value.length > 1024 ||
      /[\r\n\0]/u.test(value) ||
      SECRET_LIKE_ENV_VALUE.test(value)
    ) {
      throw new HarnessAdapterSchemaError(
        "Installed harness messaging package installer environment is invalid",
      );
    }
  }
}

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
