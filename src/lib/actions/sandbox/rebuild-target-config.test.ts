// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type { HarnessStartupSettings } from "@nvidia/nemoclaw-harness-contract";
import { describe, expect, it } from "vitest";

import { encodeManagedStartupDurableProfile } from "../../onboard/managed-startup/profile";
import type { ResolvedSandboxAgent } from "../../onboard/sandbox-agent";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import { resolveReceiptRebuildStartupSettings } from "./rebuild-target-config";

const PACKAGE_ID = "example-harness";
const PACKAGE_IDENTITY = {
  kind: "agent-runtime",
  id: PACKAGE_ID,
  packageVersion: "1.0.0",
  contentDigest: "a".repeat(64),
} as const;
const DESIRED_STATE: HarnessStartupSettings = {
  configuration: {
    webSearch: { enabled: true, provider: "tavily" },
    autoApprovalMode: "thread-opt-in",
  },
  inference: {
    routeProvider: "managed",
    upstreamProvider: "nvidia",
    model: "example/model",
    routedBaseUrl: "http://inference.local/v1",
    upstreamEndpointUrl: null,
    api: "openai-completions",
    primaryModelRef: null,
    compatibility: null,
    inputModalities: null,
  },
  proxy: {
    managedHost: "inference.local",
    managedPort: 80,
    hostHttpUrl: null,
    hostHttpsUrl: null,
    hostNoProxy: [],
  },
  dashboard: { mode: "disabled" },
  tools: { disclosure: "direct", enabledGateways: ["example-tools"] },
  messaging: { plan: null },
  tuning: {
    contextWindow: null,
    maxTokens: null,
    reasoning: null,
    reasoningEffort: null,
  },
  corporateCa: { bundleSha256: null },
};

function receiptBackedEntry(): RebuildSandboxEntry {
  const encodedProfile = encodeManagedStartupDurableProfile({
    schemaVersion: 1,
    profileKind: "package",
    agent: PACKAGE_ID,
    harnessPackage: PACKAGE_IDENTITY,
    desiredState: DESIRED_STATE,
    packageConfig: {},
    corporateCa: { bundleSha256: null },
  });
  return {
    name: "example",
    harnessPackage: PACKAGE_IDENTITY,
    workload: {
      schemaVersion: 1,
      kind: "managed-image",
      reference: `registry.example.com/nemoclaw/example@sha256:${"b".repeat(64)}`,
      platform: "linux/amd64",
      release: "v1.0.0",
      sourceRevision: "c".repeat(40),
      sourceCohort: "ghrun-1-1",
      capabilityContractVersion: 1,
      startupProfileContractVersion: 1,
      encodedProfile,
      startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
      credentialProxyReplayRequired: false,
      shared: true,
    },
  } as RebuildSandboxEntry;
}

describe("receipt-backed rebuild target configuration", () => {
  it("reads an unknown package's typed startup settings without a package-ID branch", () => {
    const authority = {
      recordedAgent: PACKAGE_ID,
      effectiveAgentId: PACKAGE_ID,
      harnessPackage: PACKAGE_IDENTITY,
      harnessPackageMigration: null,
    } as unknown as ResolvedSandboxAgent;

    expect(resolveReceiptRebuildStartupSettings(receiptBackedEntry(), authority)).toEqual(
      DESIRED_STATE,
    );
  });

  it("refuses a receipt whose workload profile is not bound to the exact package", () => {
    const authority = {
      recordedAgent: "other-harness",
      effectiveAgentId: "other-harness",
      harnessPackage: { ...PACKAGE_IDENTITY, id: "other-harness" },
      harnessPackageMigration: null,
    } as unknown as ResolvedSandboxAgent;

    expect(() => resolveReceiptRebuildStartupSettings(receiptBackedEntry(), authority)).toThrow(
      /exact managed startup profile/u,
    );
  });
});
