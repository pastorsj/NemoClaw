// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MANAGED_STARTUP_E2E_CORPORATE_CA_PEM,
  managedStartupE2eProfile,
} from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import type { SandboxEntry } from "../state/registry/types";
import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_CONTRACT_VERSION,
  MANAGED_IMAGE_REPOSITORIES,
  MANAGED_IMAGE_SOURCE_REPOSITORY,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
  qualifiedManagedImageDeclaration,
  type ManagedImageContractV1,
  type ManagedImageAgent,
  type ManagedImagePlatform,
  type PackageManagedImageContract,
  type ShippedManagedImageAgent,
} from "./managed-image/contract";
import type { ResolvedSandboxAgent } from "./sandbox-agent";
import type {
  BuiltManagedStartupOnboardProfile,
  ManagedStartupOnboardProfileInput,
} from "./managed-startup/onboard-profile";
import { managedStartupSettingsFromProfile } from "./managed-startup/package-profile";
import {
  decodeManagedStartupProfile,
  encodeManagedStartupDurableProfile,
  encodeManagedStartupProfile,
  isManagedStartupPackageProfile,
  type ManagedStartupProfile,
} from "./managed-startup/profile";
import { managedWorkloadAuthorityDependencies } from "./workload/authority";
import type { RuntimeProviderBundle } from "./runtime-provider/contract";
import {
  buildManagedWorkloadRebuildReceipt,
  type ManagedWorkloadRebuildHandoff,
  type ManagedWorkloadReceipt,
  type PackageManagedWorkloadRebuildCatalogHandoff,
  managedWorkloadRebuildDependencies,
  managedWorkloadRebuildHandoffMatchesEntry,
  managedWorkloadRebuildProfileEnvironment,
  prepareManagedWorkloadRebuildHandoff,
  prepareSandboxWorkloadSourceFromRebuildHandoff,
  stageManagedPackageWorkloadRebuildProfile,
  stageManagedWorkloadRebuildProfile,
} from "./workload/rebuild";
import type { SandboxWorkloadRuntimeCapabilities } from "./workload/source";
import type { PreparedSandboxWorkloadSource } from "./workload/preparation";

const AGENTS = ["openclaw", "hermes", "langchain-deepagents-code"] as const;
const ORIGINAL_PREPARE = managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource;
const ORIGINAL_STARTUP_ADAPTER =
  managedWorkloadRebuildDependencies.loadHarnessStartupProfileAdapterHostModule;
const ORIGINAL_PACKAGE_RESOLVER =
  managedWorkloadAuthorityDependencies.resolvePackageBackedSandboxAgent;
const FUTURE_PACKAGE = {
  kind: "agent-runtime",
  id: "future-harness",
  packageVersion: "1.2.3",
  contentDigest: "9".repeat(64),
} as const;
const FUTURE_MANAGED_IMAGE = {
  repository: "registry.example/team/future-harness",
  architectures: ["linux/amd64"],
  runtime_identity: { uid: 1234, gid: 1234, workdir: "/sandbox" },
} as const;
type RebuildProfileInput = Omit<
  ManagedStartupOnboardProfileInput,
  "agentName" | "environment" | "corporateCa"
>;

function rebuildProfileInput(agent: ManagedImageAgent): RebuildProfileInput {
  const common = {
    chatUiUrl: "http://127.0.0.1:18789",
    effectiveDashboardPort: 18_789,
    dashboardBindAddress: undefined,
    wslExposure: false,
    webSearch: null,
    toolDisclosure: "progressive" as const,
    hermesToolGateways: [],
    messagingPlan: null,
    dcodeAutoApprovalMode: "disabled" as const,
    observabilityEnabled: false,
  };
  const profiles = {
    openclaw: {
      ...common,
      inference: {
        routeProvider: "openai",
        upstreamProvider: "openai-api",
        model: "gpt-5.4",
        routedBaseUrl: "https://inference.local/v1",
        upstreamEndpointUrl: null,
        api: "openai-responses",
        primaryModelRef: "openai/gpt-5.4",
        compatibility: {},
      },
      manageDashboard: true,
      hermesDashboardState: { config: null, enabled: false },
    },
    hermes: {
      ...common,
      inference: {
        routeProvider: "inference",
        upstreamProvider: "hermes-provider",
        model: "moonshotai/kimi-k2.6",
        routedBaseUrl: "https://inference.local/v1",
        upstreamEndpointUrl: null,
        api: "openai-completions",
        primaryModelRef: null,
        compatibility: null,
      },
      manageDashboard: true,
      hermesDashboardState: { config: null, enabled: false },
    },
    "langchain-deepagents-code": {
      ...common,
      inference: {
        routeProvider: "inference",
        upstreamProvider: "openrouter",
        model: "openai/gpt-5.4",
        routedBaseUrl: "https://inference.local/v1",
        upstreamEndpointUrl: "https://openrouter.ai/api/v1",
        api: "openai-completions",
        primaryModelRef: null,
        compatibility: null,
      },
      chatUiUrl: "",
      effectiveDashboardPort: 0,
      manageDashboard: false,
      hermesDashboardState: { config: null, enabled: false },
    },
    pi: {
      ...common,
      inference: {
        routeProvider: "inference",
        upstreamProvider: "nvidia",
        model: "nvidia/nemotron-new",
        routedBaseUrl: "https://inference.local/v1",
        upstreamEndpointUrl: null,
        api: "openai-completions",
        primaryModelRef: null,
        compatibility: null,
      },
      chatUiUrl: "",
      effectiveDashboardPort: 0,
      manageDashboard: false,
      hermesDashboardState: { config: null, enabled: false },
    },
  } as const satisfies Record<ManagedImageAgent, RebuildProfileInput>;
  return profiles[agent];
}

function managedContract(
  agent: ShippedManagedImageAgent,
  generation: "old" | "new",
  platform: ManagedImagePlatform = "linux/amd64",
): ManagedImageContractV1 {
  const image = MANAGED_IMAGE_REPOSITORIES[agent];
  const digit = generation === "old" ? "a" : "b";
  const digest = `sha256:${digit.repeat(64)}` as const;
  return {
    contractVersion: MANAGED_IMAGE_CONTRACT_VERSION,
    agent,
    platform,
    image,
    digest,
    reference: `${image}@${digest}`,
    source: {
      repository: MANAGED_IMAGE_SOURCE_REPOSITORY,
      revision: digit.repeat(40),
      release: generation === "old" ? "v0.0.99" : "v0.0.100",
      cohort: generation === "old" ? "ghrun-100-1" : "ghrun-200-2",
    },
    startupProfileContractVersion: MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    capabilityContractVersion: MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  };
}

function profileTransport(agent: ShippedManagedImageAgent): BuiltManagedStartupOnboardProfile {
  const profile = managedStartupE2eProfile(agent);
  const encodedProfile = encodeManagedStartupProfile(profile);
  return {
    profile,
    encodedProfile: encodedProfile as BuiltManagedStartupOnboardProfile["encodedProfile"],
    startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
    credentialProxyReplayRequired: false,
    dashboardRemoteBindPrepared: false,
  };
}

function receipt(
  agent: ShippedManagedImageAgent,
  generation: "old" | "new",
  platform: ManagedImagePlatform = "linux/amd64",
): ManagedWorkloadReceipt {
  const image = managedContract(agent, generation, platform);
  const transport = profileTransport(agent);
  return {
    schemaVersion: 1,
    kind: "managed-image",
    reference: image.reference,
    platform,
    release: image.source.release,
    sourceRevision: image.source.revision,
    sourceCohort: image.source.cohort,
    capabilityContractVersion: image.capabilityContractVersion,
    startupProfileContractVersion: image.startupProfileContractVersion,
    encodedProfile: transport.encodedProfile,
    startupProfileSha256: transport.startupProfileSha256,
    credentialProxyReplayRequired: false,
    shared: true,
  };
}

function entry(
  agent: ShippedManagedImageAgent,
  platform: ManagedImagePlatform = "linux/amd64",
): SandboxEntry {
  const workload = receipt(agent, "old", platform);
  return {
    name: `rebuild-${agent}`,
    agent,
    openshellDriver: "mxc",
    fromDockerfile: null,
    imageTag: workload.reference,
    workload,
  };
}

function futureEntry(generation: "old" | "new" = "old"): SandboxEntry {
  const digit = generation === "old" ? "7" : "8";
  const encodedProfile = encodeManagedStartupDurableProfile({
    schemaVersion: 1,
    profileKind: "package",
    agent: FUTURE_PACKAGE.id,
    harnessPackage: FUTURE_PACKAGE,
    desiredState: futureDesiredState(),
    packageConfig: { settings: { mode: "future" } },
    corporateCa: { bundleSha256: null },
  });
  const workload: ManagedWorkloadReceipt = {
    schemaVersion: 1,
    kind: "managed-image",
    reference: `${FUTURE_MANAGED_IMAGE.repository}@sha256:${digit.repeat(64)}`,
    platform: "linux/amd64",
    release: generation === "old" ? "v0.0.99" : "v0.0.100",
    sourceRevision: digit.repeat(40),
    sourceCohort: generation === "old" ? "ghrun-100-1" : "ghrun-200-2",
    capabilityContractVersion: 1,
    startupProfileContractVersion: 1,
    encodedProfile,
    startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
    credentialProxyReplayRequired: false,
    shared: true,
  };
  return {
    name: "rebuild-future-harness",
    agent: FUTURE_PACKAGE.id,
    harnessPackage: FUTURE_PACKAGE,
    openshellDriver: "mxc",
    fromDockerfile: null,
    imageTag: workload.reference,
    workload,
    dashboardRemoteBindPrepared: true,
  };
}

function futureDesiredState(changed = false) {
  const settings = managedStartupSettingsFromProfile(managedStartupE2eProfile("pi", changed));
  return {
    ...settings,
    configuration: { agent: FUTURE_PACKAGE.id },
    dashboard: { agent: FUTURE_PACKAGE.id, mode: "disabled" as const },
  };
}

function futureContract(generation: "old" | "new"): PackageManagedImageContract<"future-harness"> {
  const row = futureEntry(generation);
  const receipt = row.workload as ManagedWorkloadReceipt;
  const digest = receipt.reference.slice(receipt.reference.indexOf("@") + 1) as `sha256:${string}`;
  return {
    contractVersion: 1 as const,
    agent: FUTURE_PACKAGE.id,
    harnessPackage: FUTURE_PACKAGE,
    platform: "linux/amd64" as const,
    image: FUTURE_MANAGED_IMAGE.repository,
    digest,
    reference: receipt.reference as `${string}@sha256:${string}`,
    source: {
      repository: MANAGED_IMAGE_SOURCE_REPOSITORY,
      revision: receipt.sourceRevision,
      release: receipt.release,
      cohort: receipt.sourceCohort as `ghrun-${number}-${number}`,
    },
    startupProfileContractVersion: 1 as const,
    capabilityContractVersion: 1 as const,
  };
}

function resolveFuturePackage() {
  managedWorkloadAuthorityDependencies.resolvePackageBackedSandboxAgent = vi.fn((row) => {
    assert.equal(
      row.harnessPackage?.contentDigest,
      FUTURE_PACKAGE.contentDigest,
      "package receipt drifted",
    );
    return {
      recordedAgent: FUTURE_PACKAGE.id,
      effectiveAgentId: FUTURE_PACKAGE.id,
      definition: {
        name: FUTURE_PACKAGE.id,
        packageRoot: "/installed/future-harness",
        managedImage: FUTURE_MANAGED_IMAGE,
      },
      harnessPackage: FUTURE_PACKAGE,
      harnessPackageMigration: null,
    } as unknown as ResolvedSandboxAgent;
  });
}

function runtime(
  providerId = "mxc",
  platform: ManagedImagePlatform = "linux/amd64",
): SandboxWorkloadRuntimeCapabilities {
  return {
    driverName: providerId,
    managedImageSelectionPolicy: "require-managed",
    legacyDockerfileBuilds: false,
    managedImages: {
      exactDigestReferences: true,
      platforms: [platform],
      startupProfileContractVersions: [1],
      capabilityContractVersions: [1],
    },
  };
}

function provider(
  providerId = "mxc",
  options: { readonly acceptsReceipt?: boolean; readonly authorizesRebuild?: boolean } = {},
): RuntimeProviderBundle {
  return {
    identity: { contractVersion: 1, id: providerId, displayName: providerId },
    workload: {
      providerId,
      supported: true,
      profile: {
        support: {
          exactDigestReferences: true,
          platforms: ["linux/amd64", "linux/arm64"],
          startupProfileContractVersions: [1],
          capabilityContractVersions: [1],
        },
        hostArchitectures: ["amd64", "arm64"],
        managedImageSelectionPolicy: "require-managed",
        legacyDockerfileBuilds: false,
      },
      acceptsReceipt: () => options.acceptsReceipt !== false,
    },
    mutationAuthority: {
      providerId,
      supported: true,
      operations: options.authorizesRebuild === false ? [] : ["rebuild"],
    },
  } as unknown as RuntimeProviderBundle;
}

function replacement(
  agent: ShippedManagedImageAgent,
  platform: ManagedImagePlatform = "linux/amd64",
  revision?: string,
) {
  const image = managedContract(agent, "new", platform);
  const contract = revision ? { ...image, source: { ...image.source, revision } } : image;
  return {
    source: {
      kind: "managed-image" as const,
      reference: contract.reference,
      contract,
    },
    release: contract.source.release,
    fallbackDiagnostic: null,
  };
}

function completeHandoff(
  agent: ShippedManagedImageAgent,
  catalog: Awaited<ReturnType<typeof prepareManagedWorkloadRebuildHandoff>>,
): ManagedWorkloadRebuildHandoff {
  assert(catalog && !catalog.harnessPackage, "expected legacy handoff");
  return {
    ...catalog,
    replacementProfile: profileTransport(agent),
  };
}

function legacyPreviousProfile(
  handoff: NonNullable<Awaited<ReturnType<typeof prepareManagedWorkloadRebuildHandoff>>>,
): ManagedStartupProfile {
  assert(
    !isManagedStartupPackageProfile(handoff.previousProfile),
    "expected a legacy managed startup profile",
  );
  return handoff.previousProfile;
}

afterEach(() => {
  managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = ORIGINAL_PREPARE;
  managedWorkloadRebuildDependencies.loadHarnessStartupProfileAdapterHostModule =
    ORIGINAL_STARTUP_ADAPTER;
  managedWorkloadAuthorityDependencies.resolvePackageBackedSandboxAgent = ORIGINAL_PACKAGE_RESOLVER;
});

describe("managed workload rebuild preflight", () => {
  it("rebuilds a future package through exact receipt-backed authority", async () => {
    resolveFuturePackage();
    const nextContract = futureContract("new");
    const prepare = vi.fn(async (): Promise<PreparedSandboxWorkloadSource> => ({
      source: {
        kind: "managed-image" as const,
        reference: nextContract.reference,
        contract: nextContract,
      },
      release: nextContract.source.release,
      fallbackDiagnostic: null,
    }));
    managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = prepare;
    const row = futureEntry();

    const catalog = await prepareManagedWorkloadRebuildHandoff(row, {
      runtime: runtime(),
      provider: provider(),
      agentDefinition: {
        name: FUTURE_PACKAGE.id,
        managedImage: FUTURE_MANAGED_IMAGE,
      },
      version: "0.0.100",
    });
    assert(catalog?.harnessPackage, "expected package handoff");
    const reconcileStartupProfile = vi.fn((request) => ({
      kind: "package-config" as const,
      packageConfig: { nativeRevision: 2, model: request.desiredState.inference.model },
      changed: true,
    }));
    managedWorkloadRebuildDependencies.loadHarnessStartupProfileAdapterHostModule = vi.fn(() => ({
      startupProfileEnvironment: [],
      prepareStartupProfile: vi.fn(),
      buildInitialStartupProfile: vi.fn(),
      reconcileStartupProfile,
    }));
    const desiredState = futureDesiredState(true);
    const staged = stageManagedPackageWorkloadRebuildProfile(catalog, desiredState);
    assert(staged.harnessPackage, "expected staged package handoff");
    const rebuiltReceipt = buildManagedWorkloadRebuildReceipt(staged, provider());

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: FUTURE_PACKAGE.id,
        harnessPackage: FUTURE_PACKAGE,
        managedImage: FUTURE_MANAGED_IMAGE,
      }),
    );
    expect(reconcileStartupProfile).toHaveBeenCalledExactlyOnceWith({
      packageId: FUTURE_PACKAGE.id,
      harnessPackage: FUTURE_PACKAGE,
      desiredState,
      currentPackageConfig: catalog.previousProfile.packageConfig,
    });
    expect(staged.replacementProfile.profile).toMatchObject({
      desiredState,
      packageConfig: {
        nativeRevision: 2,
        model: desiredState.inference.model,
      },
    });
    expect(catalog.previousDashboardRemoteBindPrepared).toBe(true);
    expect(staged.replacementProfile.dashboardRemoteBindPrepared).toBe(true);
    expect(rebuiltReceipt).toMatchObject({
      reference: nextContract.reference,
      encodedProfile: staged.replacementProfile.encodedProfile,
      startupProfileSha256: staged.replacementProfile.startupProfileSha256,
    });
    expect(managedWorkloadRebuildHandoffMatchesEntry(catalog, row, provider())).toBe(true);
    expect(
      managedWorkloadRebuildHandoffMatchesEntry(
        catalog,
        {
          ...row,
          harnessPackage: { ...FUTURE_PACKAGE, contentDigest: "6".repeat(64) },
        },
        provider(),
      ),
    ).toBe(false);
    expect(() =>
      buildManagedWorkloadRebuildReceipt(
        {
          ...staged,
          replacementProfile: {
            ...staged.replacementProfile,
            dashboardRemoteBindPrepared: false,
          },
        },
        provider(),
      ),
    ).toThrow(/remote-dashboard preparation marker/u);

    const driftedPackage = { ...FUTURE_PACKAGE, contentDigest: "6".repeat(64) };
    const driftedProfile = {
      ...staged.replacementProfile.profile,
      harnessPackage: driftedPackage,
    };
    const driftedEncodedProfile = encodeManagedStartupDurableProfile(driftedProfile);
    expect(() =>
      buildManagedWorkloadRebuildReceipt(
        {
          ...staged,
          replacementProfile: {
            ...staged.replacementProfile,
            profile: driftedProfile,
            encodedProfile:
              driftedEncodedProfile as typeof staged.replacementProfile.encodedProfile,
            startupProfileSha256: createHash("sha256")
              .update(driftedEncodedProfile, "utf8")
              .digest("hex"),
          },
        },
        provider(),
      ),
    ).toThrow(/do not form valid durable authority/u);

    managedWorkloadRebuildDependencies.loadHarnessStartupProfileAdapterHostModule = vi.fn(() => ({
      startupProfileEnvironment: [],
      prepareStartupProfile: vi.fn(),
      buildInitialStartupProfile: vi.fn(),
      reconcileStartupProfile: () => ({
        kind: "unsupported" as const,
        reason: "future runtime requires external reconciliation",
      }),
    }));
    expect(() => stageManagedPackageWorkloadRebuildProfile(catalog, desiredState)).toThrow(
      /does not support startup reconciliation.*external reconciliation/u,
    );
  });

  it.each(["openclaw", "hermes", "langchain-deepagents-code", "pi"] as const)(
    "reconciles persisted desired state through the %s package adapter",
    (agent) => {
      const harnessPackage = {
        kind: "agent-runtime" as const,
        id: agent,
        packageVersion: "1.2.3",
        contentDigest: "5".repeat(64),
      };
      const previousDesiredState = managedStartupSettingsFromProfile(
        managedStartupE2eProfile(agent),
      );
      const catalog = {
        agent,
        harnessPackage,
        previousProfile: {
          schemaVersion: 1,
          profileKind: "package",
          agent,
          harnessPackage,
          desiredState: previousDesiredState,
          packageConfig: { nativeRevision: 1 },
          corporateCa: previousDesiredState.corporateCa,
        },
        previousReceipt: {
          credentialProxyReplayRequired: false,
        },
        previousDashboardRemoteBindPrepared: false,
        corporateCa: null,
      } as unknown as PackageManagedWorkloadRebuildCatalogHandoff;
      const reconcileStartupProfile = vi.fn((request) => ({
        kind: "package-config" as const,
        packageConfig: { nativeRevision: 2, settings: request.desiredState },
        changed: true,
      }));
      managedWorkloadRebuildDependencies.loadHarnessStartupProfileAdapterHostModule = vi.fn(() => ({
        startupProfileEnvironment: [],
        prepareStartupProfile: vi.fn(),
        buildInitialStartupProfile: vi.fn(),
        reconcileStartupProfile,
      }));

      const staged = stageManagedPackageWorkloadRebuildProfile(catalog, previousDesiredState);
      assert(staged.harnessPackage, "expected package rebuild handoff");

      expect(reconcileStartupProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          packageId: agent,
          harnessPackage,
          currentPackageConfig: { nativeRevision: 1 },
        }),
      );
      expect(staged.replacementProfile.profile).toMatchObject({
        agent,
        harnessPackage,
        desiredState: reconcileStartupProfile.mock.calls[0]?.[0].desiredState,
        packageConfig: { nativeRevision: 2 },
      });
    },
  );

  it.each(AGENTS)(
    "prepares exact current-release authority for %s without a Dockerfile fallback",
    async (agent) => {
      const prepare = vi.fn(async () => replacement(agent));
      managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = prepare;

      const handoff = await prepareManagedWorkloadRebuildHandoff(entry(agent), {
        runtime: runtime(),
        provider: provider(),
        version: "0.0.100",
      });

      expect(handoff).toMatchObject({
        schemaVersion: 1,
        providerId: "mxc",
        agent,
        previousReceipt: {
          kind: "managed-image",
          platform: "linux/amd64",
          release: "v0.0.99",
        },
        replacement: {
          source: {
            kind: "managed-image",
            contract: { agent, platform: "linux/amd64" },
          },
          release: "v0.0.100",
        },
      });
      expect(prepare).toHaveBeenCalledWith({
        agentName: agent,
        managedImage: qualifiedManagedImageDeclaration(agent),
        legacyDockerfilePath: "managed-rebuild-must-not-stage-this-dockerfile",
        runtime: runtime(),
        version: "0.0.100",
        policy: "require-managed",
      });
      expect(Object.isFrozen(handoff)).toBe(true);
      expect(Object.isFrozen(legacyPreviousProfile(handoff!).proxy)).toBe(true);
      expect(Object.isFrozen(handoff?.replacement.source.contract.source)).toBe(true);
    },
  );

  it("retains the live qualification revision during rebuild preflight (#9385)", async () => {
    const prepare = vi.fn(async () => replacement("langchain-deepagents-code"));
    managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = prepare;
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("E2E_MANAGED_IMAGE_REVISION", "a".repeat(40));

    await prepareManagedWorkloadRebuildHandoff(entry("langchain-deepagents-code"), {
      runtime: runtime(),
      provider: provider(),
      version: "0.0.100",
    });

    expect(prepare).toHaveBeenCalledExactlyOnceWith({
      agentName: "langchain-deepagents-code",
      managedImage: qualifiedManagedImageDeclaration("langchain-deepagents-code"),
      legacyDockerfilePath: "managed-rebuild-must-not-stage-this-dockerfile",
      runtime: runtime(),
      version: "0.0.100",
      policy: "require-managed",
      catalogRevision: "a".repeat(40),
    });
  });

  it("retains the exact PR catalog during rebuild preflight (#9464)", async () => {
    const prepare = vi.fn(async () => replacement("openclaw"));
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-live-e2e-catalog-"));
    const catalogPath = path.join(fixtureRoot, "catalog.json");
    fs.writeFileSync(catalogPath, "{}\n", { mode: 0o600 });
    managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = prepare;
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("NEMOCLAW_RUN_LIVE_E2E", "1");
    vi.stubEnv("NEMOCLAW_E2E_EXPECTED_SHA", "a".repeat(40));
    vi.stubEnv("NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG", catalogPath);

    try {
      await prepareManagedWorkloadRebuildHandoff(entry("openclaw"), {
        runtime: runtime(),
        provider: provider(),
        version: "0.0.100",
      });

      expect(prepare).toHaveBeenCalledExactlyOnceWith({
        agentName: "openclaw",
        managedImage: qualifiedManagedImageDeclaration("openclaw"),
        legacyDockerfilePath: "managed-rebuild-must-not-stage-this-dockerfile",
        runtime: runtime(),
        version: "0.0.100",
        policy: "require-managed",
        catalogPath,
        expectedCatalogRevision: "a".repeat(40),
      });
    } finally {
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("uses the GitHub Actions qualification revision and retains the previous workload receipt during rebuild (#10970)", async () => {
    const prepare = vi.fn(async () => replacement("openclaw", "linux/amd64", "c".repeat(40)));
    managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = prepare;
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("E2E_MANAGED_IMAGE_REVISION", "c".repeat(40));

    const handoff = await prepareManagedWorkloadRebuildHandoff(entry("openclaw"), {
      runtime: runtime(),
      provider: provider(),
      version: "0.0.100",
    });

    expect(handoff?.previousReceipt.sourceRevision).toBe("a".repeat(40));
    expect(handoff?.replacement.source.contract.source.revision).toBe("c".repeat(40));
    expect(prepare).toHaveBeenCalledExactlyOnceWith({
      agentName: "openclaw",
      managedImage: qualifiedManagedImageDeclaration("openclaw"),
      legacyDockerfilePath: "managed-rebuild-must-not-stage-this-dockerfile",
      runtime: runtime(),
      version: "0.0.100",
      policy: "require-managed",
      catalogRevision: "c".repeat(40),
    });
  });

  it("accepts an exact PR replacement catalog newer than durable authority (#9464)", async () => {
    const prepare = vi.fn(async () => replacement("openclaw", "linux/amd64", "c".repeat(40)));
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-live-e2e-catalog-"));
    const catalogPath = path.join(fixtureRoot, "catalog.json");
    fs.writeFileSync(catalogPath, "{}\n", { mode: 0o600 });
    managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = prepare;
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("NEMOCLAW_RUN_LIVE_E2E", "1");
    vi.stubEnv("NEMOCLAW_E2E_EXPECTED_SHA", "c".repeat(40));
    vi.stubEnv("NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG", catalogPath);

    try {
      const handoff = await prepareManagedWorkloadRebuildHandoff(entry("openclaw"), {
        runtime: runtime(),
        provider: provider(),
        version: "0.0.100",
      });

      expect(handoff?.previousReceipt.sourceRevision).toBe("a".repeat(40));
      expect(handoff?.replacement.source.contract.source.revision).toBe("c".repeat(40));
      expect(prepare).toHaveBeenCalledExactlyOnceWith({
        agentName: "openclaw",
        managedImage: qualifiedManagedImageDeclaration("openclaw"),
        legacyDockerfilePath: "managed-rebuild-must-not-stage-this-dockerfile",
        runtime: runtime(),
        version: "0.0.100",
        policy: "require-managed",
        catalogPath,
        expectedCatalogRevision: "c".repeat(40),
      });
    } finally {
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("keeps release-catalog rebuild behavior outside GitHub Actions (#9385)", async () => {
    const prepare = vi.fn(async () => replacement("openclaw"));
    managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = prepare;
    vi.stubEnv("GITHUB_ACTIONS", "false");
    vi.stubEnv("E2E_MANAGED_IMAGE_REVISION", "c".repeat(40));

    await prepareManagedWorkloadRebuildHandoff(entry("openclaw"), {
      runtime: runtime(),
      provider: provider(),
      version: "0.0.100",
    });

    expect(prepare).toHaveBeenCalledExactlyOnceWith({
      agentName: "openclaw",
      managedImage: qualifiedManagedImageDeclaration("openclaw"),
      legacyDockerfilePath: "managed-rebuild-must-not-stage-this-dockerfile",
      runtime: runtime(),
      version: "0.0.100",
      policy: "require-managed",
    });
  });

  it.each(AGENTS)("prepares an arm64 replacement handoff for %s", async (agent) => {
    managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = vi.fn(async () =>
      replacement(agent, "linux/arm64"),
    );

    const handoff = await prepareManagedWorkloadRebuildHandoff(entry(agent, "linux/arm64"), {
      runtime: runtime("mxc", "linux/arm64"),
      provider: provider(),
      version: "0.0.100",
    });

    expect(handoff).toMatchObject({
      agent,
      previousReceipt: { platform: "linux/arm64" },
      replacement: { source: { contract: { platform: "linux/arm64" } } },
    });
  });

  it("returns null for a custom workload without resolving a catalog", async () => {
    const prepare = vi.fn();
    managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = prepare;

    await expect(
      prepareManagedWorkloadRebuildHandoff(
        {
          agent: "openclaw",
          fromDockerfile: "/tmp/Dockerfile",
          imageTag: "custom:local",
          workload: {
            schemaVersion: 1,
            kind: "legacy-dockerfile",
            reference: "custom:local",
            shared: false,
          },
        },
        { runtime: runtime(), provider: provider() },
      ),
    ).resolves.toBeNull();
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each([
    [
      "provider identity",
      entry("openclaw"),
      runtime("other"),
      provider("mxc"),
      /does not match provider/u,
    ],
    [
      "recorded platform",
      entry("openclaw", "linux/arm64"),
      runtime("mxc", "linux/amd64"),
      provider("mxc"),
      /targets 'linux[/]arm64'/u,
    ],
    [
      "workload capability",
      entry("openclaw"),
      runtime(),
      provider("mxc", { acceptsReceipt: false }),
      /does not accept/u,
    ],
    [
      "mutation authority",
      entry("openclaw"),
      runtime(),
      provider("mxc", { authorizesRebuild: false }),
      /does not authorize 'rebuild'/u,
    ],
  ] as const)(
    "rejects %s drift before catalog resolution",
    async (_label, row, target, selected, error) => {
      const prepare = vi.fn();
      managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = prepare;

      await expect(
        prepareManagedWorkloadRebuildHandoff(row, {
          runtime: target,
          provider: selected,
        }),
      ).rejects.toThrow(error);
      expect(prepare).not.toHaveBeenCalled();
    },
  );

  it("revalidates retained profile and receipt authority against the live row", async () => {
    managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = vi.fn(async () =>
      replacement("openclaw"),
    );
    const row = entry("openclaw");
    const catalog = await prepareManagedWorkloadRebuildHandoff(row, {
      runtime: runtime(),
      provider: provider(),
    });

    expect(managedWorkloadRebuildHandoffMatchesEntry(catalog!, row, provider())).toBe(true);
    expect(
      managedWorkloadRebuildHandoffMatchesEntry(
        catalog!,
        { ...row, imageTag: receipt("openclaw", "new").reference },
        provider(),
      ),
    ).toBe(false);
    expect(managedWorkloadRebuildHandoffMatchesEntry(catalog!, row, provider("other"))).toBe(false);
  });

  it("materializes a shared exact-digest replacement receipt", async () => {
    managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = vi.fn(async () =>
      replacement("hermes"),
    );
    const catalog = await prepareManagedWorkloadRebuildHandoff(entry("hermes"), {
      runtime: runtime(),
      provider: provider(),
    });
    const complete = completeHandoff("hermes", catalog);

    const result = buildManagedWorkloadRebuildReceipt(complete, provider());

    expect(result).toEqual(receipt("hermes", "new"));
    expect(result.shared).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("rebuilds from the receipt-pinned package repository instead of the core catalogue map", async () => {
    resolveFuturePackage();
    const row = futureEntry();
    const replacementContract = futureContract("new");
    managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = vi.fn(async () => ({
      source: {
        kind: "managed-image" as const,
        reference: replacementContract.reference,
        contract: replacementContract,
      },
      release: replacementContract.source.release,
      fallbackDiagnostic: null,
    }));

    const catalog = await prepareManagedWorkloadRebuildHandoff(row, {
      runtime: runtime(),
      provider: provider(),
      agentDefinition: { name: FUTURE_PACKAGE.id, managedImage: FUTURE_MANAGED_IMAGE },
    });
    assert(catalog?.harnessPackage, "expected package handoff");

    expect(catalog.replacement.source).toMatchObject({
      kind: "managed-image",
      reference: replacementContract.reference,
      contract: { image: FUTURE_MANAGED_IMAGE.repository },
    });
    expect(catalog.replacement.source.reference).not.toContain(MANAGED_IMAGE_REPOSITORIES.openclaw);
  });

  it("rejects a cross-agent replacement contract and profile before receipt creation", async () => {
    managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = vi.fn(async () =>
      replacement("openclaw"),
    );
    const catalog = await prepareManagedWorkloadRebuildHandoff(entry("openclaw"), {
      runtime: runtime(),
      provider: provider(),
    });
    assert(catalog && !catalog.harnessPackage, "expected legacy handoff");
    const crossAgentHandoff: ManagedWorkloadRebuildHandoff = {
      ...catalog,
      replacement: replacement("hermes"),
      replacementProfile: profileTransport("hermes"),
    };

    expect(() => buildManagedWorkloadRebuildReceipt(crossAgentHandoff, provider())).toThrow(
      /does not match the exact rebuild agent/u,
    );
  });

  it.each(AGENTS)("stages authoritative startup-profile reconstruction for %s", async (agent) => {
    managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = vi.fn(async () =>
      replacement(agent),
    );
    const catalog = await prepareManagedWorkloadRebuildHandoff(entry(agent), {
      runtime: runtime(),
      provider: provider(),
    });

    const staged = stageManagedWorkloadRebuildProfile(catalog!, rebuildProfileInput(agent), {});
    const decoded = decodeManagedStartupProfile(staged.replacementProfile.encodedProfile);
    const previousProfile = legacyPreviousProfile(catalog!);

    expect(staged.replacementProfile.credentialProxyReplayRequired).toBe(false);
    expect(decoded).toMatchObject({
      agent,
      agentConfig: { agent },
      proxy: {
        managedHost: previousProfile.proxy.managedHost,
        managedPort: previousProfile.proxy.managedPort,
        hostHttpUrl: previousProfile.proxy.hostHttpUrl,
        hostHttpsUrl: previousProfile.proxy.hostHttpsUrl,
      },
    });
    expect(decoded.proxy.hostNoProxy).toEqual(
      expect.arrayContaining([...previousProfile.proxy.hostNoProxy]),
    );
  });

  it("replays credential-bearing proxy intent without persisting credentials", async () => {
    managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = vi.fn(async () =>
      replacement("openclaw"),
    );
    const catalog = await prepareManagedWorkloadRebuildHandoff(entry("openclaw"), {
      runtime: runtime(),
      provider: provider(),
    });
    const replayHandoff = {
      ...catalog!,
      previousReceipt: {
        ...catalog!.previousReceipt,
        credentialProxyReplayRequired: true,
      },
    };
    const environment = {
      HTTPS_PROXY: "https://operator:secret@proxy.example.test:8443",
      NO_PROXY: "localhost,127.0.0.1",
    };

    const staged = stageManagedWorkloadRebuildProfile(
      replayHandoff,
      rebuildProfileInput("openclaw"),
      environment,
    );
    const reconstructed = managedWorkloadRebuildProfileEnvironment(replayHandoff, environment);
    const decodedProfile = decodeManagedStartupProfile(staged.replacementProfile.encodedProfile);

    expect(reconstructed.HTTPS_PROXY).toBe(environment.HTTPS_PROXY);
    expect(staged.replacementProfile.credentialProxyReplayRequired).toBe(true);
    expect(JSON.stringify(decodedProfile)).not.toContain("secret");
    expect(JSON.stringify(staged.replacementProfile.profile)).not.toContain("operator");
  });

  it("sources corporate CA material only from validated rebuild authority", async () => {
    managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = vi.fn(async () =>
      replacement("hermes"),
    );
    const catalog = await prepareManagedWorkloadRebuildHandoff(entry("hermes"), {
      runtime: runtime(),
      provider: provider(),
    });
    const pem = MANAGED_STARTUP_E2E_CORPORATE_CA_PEM;
    const withCorporateCa = {
      ...catalog!,
      corporateCa: {
        pem,
        sourcePath: "durable-rebuild-authority",
        sourceEnv: "durable-rebuild-authority",
      },
    };

    const staged = stageManagedWorkloadRebuildProfile(
      withCorporateCa,
      rebuildProfileInput("hermes"),
      {},
    );

    expect(staged.replacementProfile.profile.corporateCa).toEqual({
      bundleSha256: createHash("sha256").update(pem, "utf8").digest("hex"),
    });
    expect(Buffer.from(staged.replacementProfile.corporateCaB64!, "base64").toString("utf8")).toBe(
      pem,
    );
  });

  it("rebinds the retained immutable source through the selected provider contract", async () => {
    managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = vi.fn(async () =>
      replacement("langchain-deepagents-code"),
    );
    const catalog = await prepareManagedWorkloadRebuildHandoff(entry("langchain-deepagents-code"), {
      runtime: runtime(),
      provider: provider(),
    });

    const source = prepareSandboxWorkloadSourceFromRebuildHandoff(catalog!, runtime(), provider());

    expect(source).toEqual(replacement("langchain-deepagents-code"));
    expect(() =>
      prepareSandboxWorkloadSourceFromRebuildHandoff(catalog!, runtime("other"), provider()),
    ).toThrow(/does not belong to the selected runtime provider/u);
  });
});
