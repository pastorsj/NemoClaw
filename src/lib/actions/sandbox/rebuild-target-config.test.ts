// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type { HarnessStartupSettings } from "@nvidia/nemoclaw-harness-contract";
import { describe, expect, it, vi } from "vitest";

import { createHarnessPackageFixture } from "../../../../test/helpers/harness-packages";
import type { HarnessPackageIdentity } from "../../agent-runtime/package/types";
import { encodeManagedStartupDurableProfile } from "../../onboard/managed-startup/profile";
import { resolveSandboxAgent, type ResolvedSandboxAgent } from "../../onboard/sandbox-agent";
import * as onboardSession from "../../state/onboard-session";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import {
  prepareRebuildTargetConfig,
  resolveReceiptRebuildDurableConfig,
  resolveReceiptRebuildStartupSettings,
  resolveRebuildTargetCredentialEnv,
} from "./rebuild-target-config";

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

function receiptBackedEntry(
  packageIdentity: HarnessPackageIdentity = PACKAGE_IDENTITY,
): RebuildSandboxEntry {
  const encodedProfile = encodeManagedStartupDurableProfile({
    schemaVersion: 1,
    profileKind: "package",
    agent: packageIdentity.id,
    harnessPackage: packageIdentity,
    desiredState: DESIRED_STATE,
    packageConfig: {},
    corporateCa: { bundleSha256: null },
  });
  return {
    name: "example",
    harnessPackage: packageIdentity,
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

function receiptBackedDockerfileEntry(
  packageIdentity: HarnessPackageIdentity = PACKAGE_IDENTITY,
): RebuildSandboxEntry {
  const entry = receiptBackedEntry(packageIdentity);
  const managedWorkload = entry.workload as Extract<
    NonNullable<RebuildSandboxEntry["workload"]>,
    { readonly kind: "managed-image" }
  >;
  return {
    ...entry,
    imageTag: "nemoclaw-example-harness:local",
    workload: {
      schemaVersion: 1,
      kind: "legacy-dockerfile",
      reference: "nemoclaw-example-harness:local",
      packageStartupProfile: {
        encodedProfile: managedWorkload.encodedProfile,
        startupProfileSha256: managedWorkload.startupProfileSha256,
        credentialProxyReplayRequired: managedWorkload.credentialProxyReplayRequired,
      },
      shared: false,
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

  it("reads a Dockerfile package's durable startup settings without an onboard session", () => {
    const authority = {
      recordedAgent: PACKAGE_ID,
      effectiveAgentId: PACKAGE_ID,
      harnessPackage: PACKAGE_IDENTITY,
      harnessPackageMigration: null,
    } as unknown as ResolvedSandboxAgent;

    expect(resolveReceiptRebuildStartupSettings(receiptBackedDockerfileEntry(), authority)).toEqual(
      DESIRED_STATE,
    );
  });

  it("keeps a Dockerfile startup profile bound to the sandbox's pinned package digest", () => {
    const upgradedAuthority = {
      recordedAgent: PACKAGE_ID,
      effectiveAgentId: PACKAGE_ID,
      harnessPackage: {
        ...PACKAGE_IDENTITY,
        packageVersion: "1.1.0",
        contentDigest: "d".repeat(64),
      },
      harnessPackageMigration: null,
    } as unknown as ResolvedSandboxAgent;

    expect(() =>
      resolveReceiptRebuildStartupSettings(receiptBackedDockerfileEntry(), upgradedAuthority),
    ).toThrow(/exact package startup profile/u);
  });

  it("resolves a Dockerfile rebuild from the pinned package after the active pointer advances", () => {
    const fixture = createHarnessPackageFixture();
    try {
      const pinned = fixture.install("future-harness");
      const active = fixture.advanceActivePointer("future-harness", "1.1.0");
      const entry = {
        ...receiptBackedDockerfileEntry(pinned.identity),
        agent: pinned.identity.id,
        harnessPackage: pinned.identity,
        provider: "ollama",
        model: "example/model",
        endpointUrl: null,
        credentialEnv: null,
        preferredInferenceApi: "openai-completions",
        compatibleEndpointReasoning: null,
        compatibleEndpointReasoningEffort: null,
        nimContainer: null,
      };
      const authority = resolveSandboxAgent(entry, { storeRoot: fixture.storeRoot });
      vi.spyOn(onboardSession, "loadSession").mockReturnValue(null);
      const bail = vi.fn((message: string): never => {
        throw new Error(message);
      });
      const target = prepareRebuildTargetConfig("example", entry, authority, vi.fn(), bail);

      expect(active.identity.contentDigest).not.toBe(pinned.identity.contentDigest);
      expect(authority.harnessPackage).toEqual(pinned.identity);
      expect(target).toMatchObject({
        agentAuthority: { harnessPackage: pinned.identity },
        sessionSnapshot: null,
        sessionMatchesSandbox: false,
        durableConfig: {
          toolDisclosure: "direct",
          webSearchConfig: { fetchEnabled: true, provider: "tavily" },
        },
      });
      expect(bail).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      fixture.cleanup();
    }
  });

  it("refuses a receipt whose workload profile is not bound to the exact package", () => {
    const authority = {
      recordedAgent: "other-harness",
      effectiveAgentId: "other-harness",
      harnessPackage: { ...PACKAGE_IDENTITY, id: "other-harness" },
      harnessPackageMigration: null,
    } as unknown as ResolvedSandboxAgent;

    expect(() => resolveReceiptRebuildStartupSettings(receiptBackedEntry(), authority)).toThrow(
      /exact package startup profile/u,
    );
  });

  it("refuses a receipt-backed rebuild without an exact startup profile", () => {
    const authority = {
      recordedAgent: PACKAGE_ID,
      effectiveAgentId: PACKAGE_ID,
      harnessPackage: PACKAGE_IDENTITY,
      harnessPackageMigration: null,
    } as unknown as ResolvedSandboxAgent;
    const entry = { ...receiptBackedEntry(), workload: undefined };

    expect(() => resolveReceiptRebuildStartupSettings(entry, authority)).toThrow(
      /no exact package startup profile/u,
    );
  });

  it("derives an unknown package's durable rebuild state without legacy harness fields", () => {
    const durable = resolveReceiptRebuildDurableConfig(
      {
        ...receiptBackedEntry(),
        agent: PACKAGE_ID,
        approvalMode: "disabled",
        providerAuthMethod: "api-key",
        hermesAuthMethod: "oauth",
        hermesToolGateways: ["legacy-tools"],
        dcodeAutoApprovalMode: "disabled",
      },
      DESIRED_STATE,
    );

    expect(durable).toMatchObject({
      dcodeAutoApprovalMode: "thread-opt-in",
      dcodeAutoApprovalModeError: null,
      hermesAuthMethod: null,
      hermesAuthMethodError: null,
      toolDisclosure: "direct",
      webSearchConfig: { fetchEnabled: true, provider: "tavily" },
    });
  });

  it("does not require legacy Hermes auth state for a receipt-backed Hermes rebuild", () => {
    const durable = resolveReceiptRebuildDurableConfig(
      {
        ...receiptBackedEntry(),
        agent: "hermes",
        harnessPackage: { ...PACKAGE_IDENTITY, id: "hermes" },
        provider: "hermes-provider",
        credentialEnv: "PACKAGE_PROVIDER_TOKEN",
        providerAuthMethod: "api-key",
        hermesAuthMethod: undefined,
      },
      DESIRED_STATE,
    );

    expect(durable.hermesAuthMethodError).toBeNull();
    expect(durable.hermesAuthMethod).toBeNull();
    expect(
      resolveRebuildTargetCredentialEnv(
        { provider: "hermes-provider", credentialEnv: "PACKAGE_PROVIDER_TOKEN" },
        durable,
        true,
      ),
    ).toBe("PACKAGE_PROVIDER_TOKEN");
  });
});
