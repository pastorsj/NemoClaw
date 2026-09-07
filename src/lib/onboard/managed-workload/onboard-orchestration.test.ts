// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { AgentDefinition } from "../../agent/defs";
import type { HarnessPackageIdentity } from "../../agent-runtime/package/types";
import { createHermesStateVolumeDockerHarness } from "../__test-helpers__/hermes-state-volume";
import { qualifiedManagedImageDeclaration } from "../managed-image/contract";
import {
  managedStartupStateRoots,
  managedStartupWorkspaceRoot,
} from "../managed-startup/state-roots";

describe("managed workspace-root declarations", () => {
  it("preserves the DCode sticky root-owned login-profile boundary generically", () => {
    expect(
      managedStartupWorkspaceRoot({
        managedImage: qualifiedManagedImageDeclaration("langchain-deepagents-code"),
      }),
    ).toEqual({ uid: 0, gid: 999, mode: 0o1775 });
    expect(
      managedStartupWorkspaceRoot({
        managedImage: qualifiedManagedImageDeclaration("openclaw"),
      }),
    ).toEqual({ uid: 998, gid: 998, mode: 0o755 });
  });
});

const preparationState = vi.hoisted(() => ({
  prepared: undefined as unknown,
  useUnavailableCatalog: false,
}));
const prepareSandboxWorkloadSource = vi.hoisted(() => vi.fn());
const INSTALLED_REVISION = vi.hoisted(() => "d".repeat(40));
const releaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-release-root-"));
fs.writeFileSync(path.join(releaseRoot, ".version"), "0.0.0\n");

vi.mock("../workload/preparation", async (importOriginal) => {
  const original = await importOriginal<typeof import("../workload/preparation")>();
  const { ManagedImageCatalogUnavailableError } = await import("../managed-image/catalog");
  prepareSandboxWorkloadSource.mockImplementation((input) =>
    preparationState.useUnavailableCatalog
      ? original.prepareSandboxWorkloadSource(input, {
          resolveCatalog: async () => {
            throw new ManagedImageCatalogUnavailableError("registry offline");
          },
        })
      : Promise.resolve(preparationState.prepared),
  );
  return { ...original, prepareSandboxWorkloadSource };
});

vi.mock("../../core/version", () => ({
  getBuildIdentity: () => ({ nemoclawVersion: "0.0.0", sourceRevision: INSTALLED_REVISION }),
  getVersion: () => "v0.0.0",
}));

import { mapManagedStartupProfileToAgentEnvironment as mapManagedStartupProfileWithAdapter } from "../managed-startup/agent-environment";
import {
  createManagedStateVolumeOnboardLifecycle,
  createManagedWorkloadOnboardRuntime,
  prepareHermesPortableSandboxWorkloadForLifecycle,
  prepareOnboardSandboxWorkloadLaunch,
  resolveOnboardSandboxWorkloadReceipt,
  shouldActivateManagedRuntime,
} from "./onboard-orchestration";

function mapManagedStartupProfileToAgentEnvironment(
  profile: Parameters<typeof mapManagedStartupProfileWithAdapter>[0],
) {
  const filename = path.resolve(`packages/nemoclaw-${profile.agent}/host/startup-adapter.cts`);
  return mapManagedStartupProfileWithAdapter(
    profile,
    {},
    {
      adapterSource: {
        filename,
        source: fs.readFileSync(filename, "utf8"),
        ...("profileKind" in profile ? { harnessPackage: profile.harnessPackage } : {}),
      },
    },
  );
}

function createFreshOnboardingRuntime(
  environment: Readonly<Record<string, string>>,
  options: {
    readonly agentName?: string;
    readonly managedRuntimeEnabled?: boolean;
    readonly tempManagedRuntime?: boolean;
    readonly tempManagedRuntimeCatalog?: string | null;
    readonly unavailableCatalog?: boolean;
    readonly harnessPackage?: HarnessPackageIdentity;
    readonly agentDefinition?: {
      readonly name: string;
      readonly managedImage: ReturnType<typeof qualifiedManagedImageDeclaration> | null;
    };
  } = {},
) {
  const prepared = {
    source: {
      kind: "legacy-dockerfile",
      dockerfilePath: "packages/nemoclaw-openclaw/Dockerfile",
      reason: "contract-unavailable",
    },
    release: "v0.0.0",
    fallbackDiagnostic: null,
  };
  preparationState.prepared = prepared;
  preparationState.useUnavailableCatalog = options.unavailableCatalog ?? false;
  prepareSandboxWorkloadSource.mockClear();

  const runtime = createManagedWorkloadOnboardRuntime(
    {
      computePlan: { driverName: "docker" },
      managedWorkloadRebuild: null,
      tempManagedRuntime: options.tempManagedRuntime ?? false,
      managedRuntimeEnabled: options.managedRuntimeEnabled ?? false,
      tempManagedRuntimeCatalog: options.tempManagedRuntimeCatalog ?? null,
      agentName: options.agentName ?? "openclaw",
      ...(options.agentDefinition ? { agentDefinition: options.agentDefinition } : {}),
      harnessPackage: options.harnessPackage ?? null,
      legacyDockerfilePath: "packages/nemoclaw-openclaw/Dockerfile",
      customDockerfilePath: null,
      rootDir: releaseRoot,
      model: "model",
      provider: "provider",
      preferredInferenceApi: null,
      endpointUrl: null,
      startupProfile: { environment },
      note: vi.fn(),
      fallbackBuildEstimate: () => null,
    } as unknown as Parameters<typeof createManagedWorkloadOnboardRuntime>[0],
    {
      resolveAgentInferenceApi: vi.fn(),
      getSandboxInferenceConfig: vi.fn(),
    },
  );

  return { prepared, runtime };
}

async function expectUnsupportedHermesPortableSources(
  runtime: Parameters<typeof prepareHermesPortableSandboxWorkloadForLifecycle>[0],
  prepared: {
    source: {
      kind: "legacy-dockerfile";
      dockerfilePath: string;
      reason: "runtime-unsupported";
    };
    release: string;
    fallbackDiagnostic: null;
  },
  expectedDockerfilePath: string,
): Promise<void> {
  await Promise.all(
    [
      { ...prepared.source, reason: "custom-dockerfile" as const },
      { ...prepared.source, dockerfilePath: "/workspace/replacement/Dockerfile" },
    ].map((source) =>
      expect(
        prepareHermesPortableSandboxWorkloadForLifecycle(
          { ...runtime, ensurePreparedWorkload: vi.fn(async () => ({ ...prepared, source })) },
          expectedDockerfilePath,
        ),
      ).rejects.toThrow("requires the shipped Hermes Dockerfile source"),
    ),
  );
}

describe("managed workload onboard orchestration", () => {
  afterAll(() => {
    fs.rmSync(releaseRoot, { force: true, recursive: true });
  });

  it("activates managed images from legacy shipped authority or an exact package receipt", () => {
    expect(
      shouldActivateManagedRuntime({
        portableLifecycle: false,
        hermesPortableLifecycle: false,
        agentName: "openclaw",
      }),
    ).toBe(true);
    expect(
      shouldActivateManagedRuntime({
        portableLifecycle: false,
        hermesPortableLifecycle: false,
        agentName: "hermes",
      }),
    ).toBe(true);
    expect(
      shouldActivateManagedRuntime({
        portableLifecycle: false,
        hermesPortableLifecycle: false,
        agentName: "langchain-deepagents-code",
      }),
    ).toBe(true);
    expect(
      shouldActivateManagedRuntime({
        portableLifecycle: true,
        hermesPortableLifecycle: false,
        agentName: "openclaw",
      }),
    ).toBe(false);
    expect(
      shouldActivateManagedRuntime({
        portableLifecycle: false,
        hermesPortableLifecycle: false,
        agentName: "nemocua",
      }),
    ).toBe(false);
    expect(
      shouldActivateManagedRuntime({
        portableLifecycle: false,
        hermesPortableLifecycle: false,
        agentName: "pi",
      }),
    ).toBe(false);
    const harnessPackage = {
      kind: "agent-runtime" as const,
      id: "future-harness",
      packageVersion: "1.2.3",
      contentDigest: "f".repeat(64),
    };
    const agentDefinition = {
      name: harnessPackage.id,
      managedImage: {
        repository: "registry.example/team/future-harness",
        architectures: ["linux/amd64" as const],
        runtime_identity: { uid: 999, gid: 999, workdir: "/sandbox" as const },
      },
    };
    expect(
      shouldActivateManagedRuntime({
        portableLifecycle: false,
        hermesPortableLifecycle: false,
        agentName: harnessPackage.id,
        agentDefinition,
        harnessPackage,
      }),
    ).toBe(true);
    expect(
      shouldActivateManagedRuntime({
        portableLifecycle: false,
        hermesPortableLifecycle: false,
        agentName: harnessPackage.id,
        agentDefinition: { ...agentDefinition, managedImage: null },
        harnessPackage,
      }),
    ).toBe(false);
    expect(
      shouldActivateManagedRuntime({
        portableLifecycle: false,
        hermesPortableLifecycle: false,
        agentName: harnessPackage.id,
        agentDefinition,
        harnessPackage: { ...harnessPackage, id: "different-harness" },
      }),
    ).toBe(false);
  });

  it("does not activate stock managed images for Hermes Portable (#9634)", () => {
    expect(
      shouldActivateManagedRuntime({
        portableLifecycle: false,
        hermesPortableLifecycle: true,
        agentName: "hermes",
      }),
    ).toBe(false);
  });

  it("keeps the Hermes browser URL in its receipt-backed package startup profile", () => {
    const harnessPackage = {
      kind: "agent-runtime" as const,
      id: "hermes",
      packageVersion: "1.0.0",
      contentDigest: "a".repeat(64),
    };
    const buildInitialStartupProfile = vi.fn((request) => ({
      kind: "package-config" as const,
      packageConfig: { settings: request.desiredState },
    }));
    const prepareStartupProfile = vi.fn((request) => {
      const candidate = request.input.inference.candidates[0];
      return {
        kind: "prepared" as const,
        desiredState: {
          configuration: {
            agent: "hermes",
            webSearch: { enabled: false, provider: "tavily" as const },
          },
          inference: {
            routeProvider: candidate.providerKey ?? candidate.routeProvider,
            upstreamProvider: request.input.inference.selectedProvider,
            model: request.input.inference.model,
            routedBaseUrl: candidate.inferenceBaseUrl ?? candidate.routedBaseUrl,
            upstreamEndpointUrl: null,
            api: candidate.inferenceApi ?? candidate.api,
            primaryModelRef: null,
            compatibility: null,
            inputModalities: null,
          },
          proxy: request.input.proxy,
          dashboard: {
            agent: "hermes",
            mode: "loopback-forwarded" as const,
            url: "http://127.0.0.1:19189",
            browserUrl: request.input.dashboard.url,
            publicPort: 19_189,
            internalPort: 29_189,
            tuiEnabled: false,
          },
          tools: request.input.tools,
          messaging: { plan: request.input.messagingPlan },
          tuning: {
            contextWindow: null,
            maxTokens: null,
            reasoning: null,
            reasoningEffort: null,
          },
          corporateCa: request.input.corporateCa,
        },
        credentialProxyReplayRequired: false,
        dashboardRemoteBindPrepared: false,
      };
    });
    const runtime = createManagedWorkloadOnboardRuntime(
      {
        computePlan: { driverName: "docker" },
        managedWorkloadRebuild: null,
        tempManagedRuntime: false,
        managedRuntimeEnabled: true,
        tempManagedRuntimeCatalog: null,
        agentName: "hermes",
        agentDefinition: {
          name: "hermes",
          managedImage: qualifiedManagedImageDeclaration("hermes"),
        },
        harnessPackage,
        legacyDockerfilePath: "packages/nemoclaw-hermes/Dockerfile",
        customDockerfilePath: null,
        rootDir: releaseRoot,
        model: "moonshotai/kimi-k2.6",
        provider: "nvidia",
        preferredInferenceApi: null,
        endpointUrl: null,
        startupProfile: {
          chatUiUrl: "https://hermes.example.test:19189",
          effectiveDashboardPort: 19_189,
          manageDashboard: true,
          dashboardBindAddress: undefined,
          wslExposure: false,
          hermesDashboardState: {
            config: {
              enabled: true,
              port: 19_189,
              internalPort: 29_189,
              tuiEnabled: false,
            },
            enabled: true,
          },
          webSearch: null,
          toolDisclosure: "progressive",
          enabledToolGateways: ["nous-web"],
          hermesToolGateways: ["legacy-must-not-project"],
          messagingPlan: null,
          dcodeAutoApprovalMode: "disabled",
          observabilityEnabled: false,
          environment: {},
        },
        note: vi.fn(),
        fallbackBuildEstimate: () => null,
      } as unknown as Parameters<typeof createManagedWorkloadOnboardRuntime>[0],
      {
        resolveAgentInferenceApi: vi.fn(() => "openai-completions"),
        getSandboxInferenceConfig: vi.fn(() => ({
          providerKey: "inference",
          inferenceBaseUrl: "https://inference.local/v1",
          inferenceApi: "openai-completions",
          primaryModelRef: "inference/moonshotai/kimi-k2.6",
          inferenceCompat: {},
        })),
        loadHarnessStartupProfileAdapter: vi.fn(() => ({
          startupProfileEnvironment: [],
          prepareStartupProfile,
          buildInitialStartupProfile,
          reconcileStartupProfile: vi.fn(),
        })),
      },
    );

    const built = runtime.ensurePreparedProfile({
      source: { kind: "managed-image" },
    } as never);
    assert(
      built && "profileKind" in built.profile,
      "Expected a receipt-backed package startup profile.",
    );

    expect(prepareStartupProfile.mock.calls[0]?.[0].input.tools.enabledGateways).toEqual([
      "nous-web",
    ]);
    expect(built.profile).toMatchObject({
      agent: "hermes",
      harnessPackage,
      desiredState: {
        dashboard: {
          agent: "hermes",
          mode: "loopback-forwarded",
          url: "http://127.0.0.1:19189",
          browserUrl: "https://hermes.example.test:19189",
          publicPort: 19_189,
          internalPort: 29_189,
          tuiEnabled: false,
        },
      },
      packageConfig: {
        settings: {
          dashboard: {
            agent: "hermes",
            mode: "loopback-forwarded",
            url: "http://127.0.0.1:19189",
            browserUrl: "https://hermes.example.test:19189",
            publicPort: 19_189,
            internalPort: 29_189,
            tuiEnabled: false,
          },
        },
      },
    });
    expect(buildInitialStartupProfile).toHaveBeenCalledExactlyOnceWith({
      packageId: "hermes",
      harnessPackage,
      desiredState: built.profile.desiredState,
    });
    expect(
      mapManagedStartupProfileToAgentEnvironment(built.profile).runtimeEnvironment.CHAT_UI_URL,
    ).toBe("https://hermes.example.test:19189");
  });

  it("prepares a synthetic future package through the public receipt-backed onboarding seam", () => {
    const harnessPackage = {
      kind: "agent-runtime" as const,
      id: "future-harness",
      packageVersion: "1.0.0",
      contentDigest: "f".repeat(64),
    };
    const prepareStartupProfile = vi.fn((request) => {
      const candidate = request.input.inference.candidates[0];
      return {
        kind: "prepared" as const,
        desiredState: {
          configuration: {
            agent: harnessPackage.id,
            mode: request.input.environment.FUTURE_PUBLIC_MODE,
          },
          inference: {
            routeProvider: candidate.routeProvider,
            upstreamProvider: request.input.inference.selectedProvider ?? candidate.routeProvider,
            model: request.input.inference.model,
            routedBaseUrl: candidate.routedBaseUrl,
            upstreamEndpointUrl: request.input.inference.endpointUrl,
            api: candidate.api,
            primaryModelRef: null,
            compatibility: null,
            inputModalities: null,
          },
          proxy: request.input.proxy,
          dashboard: { agent: harnessPackage.id, mode: "disabled" as const },
          tools: request.input.tools,
          messaging: { plan: request.input.messagingPlan },
          tuning: {
            contextWindow: null,
            maxTokens: null,
            reasoning: null,
            reasoningEffort: null,
          },
          corporateCa: request.input.corporateCa,
        },
        credentialProxyReplayRequired: false,
        dashboardRemoteBindPrepared: false,
      };
    });
    const buildInitialStartupProfile = vi.fn((request) => ({
      kind: "package-config" as const,
      packageConfig: { native: request.desiredState.configuration },
    }));
    const resolveAgentInferenceApi = vi.fn(() => {
      throw new Error("legacy normalization must not run");
    });
    const runtime = createManagedWorkloadOnboardRuntime(
      {
        computePlan: { driverName: "docker" },
        managedWorkloadRebuild: null,
        tempManagedRuntime: false,
        managedRuntimeEnabled: true,
        tempManagedRuntimeCatalog: null,
        agentName: harnessPackage.id,
        agentDefinition: {
          name: harnessPackage.id,
          managedImage: {
            repository: "registry.example/team/future-harness",
            architectures: ["linux/amd64"],
            runtime_identity: { uid: 999, gid: 999, workdir: "/sandbox" },
            startup_profile_environment: [
              { name: "FUTURE_PUBLIC_MODE", value_type: "string", max_bytes: 32 },
            ],
          },
        },
        harnessPackage,
        legacyDockerfilePath: "unused",
        customDockerfilePath: null,
        rootDir: releaseRoot,
        model: "future/model",
        provider: "future-provider",
        preferredInferenceApi: null,
        endpointUrl: "https://future.example/v1",
        startupProfile: {
          chatUiUrl: "",
          effectiveDashboardPort: 0,
          manageDashboard: false,
          dashboardBindAddress: undefined,
          wslExposure: false,
          hermesDashboardState: { config: null, enabled: false },
          webSearch: null,
          toolDisclosure: "progressive",
          enabledToolGateways: ["future-search"],
          hermesToolGateways: ["nous-web"],
          messagingPlan: null,
          dcodeAutoApprovalMode: "disabled",
          observabilityEnabled: false,
          environment: { FUTURE_PUBLIC_MODE: "strict" },
        },
        note: vi.fn(),
        fallbackBuildEstimate: () => null,
      } as unknown as Parameters<typeof createManagedWorkloadOnboardRuntime>[0],
      {
        resolveAgentInferenceApi,
        getSandboxInferenceConfig: vi.fn((_model, _provider, api) => ({
          providerKey: "future-route",
          inferenceBaseUrl: "https://inference.local/v1",
          inferenceApi: api ?? "openai-completions",
          primaryModelRef: "future-route/future-model",
          inferenceCompat: null,
        })),
        loadHarnessStartupProfileAdapter: vi.fn(() => ({
          startupProfileEnvironment: [
            { name: "FUTURE_PUBLIC_MODE", value_type: "string" as const, max_bytes: 32 },
          ],
          prepareStartupProfile,
          buildInitialStartupProfile,
          reconcileStartupProfile: vi.fn(),
        })),
      },
    );

    const dockerfileWorkload = {
      source: {
        kind: "legacy-dockerfile" as const,
        dockerfilePath: "packages/nemoclaw-future-harness/Dockerfile",
        reason: "agent-not-managed" as const,
      },
      release: null,
      fallbackDiagnostic: null,
    };
    const built = runtime.ensurePreparedProfile(dockerfileWorkload);
    assert(built && "profileKind" in built.profile, "expected package profile");

    expect(resolveAgentInferenceApi).not.toHaveBeenCalled();
    expect(prepareStartupProfile).toHaveBeenCalledOnce();
    expect(prepareStartupProfile.mock.calls[0]?.[0].input.tools.enabledGateways).toEqual([
      "future-search",
    ]);
    expect(buildInitialStartupProfile).toHaveBeenCalledOnce();
    expect(built.profile).toMatchObject({
      agent: "future-harness",
      desiredState: { configuration: { agent: "future-harness", mode: "strict" } },
      packageConfig: { native: { agent: "future-harness", mode: "strict" } },
    });
    expect(
      resolveOnboardSandboxWorkloadReceipt({
        runtime,
        workload: dockerfileWorkload,
        registryImageRef: "nemoclaw-future-harness:local",
        prebuildImageRef: null,
        firstCreateOutput: "",
        createOutput: "",
        buildId: "unused",
        extractBuiltImageRef: vi.fn(),
        resolveSandboxImageTagFromCreateOutput: vi.fn(),
      }).workloadReceipt,
    ).toEqual({
      schemaVersion: 1,
      kind: "legacy-dockerfile",
      reference: "nemoclaw-future-harness:local",
      packageStartupProfile: {
        encodedProfile: built.encodedProfile,
        startupProfileSha256: built.startupProfileSha256,
        credentialProxyReplayRequired: built.credentialProxyReplayRequired,
      },
      shared: false,
    });
    expect(prepareStartupProfile).toHaveBeenCalledOnce();
    expect(buildInitialStartupProfile).toHaveBeenCalledOnce();
  });

  it("uses the Dockerfile when the stock managed-image catalog is unavailable", async () => {
    const { runtime } = createFreshOnboardingRuntime(
      {},
      { managedRuntimeEnabled: true, unavailableCatalog: true },
    );

    expect(runtime.receiptAgentDefinition).toBeNull();
    await expect(runtime.ensurePreparedWorkload()).resolves.toMatchObject({
      source: { kind: "legacy-dockerfile" },
    });
  });

  it("passes the exact selected package receipt to managed-image preparation", async () => {
    const harnessPackage = {
      kind: "agent-runtime",
      id: "openclaw",
      packageVersion: "1.2.3",
      contentDigest: "8e".repeat(32),
    } as const satisfies HarnessPackageIdentity;
    const { prepared, runtime } = createFreshOnboardingRuntime(
      {},
      {
        managedRuntimeEnabled: true,
        harnessPackage,
        agentDefinition: {
          name: "openclaw",
          managedImage: qualifiedManagedImageDeclaration("openclaw"),
        },
      },
    );

    await expect(runtime.ensurePreparedWorkload()).resolves.toBe(prepared);
    expect(runtime.receiptAgentDefinition?.name).toBe("openclaw");
    expect(prepareSandboxWorkloadSource).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ harnessPackage }),
    );
  });

  it("bypasses legacy candidate qualification for a receipt-backed package", async () => {
    const harnessPackage = {
      kind: "agent-runtime",
      id: "pi",
      packageVersion: "1.2.3",
      contentDigest: "9e".repeat(32),
    } as const satisfies HarnessPackageIdentity;
    const { prepared, runtime } = createFreshOnboardingRuntime(
      {},
      {
        agentName: "pi",
        managedRuntimeEnabled: true,
        harnessPackage,
        agentDefinition: {
          name: "pi",
          managedImage: qualifiedManagedImageDeclaration("pi"),
        },
      },
    );

    await expect(runtime.ensurePreparedWorkload()).resolves.toBe(prepared);
    expect(prepareSandboxWorkloadSource).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ acceptedCandidateContract: null, harnessPackage }),
    );
  });

  it("requires receipt-pinned manifest authority before package startup", () => {
    const harnessPackage = {
      kind: "agent-runtime",
      id: "openclaw",
      packageVersion: "1.2.3",
      contentDigest: "8e".repeat(32),
    } as const satisfies HarnessPackageIdentity;

    expect(() =>
      createFreshOnboardingRuntime({}, { managedRuntimeEnabled: true, harnessPackage }),
    ).toThrow(/receipt-pinned agent definition/u);
  });

  it("rejects an unavailable catalog for explicit temporary managed-image onboarding", async () => {
    const { runtime } = createFreshOnboardingRuntime(
      {},
      { managedRuntimeEnabled: true, tempManagedRuntime: true, unavailableCatalog: true },
    );

    await expect(runtime.ensurePreparedWorkload()).rejects.toThrow("registry offline");
  });

  it("treats an explicit temporary catalog as strict managed-image selection", async () => {
    const { prepared, runtime } = createFreshOnboardingRuntime(
      {},
      { tempManagedRuntimeCatalog: "/tmp/pi-candidate-catalog.json" },
    );

    await expect(runtime.ensurePreparedWorkload()).resolves.toBe(prepared);
    expect(prepareSandboxWorkloadSource).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        catalogPath: "/tmp/pi-candidate-catalog.json",
        runtime: expect.objectContaining({
          driverName: "docker",
          managedImages: expect.objectContaining({
            exactDigestReferences: true,
          }),
        }),
      }),
    );
  });

  it("selects only the shipped Hermes Dockerfile fallback without profile or prebuild work", async () => {
    const expectedDockerfilePath = "/workspace/packages/nemoclaw-hermes/Dockerfile";
    const ensurePreparedProfile = vi.fn(() => null);
    const prepared = {
      source: {
        kind: "legacy-dockerfile" as const,
        dockerfilePath: expectedDockerfilePath,
        reason: "runtime-unsupported" as const,
      },
      release: "v0.0.0",
      fallbackDiagnostic: null,
    };
    const runtime = {
      runtimeProvider: null,
      receiptAgentDefinition: null,
      ensurePreparedWorkload: vi.fn(async () => prepared),
      ensurePreparedProfile,
    };

    await expect(
      prepareHermesPortableSandboxWorkloadForLifecycle(runtime, expectedDockerfilePath),
    ).resolves.toBe(prepared);
    expect(ensurePreparedProfile).not.toHaveBeenCalled();

    await expectUnsupportedHermesPortableSources(runtime, prepared, expectedDockerfilePath);
  });

  it("keeps failure cleanup armed until the caller commits registration", () => {
    const docker = createHermesStateVolumeDockerHarness();
    let exitCleanup: (() => void) | null = null;

    const lifecycle = createManagedStateVolumeOnboardLifecycle(
      {
        roots: managedStartupStateRoots({
          packageId: "hermes",
          sandboxName: "alpha",
          managedImage: {
            ...qualifiedManagedImageDeclaration("hermes"),
            runtime_identity: { uid: 1000, gid: 1000, workdir: "/sandbox" },
          },
        }),
        runtimeProvider: {
          identity: { id: "docker" },
          workload: { managedStateMountDriverId: "docker" },
          containerEngine: {
            supported: true,
            identities: [
              { operation: "sandbox-lifecycle", engineId: "docker", displayName: "Docker" },
            ],
          },
        } as never,
      },
      {
        runContainerEngine: docker.runDocker as never,
        registerExitCleanup: (cleanup) => {
          exitCleanup = cleanup;
          return vi.fn();
        },
      },
    );

    lifecycle.materializeSandboxCreatePlan({} as never, (input) => {
      expect(input.managedStateMounts).toEqual([
        expect.objectContaining({ target: "/sandbox/.hermes" }),
      ]);
      expect(input.managedStateMountDriverId).toBe("docker");
      return {} as never;
    });
    exitCleanup!();

    expect(docker.volume).toBeNull();
    expect(docker.calls.some((args) => args[0] === "rm")).toBe(true);
  });

  it("retains the live qualification catalog revision during fresh onboarding (#9385)", async () => {
    const catalogRevision = "a".repeat(40);
    const { prepared, runtime } = createFreshOnboardingRuntime(
      {
        GITHUB_ACTIONS: "true",
        E2E_MANAGED_IMAGE_REVISION: catalogRevision,
      },
      { managedRuntimeEnabled: true },
    );

    await expect(runtime.ensurePreparedWorkload()).resolves.toBe(prepared);
    expect(prepareSandboxWorkloadSource).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ catalogRevision }),
    );
  });

  it("does not apply the stock cohort revision outside stock onboarding", async () => {
    const { prepared, runtime } = createFreshOnboardingRuntime({
      GITHUB_ACTIONS: "true",
      E2E_MANAGED_IMAGE_REVISION: "a".repeat(40),
    });

    await expect(runtime.ensurePreparedWorkload()).resolves.toBe(prepared);
    expect(prepareSandboxWorkloadSource).toHaveBeenCalledOnce();
    expect(prepareSandboxWorkloadSource.mock.calls[0]?.[0]).not.toHaveProperty("catalogRevision");
  });

  it("binds fresh onboarding to the exact PR catalog (#9464)", async () => {
    const catalogRevision = "b".repeat(40);
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-live-e2e-catalog-"));
    const catalogPath = path.join(fixtureRoot, "catalog.json");
    fs.writeFileSync(catalogPath, "{}\n", { mode: 0o600 });
    try {
      const { prepared, runtime } = createFreshOnboardingRuntime({
        GITHUB_ACTIONS: "true",
        NEMOCLAW_RUN_LIVE_E2E: "1",
        NEMOCLAW_E2E_EXPECTED_SHA: catalogRevision,
        NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG: catalogPath,
      });

      await expect(runtime.ensurePreparedWorkload()).resolves.toBe(prepared);
      expect(prepareSandboxWorkloadSource).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          catalogPath,
          expectedCatalogRevision: catalogRevision,
        }),
      );
    } finally {
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("retains reused managed-image publication identity for live PR onboarding", async () => {
    const candidateRevision = "b".repeat(40);
    const publicationRevision = "a".repeat(40);
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-live-e2e-catalog-"));
    const catalogPath = path.join(fixtureRoot, "catalog.json");
    fs.writeFileSync(catalogPath, "{}\n", { mode: 0o600 });
    try {
      const { prepared, runtime } = createFreshOnboardingRuntime({
        GITHUB_ACTIONS: "true",
        NEMOCLAW_RUN_LIVE_E2E: "1",
        NEMOCLAW_E2E_EXPECTED_SHA: candidateRevision,
        NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG: catalogPath,
        NEMOCLAW_E2E_MANAGED_IMAGE_REVISION: publicationRevision,
      });

      await expect(runtime.ensurePreparedWorkload()).resolves.toBe(prepared);
      expect(prepareSandboxWorkloadSource).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          catalogPath,
          expectedCatalogRevision: publicationRevision,
        }),
      );
    } finally {
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("omits the qualification catalog revision outside GitHub Actions (#9385)", async () => {
    const { prepared, runtime } = createFreshOnboardingRuntime({
      E2E_MANAGED_IMAGE_REVISION: "a".repeat(40),
    });

    await expect(runtime.ensurePreparedWorkload()).resolves.toBe(prepared);
    expect(prepareSandboxWorkloadSource).toHaveBeenCalledOnce();
    expect(prepareSandboxWorkloadSource.mock.calls[0]?.[0]).not.toHaveProperty("catalogRevision");
  });

  it("retains an exact installed revision outside GitHub Actions", async () => {
    const { prepared, runtime } = createFreshOnboardingRuntime({
      NEMOCLAW_INSTALL_REF: INSTALLED_REVISION,
    });

    await expect(runtime.ensurePreparedWorkload()).resolves.toBe(prepared);
    expect(prepareSandboxWorkloadSource).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ catalogRevision: INSTALLED_REVISION }),
    );
  });

  it("resolves final-image patch metadata after managed build-context staging", async () => {
    const resolutionMetadata = { key: "published-dcode-base" };
    const trustedDockerfile = path.join(
      process.cwd(),
      "packages",
      "nemoclaw-langchain-deepagents-code",
      "Dockerfile",
    );
    const buildAgent = {
      name: "langchain-deepagents-code",
      displayName: "LangChain Deep Agents Code",
      dockerfilePath: trustedDockerfile,
    } as AgentDefinition;
    let staged = false;
    const verifyBuildCtx = vi.fn(() => true);
    const resolvePatchInput = vi.fn(() => {
      expect(staged).toBe(true);
      return {
        fromDockerfile: trustedDockerfile,
        preResolvedBaseImageMetadata: resolutionMetadata,
      } as never;
    });
    const resolveSandboxBuildPatch = vi.fn(async (input: Record<string, unknown>) => {
      expect(input.fromDockerfile).toBeNull();
      expect(input.preResolvedBaseImageMetadata).toBe(resolutionMetadata);
      expect(input.stagedDockerfile).toBe("/tmp/nemoclaw-staged-context/Dockerfile");
      return { buildId: "dcode-build", dashboardRemoteBindPrepared: false };
    });
    const materializeSandboxCreatePlan = vi.fn(() => ({
      activeMessagingChannels: [],
      compatibilityPolicyPath: null,
      createArgs: [
        "--from",
        "/tmp/nemoclaw-staged-context/Dockerfile",
        "--name",
        "dcode",
        "--policy",
        "/tmp/nemoclaw-policy.yaml",
      ],
      gpuRoutePlan: "none",
      initialSandboxPolicy: {
        appliedPresets: [],
        policyPath: "/tmp/nemoclaw-policy.yaml",
      },
      messagingProviders: [],
      sandboxGpuLogMessage: null,
    }));

    await prepareOnboardSandboxWorkloadLaunch({
      runtime: {
        runtimeProvider: null,
        receiptAgentDefinition: null,
        ensurePreparedWorkload: vi.fn(),
        ensurePreparedProfile: vi.fn(),
      },
      workload: {
        source: {
          kind: "legacy-dockerfile",
          dockerfilePath: "packages/nemoclaw-langchain-deepagents-code/Dockerfile",
          reason: "runtime-unsupported",
        },
        release: "v0.0.0",
        fallbackDiagnostic: null,
      },
      legacy: {
        preparedBuildContext: null,
        buildAgent,
        packageRoot: process.cwd(),
        fromDockerfile: trustedDockerfile,
        createAgentSandbox: (selectedAgent: AgentDefinition) => {
          expect(selectedAgent).toBe(buildAgent);
          staged = true;
          return {
            buildCtx: "/tmp/nemoclaw-staged-context",
            stagedDockerfile: "/tmp/nemoclaw-staged-context/Dockerfile",
            baseImageResolutionMetadata: resolutionMetadata,
            verifyBuildCtx,
          };
        },
        resolvePatchInput,
      },
      plan: {
        intent: {},
        rebindMessagingTokenDefs: async () => [],
        runProviderPreDeleteCleanup: vi.fn(),
        upsertMessagingProviders: vi.fn(() => []),
        getHermesToolGatewayProviderName: vi.fn(() => "unused"),
        discloseInitialSandboxPolicy: vi.fn(),
      },
      launchInput: {
        agent: null,
        chatUiUrl: "http://127.0.0.1:18789",
        sandboxName: "dcode",
        env: { NEMOCLAW_SANDBOX_PREBUILD: "0" },
        extraPlaceholderKeys: [],
        getDashboardForwardPort: () => "0",
        hermesDashboardState: {},
        manageDashboard: false,
        openshellShellCommand: () => "openshell sandbox create",
      },
      plannedMessagingPlan: null,
      gpu: {
        provider: "compatible-endpoint",
        config: {
          mode: "0",
          hostGpuDetected: false,
          hostGpuPlatform: null,
          sandboxGpuEnabled: false,
          sandboxGpuDevice: null,
          errors: [],
        },
        dockerDriverGateway: false,
        gatewayPort: 8080,
      },
      dependencies: {
        materializeSandboxCreatePlan,
        prepareSandboxBuildPatchConfig: vi.fn(() => ({
          messagingChannelConfig: null,
        })),
        resolveSandboxBuildPatch,
      },
    } as unknown as Parameters<typeof prepareOnboardSandboxWorkloadLaunch>[0]);

    expect(resolvePatchInput).toHaveBeenCalledOnce();
    expect(resolveSandboxBuildPatch).toHaveBeenCalledOnce();
    expect(verifyBuildCtx).toHaveBeenCalledOnce();
  });
});
