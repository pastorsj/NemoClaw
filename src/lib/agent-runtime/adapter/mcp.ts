// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AnySchemaObject } from "ajv";
import type {
  HarnessMcpCapabilityProbe,
  HarnessMcpCapabilityRequest,
  HarnessMcpInspectionRequest,
  HarnessMcpRegistrationPlan,
  HarnessMcpRegistrationRequest,
  HarnessMcpRemovalPlan,
  HarnessMcpRemovalRequest,
  HarnessMcpRuntimeIntentRequest,
  HarnessMcpRuntimePlan,
  HarnessMcpRuntimeRequest,
  HarnessMcpShellCommandPlan,
  HarnessMcpSnapshotRestorePlan,
  HarnessMcpSnapshotRestoreRequest,
} from "@nvidia/nemoclaw-harness-contract";

import { defineHarnessAdapterContract, defineHarnessAdapterOperation } from "./contract";

const MCP_ADAPTER_SOURCE_MAX_BYTES = 512 * 1024;
const MCP_ADAPTER_REQUEST_MAX_BYTES = 1024 * 1024;
const MCP_ADAPTER_RESULT_MAX_BYTES = 1024 * 1024;

export type {
  HarnessMcpAdapterCommand,
  HarnessMcpAdapterCommandPlan,
  HarnessMcpAdapterIdentifier,
  HarnessMcpAdapterEntry,
  HarnessMcpArgvCommandPlan,
  HarnessMcpCapabilityProbe,
  HarnessMcpCapabilityRequest,
  HarnessMcpCredentialConvergence,
  HarnessMcpExecutionPlan,
  HarnessMcpExecutionSuccess,
  HarnessMcpInspectionRequest,
  HarnessMcpRegistrationPlan,
  HarnessMcpRegistrationRequest,
  HarnessMcpRegistrationVerification,
  HarnessMcpRemovalOutcome,
  HarnessMcpRemovalPlan,
  HarnessMcpRemovalRequest,
  HarnessMcpRuntimeIntentRequest,
  HarnessMcpRuntimePlan,
  HarnessMcpRuntimeRequest,
  HarnessMcpShellCommandPlan,
  HarnessMcpSnapshotApplicability,
  HarnessMcpSnapshotRestorePlan,
  HarnessMcpSnapshotRestoreRequest,
} from "@nvidia/nemoclaw-harness-contract";

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

const configDirectorySchema = Object.freeze({
  anyOf: [
    { type: "null" },
    { type: "string", minLength: 1, maxLength: 4096, pattern: "^/[^\\u0000]*$" },
  ],
});

const mcpRegistrationRequestSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["entry", "managedEntries", "replaceExisting", "teardownRollback", "configDirectory"],
  properties: {
    entry: mcpEntrySchema,
    managedEntries: {
      type: "array",
      maxItems: 512,
      items: mcpEntrySchema,
    },
    replaceExisting: { type: "boolean" },
    teardownRollback: { type: "boolean" },
    configDirectory: configDirectorySchema,
  },
});

const mcpRemovalRequestSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["entry", "force", "adaptiveTeardown", "configDirectory"],
  properties: {
    entry: mcpEntrySchema,
    force: { type: "boolean" },
    adaptiveTeardown: { type: "boolean" },
    configDirectory: configDirectorySchema,
  },
});

const mcpInspectionRequestSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["entry", "failOnMismatch", "configDirectory"],
  properties: {
    entry: mcpEntrySchema,
    failOnMismatch: { type: "boolean" },
    configDirectory: configDirectorySchema,
  },
});

const mcpCapabilityRequestSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["sandboxName"],
  properties: {
    sandboxName: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      pattern: "^[^\\u0000\\r\\n]+$",
    },
  },
});

const mcpRuntimeRequestSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["command"],
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
  },
});

const mcpRuntimeIntentRequestSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["entries", "managedServerNames"],
  properties: {
    entries: {
      type: "array",
      maxItems: 512,
      items: mcpEntrySchema,
    },
    managedServerNames: {
      type: "array",
      maxItems: 512,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 256 },
    },
  },
});

const mcpSnapshotRestoreRequestSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["sandboxName", "entries"],
  properties: {
    sandboxName: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      pattern: "^[^\\u0000\\r\\n]+$",
    },
    entries: {
      type: "array",
      maxItems: 512,
      items: mcpEntrySchema,
    },
  },
});

const mcpShellScriptSchema: AnySchemaObject = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: MCP_ADAPTER_RESULT_MAX_BYTES,
  pattern: "^[^\\u0000]+$",
});

const mcpArgumentVectorSchema: AnySchemaObject = Object.freeze({
  type: "array",
  minItems: 1,
  maxItems: 512,
  items: {
    type: "string",
    minLength: 1,
    maxLength: 65_536,
    pattern: "^[^\\u0000]+$",
  },
});

const mcpArgvCommandPlanSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["kind", "argv"],
  properties: {
    kind: { const: "argv" },
    argv: mcpArgumentVectorSchema,
  },
});

const mcpShellCommandPlanSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["kind", "script", "shellTrust"],
  properties: {
    kind: { const: "shell" },
    script: mcpShellScriptSchema,
    shellTrust: { const: "package-authored-code" },
  },
});

const mcpCommandPlanSchema: AnySchemaObject = Object.freeze({
  oneOf: [mcpArgvCommandPlanSchema, mcpShellCommandPlanSchema],
});

const mcpRuntimePlanSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["command", "environmentVariablesToRemove"],
  properties: {
    command: mcpArgumentVectorSchema,
    environmentVariablesToRemove: {
      type: "array",
      maxItems: 128,
      uniqueItems: true,
      items: {
        type: "string",
        minLength: 1,
        maxLength: 128,
        pattern: "^[A-Z_][A-Z0-9_]*$",
      },
    },
  },
});

const failureMessageSchema: AnySchemaObject = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 8192,
});

const mcpExecutionSuccessSchema: AnySchemaObject = Object.freeze({
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: { kind: { const: "exit-zero" } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "requireReload", "invalidResponseMessage", "reloadRequiredMessage"],
      properties: {
        kind: { const: "lifecycle-json" },
        requireReload: { type: "boolean" },
        invalidResponseMessage: failureMessageSchema,
        reloadRequiredMessage: failureMessageSchema,
      },
    },
  ],
});

const mcpExecutionPlanSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["command", "timeoutSeconds", "success", "failureMessage"],
  properties: {
    command: mcpCommandPlanSchema,
    timeoutSeconds: { type: "integer", minimum: 1, maximum: 3600 },
    success: mcpExecutionSuccessSchema,
    failureMessage: failureMessageSchema,
  },
});

const mcpRegistrationPlanSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["execution", "verification", "credentialConvergence"],
  properties: {
    execution: mcpExecutionPlanSchema,
    verification: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "failureMessage"],
          properties: {
            kind: { const: "inspection" },
            failureMessage: failureMessageSchema,
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "failureMessage"],
          properties: {
            kind: { const: "rollback-restored" },
            failureMessage: failureMessageSchema,
          },
        },
      ],
    },
    credentialConvergence: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind"],
          properties: { kind: { const: "none" } },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "unavailableMessage", "unstableMessage"],
          properties: {
            kind: { const: "after-runtime-reload" },
            unavailableMessage: failureMessageSchema,
            unstableMessage: failureMessageSchema,
          },
        },
      ],
    },
  },
});

const mcpRemovalPlanSchema: AnySchemaObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["execution", "outcome"],
  properties: {
    execution: mcpExecutionPlanSchema,
    outcome: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind"],
          properties: { kind: { const: "removed" } },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind"],
          properties: { kind: { const: "stdout-removal-outcome" } },
        },
      ],
    },
  },
});

const mcpCapabilityProbeSchema: AnySchemaObject = Object.freeze({
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
      required: ["kind", "command", "success", "timeoutSeconds", "failureMessage"],
      properties: {
        kind: { const: "command" },
        command: mcpCommandPlanSchema,
        success: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["kind"],
              properties: { kind: { const: "exit-zero" } },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["kind", "value"],
              properties: {
                kind: { const: "stdout-trimmed-equals" },
                value: { type: "string", minLength: 1, maxLength: 65_536 },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["kind"],
              properties: { kind: { const: "last-json-line-ok" } },
            },
          ],
        },
        timeoutSeconds: { type: "integer", minimum: 1, maximum: 3600 },
        failureMessage: { type: "string", minLength: 1, maxLength: 8192 },
        retry: {
          type: "object",
          additionalProperties: false,
          required: ["outputExact", "initialAttempts", "intervalMilliseconds"],
          properties: {
            outputExact: { type: "string", minLength: 1, maxLength: 8192 },
            initialAttempts: { type: "integer", minimum: 1, maximum: 10 },
            intervalMilliseconds: { type: "integer", minimum: 1, maximum: 60_000 },
            recovery: {
              type: "object",
              additionalProperties: false,
              required: ["kind", "timeoutSeconds", "postRecoveryAttempts"],
              properties: {
                kind: { const: "agent-gateway" },
                timeoutSeconds: { type: "integer", minimum: 1, maximum: 900 },
                postRecoveryAttempts: { type: "integer", minimum: 1, maximum: 600 },
              },
            },
          },
        },
      },
    },
  ],
});

const mcpSnapshotRestorePlanSchema: AnySchemaObject = Object.freeze({
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
      required: ["kind", "applicability", "capability", "execution", "verificationFailureMessage"],
      properties: {
        kind: { const: "conditional-repair" },
        applicability: {
          type: "object",
          additionalProperties: false,
          required: [
            "command",
            "timeoutSeconds",
            "repairWhenOutput",
            "skipWhenOutput",
            "failureMessage",
          ],
          properties: {
            command: mcpCommandPlanSchema,
            timeoutSeconds: { type: "integer", minimum: 1, maximum: 3600 },
            repairWhenOutput: { type: "string", minLength: 1, maxLength: 65_536 },
            skipWhenOutput: { type: "string", minLength: 1, maxLength: 65_536 },
            failureMessage: failureMessageSchema,
          },
        },
        capability: mcpCapabilityProbeSchema,
        execution: {
          type: "object",
          additionalProperties: false,
          required: ["command", "timeoutSeconds", "success", "failureMessage"],
          properties: {
            command: mcpCommandPlanSchema,
            timeoutSeconds: { type: "integer", minimum: 1, maximum: 3600 },
            success: {
              type: "object",
              additionalProperties: false,
              required: ["kind"],
              properties: { kind: { const: "exit-zero" } },
            },
            failureMessage: failureMessageSchema,
          },
        },
        verificationFailureMessage: failureMessageSchema,
      },
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
        adapter: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
        },
      },
    },
  },
});

/** The first fixed capability implemented through the generic harness adapter boundary. */
export const HARNESS_MCP_ADAPTER_CONTRACT = defineHarnessAdapterContract({
  displayName: "MCP adapter",
  modulePath: "host/mcp-adapter.cts",
  manifestSchema: mcpCapabilitySchema,
  sourceMaxBytes: MCP_ADAPTER_SOURCE_MAX_BYTES,
  requestMaxBytes: MCP_ADAPTER_REQUEST_MAX_BYTES,
  resultMaxBytes: MCP_ADAPTER_RESULT_MAX_BYTES,
  operations: {
    register: defineHarnessAdapterOperation<
      HarnessMcpRegistrationRequest,
      HarnessMcpRegistrationPlan
    >({
      exportName: "buildMcpRegistrationPlan",
      requestSchema: mcpRegistrationRequestSchema,
      resultSchema: mcpRegistrationPlanSchema,
      resultDescription: "registration plan",
    }),
    remove: defineHarnessAdapterOperation<HarnessMcpRemovalRequest, HarnessMcpRemovalPlan>({
      exportName: "buildMcpRemovalPlan",
      requestSchema: mcpRemovalRequestSchema,
      resultSchema: mcpRemovalPlanSchema,
      resultDescription: "removal plan",
    }),
    inspect: defineHarnessAdapterOperation<HarnessMcpInspectionRequest, HarnessMcpShellCommandPlan>(
      {
        exportName: "buildMcpInspectionCommand",
        requestSchema: mcpInspectionRequestSchema,
        resultSchema: mcpShellCommandPlanSchema,
        resultDescription: "inspection command",
      },
    ),
    mutationCapability: defineHarnessAdapterOperation<
      HarnessMcpCapabilityRequest,
      HarnessMcpCapabilityProbe
    >({
      exportName: "describeMcpMutationCapability",
      requestSchema: mcpCapabilityRequestSchema,
      resultSchema: mcpCapabilityProbeSchema,
      resultDescription: "mutation capability probe",
    }),
    teardownCapability: defineHarnessAdapterOperation<
      HarnessMcpCapabilityRequest,
      HarnessMcpCapabilityProbe
    >({
      exportName: "describeMcpTeardownCapability",
      requestSchema: mcpCapabilityRequestSchema,
      resultSchema: mcpCapabilityProbeSchema,
      resultDescription: "teardown capability probe",
    }),
    verifyRuntimeIntent: defineHarnessAdapterOperation<
      HarnessMcpRuntimeIntentRequest,
      HarnessMcpCapabilityProbe
    >({
      exportName: "describeMcpRuntimeIntentVerification",
      requestSchema: mcpRuntimeIntentRequestSchema,
      resultSchema: mcpCapabilityProbeSchema,
      resultDescription: "runtime intent verification",
    }),
    runtime: defineHarnessAdapterOperation<HarnessMcpRuntimeRequest, HarnessMcpRuntimePlan>({
      exportName: "buildMcpRuntimePlan",
      requestSchema: mcpRuntimeRequestSchema,
      resultSchema: mcpRuntimePlanSchema,
      resultDescription: "runtime plan",
    }),
    snapshotRestore: defineHarnessAdapterOperation<
      HarnessMcpSnapshotRestoreRequest,
      HarnessMcpSnapshotRestorePlan
    >({
      exportName: "buildMcpSnapshotRestorePlan",
      requestSchema: mcpSnapshotRestoreRequestSchema,
      resultSchema: mcpSnapshotRestorePlanSchema,
      resultDescription: "snapshot restore plan",
    }),
  },
});
