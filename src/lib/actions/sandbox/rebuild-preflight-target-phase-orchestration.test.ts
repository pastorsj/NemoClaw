// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxMessagingPlan } from "../../messaging";
import type { ResolvedSandboxAgent } from "../../onboard/sandbox-agent";
import * as registry from "../../state/registry";
import { makeAgent } from "../../../../test/helpers/base-image-test-harness";
import { validateHarnessPackageTree } from "../../agent-runtime/package/tree";

const OPENCLAW_AGENT_AUTHORITY = Object.freeze({
  recordedAgent: null,
  effectiveAgentId: "openclaw",
  definition: Object.freeze({
    name: "openclaw",
    packageRoot: "/verified/harnesses/openclaw",
  }) as ResolvedSandboxAgent["definition"],
  harnessPackage: Object.freeze({
    kind: "agent-runtime",
    id: "openclaw",
    packageVersion: "1.0.0",
    contentDigest: "a".repeat(64),
  }),
  harnessPackageMigration: null,
}) satisfies ResolvedSandboxAgent;

const mocks = vi.hoisted(() => ({
  bail: vi.fn(),
  ensureRebuildTargetGatewaySelected: vi.fn(async (..._args: unknown[]) => true),
  getMcpPreparationRuntimeSelection: vi.fn(),
  preflightAuthoritativeOnboardRuntime: vi.fn(async (..._args: unknown[]) => false),
  prepareManagedWorkloadRebuildHandoff: vi.fn(),
  prepareSandboxWorkloadSourceFromRebuildHandoff: vi.fn(),
  prepareRebuildTargetConfig: vi.fn(),
  prepareRebuildRecreateOptions: vi.fn(),
  preflightRebuildMessagingConflicts: vi.fn(async () => undefined),
  resolveContextWindowForModel: vi.fn(() => 131_072),
  resolveManagedStartupInferenceRoute: vi.fn(),
  runOpenshell: vi.fn(),
  stageRebuildHermesDashboardConfig: vi.fn((..._args: unknown[]) => true),
  stageRebuildMessagingPlanOrBail: vi.fn(
    async (..._args: unknown[]): Promise<SandboxMessagingPlan | null> => null,
  ),
  stageManagedWorkloadRebuildProfile: vi.fn(),
}));

let temporaryPackageRoot: string | null = null;

function futureHarnessAuthority(
  presetName: string,
  source: string | null,
  owned = true,
): ResolvedSandboxAgent {
  const agentDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-policy-preflight-")),
  );
  temporaryPackageRoot = agentDir;
  const presetDirectory = path.join(agentDir, "policies", "presets");
  fs.mkdirSync(presetDirectory, { recursive: true });
  switch (source) {
    case null:
      break;
    default:
      fs.writeFileSync(path.join(presetDirectory, `${presetName}.yaml`), source, { mode: 0o600 });
  }
  const definition = makeAgent({
    name: "future-harness",
    agentDir,
    packageRoot: agentDir,
    policyCapability: {
      owned_presets: owned ? [presetName] : [],
      automatic_presets: [],
      baseline_exclusion_impacts: {},
    },
  });
  return {
    recordedAgent: "future-harness",
    effectiveAgentId: "future-harness",
    definition,
    harnessPackage: {
      kind: "agent-runtime",
      id: "future-harness",
      packageVersion: "1.0.0",
      contentDigest: validateHarnessPackageTree(agentDir, {
        sourceTrust: "mutable",
      }).contentDigest,
    },
    harnessPackageMigration: null,
  };
}

function futureMessagingPlan(
  presetName: string,
  credentialProviderName?: string,
): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName: "alpha",
    agent: "future-harness",
    workflow: "rebuild",
    channels: [
      {
        channelId: "discord",
        displayName: "Discord",
        authMode: "token-paste",
        active: true,
        selected: true,
        configured: true,
        disabled: false,
        inputs: [],
        hooks: [],
      },
    ],
    disabledChannels: [],
    credentialBindings: credentialProviderName
      ? [
          {
            channelId: "discord",
            credentialId: "futureToken",
            sourceInput: "botToken",
            providerName: credentialProviderName,
            providerEnvKey: "FUTURE_TOKEN",
            placeholder: "openshell:resolve:env:FUTURE_TOKEN",
            credentialAvailable: true,
          },
        ]
      : [],
    networkPolicy: {
      presets: [presetName],
      entries: [
        {
          channelId: "discord",
          presetName,
          policyKeys: ["future_transport"],
          source: "manifest",
        },
      ],
    },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

function configureFutureRebuildTarget(agentAuthority: ResolvedSandboxAgent): void {
  mocks.prepareRebuildTargetConfig.mockReturnValue({
    agentAuthority,
    agentDefinition: agentAuthority.definition,
    resumeConfig: {
      provider: "ollama-local",
      model: "future-model",
      preferredInferenceApi: "openai-completions",
      endpointUrl: null,
      compatibleEndpointReasoning: null,
      compatibleEndpointReasoningEffort: null,
      registryInferenceRoute: null,
    },
    durableConfig: {
      toolDisclosure: "progressive",
      dcodeAutoApprovalMode: "disabled",
      webSearchConfig: null,
    },
    credentialEnv: null,
    fromDockerfile: null,
    hermesToolGateways: [],
  });
  mocks.prepareRebuildRecreateOptions.mockReturnValue({
    controlUiPort: null,
    targetGatewayName: "nemoclaw",
    toolDisclosure: "progressive",
    dcodeAutoApprovalMode: "disabled",
    observabilityEnabled: false,
  });
}

vi.mock("../../adapters/openshell/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/openshell/runtime")>()),
  runOpenshell: mocks.runOpenshell,
}));

vi.mock("./rebuild-flow-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rebuild-flow-helpers")>()),
  ensureRebuildTargetGatewaySelected: mocks.ensureRebuildTargetGatewaySelected,
}));

vi.mock("./rebuild-mcp-phase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rebuild-mcp-phase")>()),
  getMcpPreparationRuntimeSelection: mocks.getMcpPreparationRuntimeSelection,
}));

vi.mock("../../onboard/workload/rebuild", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../onboard/workload/rebuild")>()),
  prepareManagedWorkloadRebuildHandoff: mocks.prepareManagedWorkloadRebuildHandoff,
  prepareSandboxWorkloadSourceFromRebuildHandoff:
    mocks.prepareSandboxWorkloadSourceFromRebuildHandoff,
  stageManagedWorkloadRebuildProfile: mocks.stageManagedWorkloadRebuildProfile,
}));

vi.mock("../../onboard/runtime-provider/access", () => ({
  requireRuntimeProviderBundleForSandbox: vi.fn(() => ({ identity: { id: "docker" } })),
}));

vi.mock("../../onboard/workload/runtime", () => ({
  resolveSandboxWorkloadRuntimeCapabilities: vi.fn(() => ({})),
}));

vi.mock("./rebuild-target-preflight", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rebuild-target-preflight")>()),
  hydrateMessagingConfigForRebuild: vi.fn(),
  preflightAuthoritativeOnboardRuntime: mocks.preflightAuthoritativeOnboardRuntime,
  prepareRebuildRecreateOptions: mocks.prepareRebuildRecreateOptions,
  prepareRebuildTargetConfig: mocks.prepareRebuildTargetConfig,
  stageRebuildHermesDashboardConfig: mocks.stageRebuildHermesDashboardConfig,
}));

vi.mock("./rebuild-messaging-phase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rebuild-messaging-phase")>()),
  stageRebuildMessagingPlanOrBail: mocks.stageRebuildMessagingPlanOrBail,
}));

vi.mock("./rebuild-messaging-conflict-preflight", () => ({
  preflightRebuildMessagingConflicts: mocks.preflightRebuildMessagingConflicts,
}));

import { managedRebuildProfileDependencies } from "./agents/managed-workload-rebuild-profile";
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";
import { prepareRebuildTargetPreflights } from "./rebuild-preflight-target-phase";

describe("prepareRebuildTargetPreflights", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    switch (temporaryPackageRoot) {
      case null:
        break;
      default:
        fs.rmSync(temporaryPackageRoot, { recursive: true, force: true });
        temporaryPackageRoot = null;
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(registry, "getSandbox").mockReturnValue(null);
    mocks.getMcpPreparationRuntimeSelection.mockReturnValue({
      gatewayName: "nemoclaw",
      localTlsDir: "/authority/tls",
      workspace: "default",
    });
    mocks.prepareManagedWorkloadRebuildHandoff.mockResolvedValue(null);
    mocks.preflightAuthoritativeOnboardRuntime.mockResolvedValue(false);
    mocks.ensureRebuildTargetGatewaySelected.mockResolvedValue(true);
    mocks.stageRebuildMessagingPlanOrBail.mockResolvedValue(null);
  });

  it.each([
    {
      name: "missing",
      source: null,
      owned: true,
      expected: "package asset is unavailable",
    },
    {
      name: "unowned",
      source: [
        "preset:",
        "  name: future-channel-egress",
        '  description: "Unowned source"',
        "network_policies:",
        "  future_transport: {}",
        "",
      ].join("\n"),
      owned: false,
      expected: "does not own required messaging policy preset",
    },
    {
      name: "malformed",
      source: "preset: [\n",
      owned: true,
      expected: "contains invalid YAML",
    },
    {
      name: "key mismatch",
      source: [
        "preset:",
        "  name: future-channel-egress",
        '  description: "Wrong key"',
        "network_policies:",
        "  another_transport: {}",
        "",
      ].join("\n"),
      owned: true,
      expected: "does not provide declared network policy key 'future_transport'",
    },
    {
      name: "credential provider outside the plan",
      source: [
        "preset:",
        "  name: future-channel-egress",
        '  description: "Wrong provider"',
        "network_policies:",
        "  future_transport:",
        "    endpoints:",
        "      - host: future.example.test",
        "        port: 443",
        "        credential_binding:",
        "          provider: unowned-provider",
        "    binaries: []",
        "",
      ].join("\n"),
      owned: true,
      expected: "outside its typed package plan",
    },
  ])(
    "rejects a $name receipt policy before the caller can enter backup or delete",
    async ({ source, owned, expected }) => {
      const presetName = "future-channel-egress";
      const agentAuthority = futureHarnessAuthority(presetName, source, owned);
      const messagingPlan = futureMessagingPlan(presetName);
      configureFutureRebuildTarget(agentAuthority);
      mocks.stageRebuildMessagingPlanOrBail.mockResolvedValue(messagingPlan);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      try {
        await expect(
          prepareRebuildTargetPreflights({
            sandboxName: "alpha",
            sandboxEntry: {
              name: "alpha",
              agent: "future-harness",
              gatewayName: "nemoclaw",
              openshellDriver: "docker",
            } as never,
            agentAuthority,
            autoYes: true,
            log: vi.fn(),
            bail: mocks.bail as never,
          }),
        ).resolves.toBeNull();

        expect(mocks.bail).toHaveBeenCalledWith("Package messaging policy preflight failed");
        expect(errorSpy.mock.calls.flat().map(String)).toContainEqual(
          expect.stringContaining(expected),
        );
        expect(mocks.preflightRebuildMessagingConflicts).not.toHaveBeenCalled();
        expect(mocks.preflightAuthoritativeOnboardRuntime).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    },
  );

  it("recovers the gateway before rejecting a missing receipt messaging provider", async () => {
    const presetName = "future-channel-egress";
    const agentAuthority = futureHarnessAuthority(
      presetName,
      [
        "preset:",
        `  name: ${presetName}`,
        '  description: "Future channel"',
        "network_policies:",
        "  future_transport: {}",
        "",
      ].join("\n"),
    );
    configureFutureRebuildTarget(agentAuthority);
    mocks.stageRebuildMessagingPlanOrBail.mockResolvedValue(
      futureMessagingPlan(presetName, "alpha-future-bridge"),
    );
    mocks.preflightAuthoritativeOnboardRuntime.mockResolvedValue(true);
    mocks.runOpenshell.mockReturnValue({
      status: 1,
      stderr: "provider 'alpha-future-bridge' not found",
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      prepareRebuildTargetPreflights({
        sandboxName: "alpha",
        sandboxEntry: {
          name: "alpha",
          agent: "future-harness",
          gatewayName: "nemoclaw",
          openshellDriver: "docker",
        } as never,
        agentAuthority,
        autoYes: true,
        log: vi.fn(),
        bail: mocks.bail as never,
      }),
    ).resolves.toBeNull();

    expect(mocks.preflightAuthoritativeOnboardRuntime).toHaveBeenCalledOnce();
    expect(mocks.ensureRebuildTargetGatewaySelected).toHaveBeenCalledOnce();
    expect(mocks.runOpenshell).toHaveBeenCalledOnce();
    expect(mocks.preflightAuthoritativeOnboardRuntime.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runOpenshell.mock.invocationCallOrder[0],
    );
    expect(mocks.ensureRebuildTargetGatewaySelected.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runOpenshell.mock.invocationCallOrder[0],
    );
    expect(mocks.bail).toHaveBeenCalledWith("Package messaging provider preflight failed");
  });

  async function prepareN1xTarget(
    endpointSource: "onboard" | "inference-set" | null,
    mcp: { bridges: Record<string, { server: string }> } | null = null,
    provider = "vllm-local",
    model = "nvidia/Qwen3.6-35B-A3B-NVFP4",
    nimContainer: string | null = null,
    accepted = endpointSource === null,
    entryOverrides: {
      endpointUrl?: string | null;
      hostLocalInferenceReceipt?: string | null;
    } = {},
  ) {
    const resumeConfig = {
      provider,
      model,
      preferredInferenceApi: "openai-completions",
      pinEndpoint: true,
      endpointUrl: null,
      compatibleEndpointReasoning: null,
      compatibleEndpointReasoningEffort: null,
      registryInferenceRoute: null,
    };
    mocks.prepareRebuildTargetConfig.mockReturnValue({
      agentDefinition: {},
      resumeConfig,
      durableConfig: {
        toolDisclosure: "progressive",
        dcodeAutoApprovalMode: "disabled",
        webSearchConfig: null,
      },
      credentialEnv: null,
      fromDockerfile: false,
      hermesToolGateways: [],
    });
    mocks.prepareRebuildRecreateOptions.mockReturnValue({
      controlUiPort: 18_789,
      targetGatewayName: "nemoclaw",
      toolDisclosure: "progressive",
      dcodeAutoApprovalMode: "disabled",
      observabilityEnabled: false,
    });

    await prepareRebuildTargetPreflights({
      sandboxName: "my-assistant",
      sandboxEntry: {
        name: "my-assistant",
        agent: "openclaw",
        gatewayName: "nemoclaw",
        openshellDriver: "docker",
        provider: resumeConfig.provider,
        model: resumeConfig.model,
        endpointUrl: endpointSource === null ? null : "http://host.openshell.internal:8000/v1",
        endpointSource,
        nimContainer,
        ...(endpointSource === null && accepted
          ? {
              deferredN1xManagedVllmAccepted: true,
            }
          : {}),
        mcp,
        ...entryOverrides,
      } as never,
      agentAuthority: OPENCLAW_AGENT_AUTHORITY,
      autoYes: true,
      log: vi.fn(),
      bail: mocks.bail as never,
    });
    return mocks.preflightAuthoritativeOnboardRuntime.mock.calls[0]?.[2] as
      | RebuildRecreateOnboardOpts
      | undefined;
  }

  it("resolves the Ollama context window through target preparation", async () => {
    const catalogHandoff = {
      agent: "openclaw",
      previousProfile: {
        inference: { model: "gpt-5.4", upstreamProvider: "openai-api" },
        dashboard: { agent: "openclaw", bindAddress: "127.0.0.1", wslExposure: false },
      },
    };
    const targetConfig = {
      agentDefinition: {},
      resumeConfig: {
        provider: "ollama-local",
        model: "qwen3.5:9b",
        preferredInferenceApi: "openai-completions",
        endpointUrl: null,
        compatibleEndpointReasoning: null,
        compatibleEndpointReasoningEffort: null,
        registryInferenceRoute: null,
      },
      durableConfig: {
        toolDisclosure: "progressive",
        dcodeAutoApprovalMode: "disabled",
        webSearchConfig: null,
      },
      credentialEnv: null,
      fromDockerfile: false,
      hermesToolGateways: [],
    };
    const recreateOptions = {
      controlUiPort: 18_789,
      targetGatewayName: "nemoclaw",
      toolDisclosure: "progressive",
      dcodeAutoApprovalMode: "disabled",
      observabilityEnabled: false,
    };
    mocks.prepareManagedWorkloadRebuildHandoff.mockResolvedValue(catalogHandoff);
    mocks.prepareRebuildTargetConfig.mockReturnValue(targetConfig);
    mocks.prepareRebuildRecreateOptions.mockReturnValue(recreateOptions);
    mocks.stageManagedWorkloadRebuildProfile.mockReturnValue({ providerId: "docker" });
    vi.spyOn(managedRebuildProfileDependencies, "resolveContextWindowForModel").mockImplementation(
      mocks.resolveContextWindowForModel,
    );
    vi.spyOn(
      managedRebuildProfileDependencies,
      "resolveManagedStartupInferenceRoute",
    ).mockImplementation(mocks.resolveManagedStartupInferenceRoute);
    mocks.resolveManagedStartupInferenceRoute.mockReturnValue({
      providerKey: "inference",
      primaryModelRef: "inference/qwen3.5:9b",
      inferenceBaseUrl: "https://inference.local/v1",
      inferenceApi: "openai-completions",
      inferenceCompat: {},
    });

    await expect(
      prepareRebuildTargetPreflights({
        sandboxName: "alpha",
        sandboxEntry: {
          name: "alpha",
          agent: "openclaw",
          gatewayName: "nemoclaw",
          openshellDriver: "docker",
          workload: { kind: "managed-image" },
        } as never,
        agentAuthority: OPENCLAW_AGENT_AUTHORITY,
        autoYes: true,
        log: vi.fn(),
        bail: mocks.bail as never,
      }),
    ).resolves.toBeNull();
    expect(mocks.resolveContextWindowForModel).toHaveBeenCalledWith("ollama-local", "qwen3.5:9b");
  });

  it("passes exact legacy N1x intent into authoritative readiness (#9292)", async () => {
    const readinessOptions = await prepareN1xTarget("onboard");

    expect(mocks.prepareRebuildTargetConfig.mock.calls[0]?.[2]).toBe(OPENCLAW_AGENT_AUTHORITY);
    expect(mocks.prepareRebuildRecreateOptions.mock.calls[0]?.[2]).toBe(OPENCLAW_AGENT_AUTHORITY);
    expect(mocks.stageRebuildHermesDashboardConfig.mock.calls[0]?.[0]).toBe(
      OPENCLAW_AGENT_AUTHORITY,
    );
    expect(mocks.stageRebuildMessagingPlanOrBail.mock.calls[0]?.[2]).toBe(OPENCLAW_AGENT_AUTHORITY);
    expect(readinessOptions).toEqual(
      expect.objectContaining({ allowDeferredN1xManagedVllm: true }),
    );
  });

  it("passes normalized N1x Express intent into readiness (#10959)", async () => {
    const readinessOptions = await prepareN1xTarget(null);

    expect(readinessOptions).toEqual(
      expect.objectContaining({ allowDeferredN1xManagedVllm: true }),
    );
  });

  it("passes explicit v0.0.119 recovery intent into readiness (#10959)", async () => {
    vi.stubEnv("NEMOCLAW_PROVIDER", "install-vllm");
    const readinessOptions = await prepareN1xTarget(null, null, undefined, undefined, null, false);

    expect(readinessOptions).toEqual(
      expect.objectContaining({ allowDeferredN1xManagedVllm: true }),
    );
  });

  it.each([
    ["a recorded endpoint", null, null, { endpointUrl: "http://host.openshell.internal:8000/v1" }],
    ["another endpoint source", "inference-set", null, {}],
    ["a NIM container", null, "nemoclaw-nim", {}],
    ["a malformed receipt", null, null, { hostLocalInferenceReceipt: "invalid" }],
  ] as const)(
    "withholds explicit recovery for %s (#10959)",
    async (_case, source, nim, overrides) => {
      vi.stubEnv("NEMOCLAW_PROVIDER", "install-vllm");
      const readinessOptions = await prepareN1xTarget(
        source,
        null,
        undefined,
        undefined,
        nim,
        false,
        overrides,
      );

      expect(readinessOptions).not.toHaveProperty("allowDeferredN1xManagedVllm");
    },
  );

  it("passes recorded Ollama intent into authoritative readiness (#11041)", async () => {
    const readinessOptions = await prepareN1xTarget("onboard", null, "ollama-local", "qwen3.5:9b");

    expect(readinessOptions).toEqual(
      expect.objectContaining({ allowDeferredN1xManagedVllm: true }),
    );
  });

  it("withholds recorded Local NIM intent from authoritative readiness (#11041)", async () => {
    const readinessOptions = await prepareN1xTarget(
      "onboard",
      null,
      "vllm-local",
      "nvidia/Qwen3.6-35B-A3B-NVFP4",
      "nemoclaw-nim",
    );

    expect(readinessOptions).not.toHaveProperty("allowDeferredN1xManagedVllm");
  });

  it("withholds N1x intent for a mismatched endpoint source (#9292)", async () => {
    const readinessOptions = await prepareN1xTarget("inference-set");

    expect(readinessOptions).not.toHaveProperty("allowDeferredN1xManagedVllm");
  });

  it("freezes one MCP runtime target before authoritative readiness (#10514)", async () => {
    const runtimeSelection = {
      gatewayName: "nemoclaw",
      localTlsDir: "/authority/tls",
      workspace: "default",
    };
    mocks.getMcpPreparationRuntimeSelection.mockReturnValue(runtimeSelection);

    const readinessOptions = await prepareN1xTarget("onboard", {
      bridges: { github: { server: "github" } },
    });

    expect(mocks.getMcpPreparationRuntimeSelection).toHaveBeenCalledOnce();
    expect(readinessOptions?.runtimeSelection).toBe(runtimeSelection);
  });
});
