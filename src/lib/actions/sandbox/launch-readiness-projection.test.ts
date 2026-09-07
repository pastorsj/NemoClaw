// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { loadAgent, type AgentDefinition } from "../../agent/defs";
import type { SandboxEntry } from "../../state/registry";
import { buildLaunchReadinessRegistryProjection, launchReadinessDigest } from "./launch-readiness";

function sandboxEntry(agent: string | null = "openclaw"): SandboxEntry {
  return {
    name: "alpha",
    openshellDriver: "docker",
    openshellVersion: "0.0.99",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    lifecycleGeneration: "generation-1",
    lifecycleLiveIdentityFingerprint: "b".repeat(64),
    agent,
    agentVersion: "1.0.0",
    nemoclawVersion: "2.0.0",
    imageTag: "example@sha256:immutable",
    provider: null,
    model: null,
    endpointUrl: null,
    credentialEnv: null,
    preferredInferenceApi: null,
    compatibleEndpointReasoning: null,
    compatibleEndpointReasoningEffort: null,
    nimContainer: null,
  };
}

function packageBackedEntry(agentName: string): SandboxEntry {
  return {
    ...sandboxEntry(agentName),
    harnessPackage: {
      kind: "agent-runtime",
      id: agentName,
      packageVersion: "1.0.0",
      contentDigest: "a".repeat(64),
    },
  };
}

function syntheticAgent(name: string): AgentDefinition {
  const base = loadAgent("openclaw");
  return {
    ...base,
    name,
    runtime: {
      ...base.runtime!,
      kind: "gateway",
      interactive_command: "future tui",
    },
  };
}

function servingProfile(): NonNullable<SandboxEntry["servingProfileProvenance"]> {
  return {
    schemaVersion: 1,
    catalogDigest: `sha256:${"d".repeat(64)}`,
    preset: {
      id: "local-gpu",
      digest: `sha256:${"e".repeat(64)}`,
      displayName: "Local GPU",
      supportState: "supported",
    },
    recipe: {
      id: "vllm-local",
      digest: `sha256:${"f".repeat(64)}`,
      backend: "vllm",
    },
    model: { id: "model-a", revision: "revision-a" },
    runtimeImage: "example.com/runtime@sha256:immutable",
    estimatedImageDownloadBytes: 1_000,
    estimatedModelDownloadBytes: 2_000,
  };
}

describe("launch readiness registry projection", () => {
  const sandbox = sandboxEntry();

  it("binds every host mount field without projecting the host source path (#8942)", () => {
    const agent = loadAgent("openclaw");
    const source = "/private/host/customer-project";
    const mounted: SandboxEntry = {
      ...sandbox,
      hostMounts: [
        {
          source,
          target: "/sandbox/project",
          readOnly: true,
          sourceIdentity: { device: "11", inode: "22" },
        },
      ],
    };
    const projection = buildLaunchReadinessRegistryProjection(mounted, agent) as {
      hostMounts: Array<Record<string, unknown>>;
    };
    expect(JSON.stringify(projection)).not.toContain(source);
    expect(projection.hostMounts).toEqual([
      {
        sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        target: "/sandbox/project",
        readOnly: true,
        sourceIdentity: { device: "11", inode: "22" },
      },
    ]);

    const original = launchReadinessDigest(projection);
    const mutations: SandboxEntry[] = [
      {
        ...mounted,
        hostMounts: [{ ...mounted.hostMounts![0]!, source: `${source}-changed` }],
      },
      {
        ...mounted,
        hostMounts: [{ ...mounted.hostMounts![0]!, target: "/sandbox/changed" }],
      },
      {
        ...mounted,
        hostMounts: [
          {
            ...mounted.hostMounts![0]!,
            sourceIdentity: { device: "12", inode: "22" },
          },
        ],
      },
      {
        ...mounted,
        hostMounts: [
          {
            ...mounted.hostMounts![0]!,
            sourceIdentity: { device: "11", inode: "23" },
          },
        ],
      },
    ];
    expect(
      mutations.every(
        (mutation) =>
          !Object.is(
            launchReadinessDigest(buildLaunchReadinessRegistryProjection(mutation, agent)),
            original,
          ),
      ),
    ).toBe(true);
    expect(() =>
      buildLaunchReadinessRegistryProjection(
        {
          ...mounted,
          hostMounts: [{ ...mounted.hostMounts![0]!, readOnly: false as true }],
        },
        agent,
      ),
    ).toThrow();
  });

  it("binds every semantic serving profile provenance field (#8942)", () => {
    const agent = loadAgent("openclaw");
    const originalProfile = servingProfile();
    const original = launchReadinessDigest(
      buildLaunchReadinessRegistryProjection(
        { ...sandbox, servingProfileProvenance: originalProfile },
        agent,
      ),
    );
    const mutations: NonNullable<SandboxEntry["servingProfileProvenance"]>[] = [
      { ...originalProfile, catalogDigest: `sha256:${"a".repeat(64)}` },
      { ...originalProfile, preset: { ...originalProfile.preset, id: "changed" } },
      {
        ...originalProfile,
        preset: { ...originalProfile.preset, digest: `sha256:${"a".repeat(64)}` },
      },
      { ...originalProfile, preset: { ...originalProfile.preset, displayName: "Changed" } },
      {
        ...originalProfile,
        preset: { ...originalProfile.preset, supportState: "experimental" },
      },
      { ...originalProfile, recipe: { ...originalProfile.recipe, id: "changed" } },
      {
        ...originalProfile,
        recipe: { ...originalProfile.recipe, digest: `sha256:${"a".repeat(64)}` },
      },
      { ...originalProfile, recipe: { ...originalProfile.recipe, backend: "changed" } },
      { ...originalProfile, model: { ...originalProfile.model, id: "changed" } },
      { ...originalProfile, model: { ...originalProfile.model, revision: "changed" } },
      { ...originalProfile, runtimeImage: "example.com/changed@sha256:immutable" },
      { ...originalProfile, estimatedImageDownloadBytes: 1_001 },
      { ...originalProfile, estimatedModelDownloadBytes: 2_001 },
    ];
    expect(
      mutations.every(
        (mutation) =>
          !Object.is(
            launchReadinessDigest(
              buildLaunchReadinessRegistryProjection(
                { ...sandbox, servingProfileProvenance: mutation },
                agent,
              ),
            ),
            original,
          ),
      ),
    ).toBe(true);
  });

  it("binds receipt-backed package state and ignores legacy harness encodings", () => {
    const agent = syntheticAgent("future-harness");
    const base: SandboxEntry = {
      ...packageBackedEntry("future-harness"),
      approvalMode: "disabled",
      providerAuthMethod: "api-key",
      toolGatewaySelections: ["future-tools"],
      dcodeAutoApprovalMode: "thread-opt-in",
      hermesAuthMethod: "oauth",
      hermesInferenceProvider: "legacy-hermes-provider",
      hermesToolGateways: ["legacy-tools"],
    };
    const digest = (value: SandboxEntry): string =>
      launchReadinessDigest(buildLaunchReadinessRegistryProjection(value, agent));

    expect(digest({ ...base, approvalMode: "thread-opt-in" })).not.toBe(digest(base));
    expect(digest({ ...base, providerAuthMethod: "oauth" })).not.toBe(digest(base));
    expect(digest({ ...base, toolGatewaySelections: ["other-tools"] })).not.toBe(digest(base));
    expect(
      digest({
        ...base,
        dcodeAutoApprovalMode: "disabled",
        hermesAuthMethod: "invalid-legacy-value" as "oauth",
        hermesInferenceProvider: "other-legacy-provider",
        hermesToolGateways: ["other-legacy-tools"],
      }),
    ).toBe(digest(base));
  });

  it("binds Dockerfile package startup authority without projecting the encoded profile", () => {
    const agent = syntheticAgent("future-harness");
    const encodedProfile = "opaque-package-profile";
    const startupProfileSha256 = "c".repeat(64);
    const packageStartupProfile = {
      encodedProfile,
      startupProfileSha256,
      credentialProxyReplayRequired: false,
    } as const;
    const base: SandboxEntry = {
      ...packageBackedEntry("future-harness"),
      workload: {
        schemaVersion: 1,
        kind: "legacy-dockerfile",
        reference: "nemoclaw-future-harness:local",
        packageStartupProfile,
        shared: false,
      },
    };
    const projection = buildLaunchReadinessRegistryProjection(base, agent);
    const serialized = JSON.stringify(projection);
    const digest = launchReadinessDigest(projection);

    expect(serialized).not.toContain(encodedProfile);
    expect(projection).toMatchObject({
      workloadIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(
      launchReadinessDigest(
        buildLaunchReadinessRegistryProjection(
          {
            ...base,
            workload: {
              ...base.workload!,
              packageStartupProfile: {
                ...packageStartupProfile,
                startupProfileSha256: "d".repeat(64),
              },
            } as SandboxEntry["workload"],
          },
          agent,
        ),
      ),
    ).not.toBe(digest);
  });

  it("excludes diagnostic timestamps, source paths, and GPU detail from the projection", () => {
    const agent = loadAgent("openclaw");
    const first: SandboxEntry = {
      ...sandbox,
      createdAt: "2026-01-01T00:00:00.000Z",
      sandboxGpuProof: {
        status: "verified",
        cudaVerified: true,
        label: "cuda",
        detail: "first diagnostic",
        at: "2026-01-01T00:00:00.000Z",
      },
    };
    const second: SandboxEntry = {
      ...first,
      createdAt: "2026-06-01T00:00:00.000Z",
      sandboxGpuProof: {
        ...first.sandboxGpuProof!,
        detail: "second diagnostic",
        at: "2026-06-01T00:00:00.000Z",
      },
    };
    expect(launchReadinessDigest(buildLaunchReadinessRegistryProjection(second, agent))).toBe(
      launchReadinessDigest(buildLaunchReadinessRegistryProjection(first, agent)),
    );
  });
});
