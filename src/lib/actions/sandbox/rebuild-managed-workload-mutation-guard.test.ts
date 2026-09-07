// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { mapManagedStartupProfileToAgentEnvironment as mapManagedStartupProfileWithAdapter } from "../../onboard/managed-startup/agent-environment";
import { managedStartupSettingsFromProfile } from "../../onboard/managed-startup/package-profile";
import type { ManagedStartupProfile } from "../../onboard/managed-startup/profile";
import * as managedWorkload from "../../onboard/workload/rebuild";
import * as registry from "../../state/registry";
import type { SandboxEntry } from "../../state/registry/types";
import {
  managedRebuildProfileDependencies,
  prepareManagedRebuildProfileHandoff,
} from "./agents/managed-workload-rebuild-profile";
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";
import { revalidateManagedWorkloadRebuildBeforeDelete } from "./rebuild-preflight-guards";
import type { RebuildTargetConfig } from "./rebuild-target-preflight";

function mapManagedStartupProfileToAgentEnvironment(
  profile: Parameters<typeof mapManagedStartupProfileWithAdapter>[0],
  environment: Readonly<Record<string, string | undefined>>,
) {
  const filename = path.resolve(`packages/nemoclaw-${profile.agent}/host/startup-adapter.cts`);
  return mapManagedStartupProfileWithAdapter(profile, environment, {
    adapterSource: { filename, source: fs.readFileSync(filename, "utf8") },
  });
}

const entry = {
  name: "alpha",
  openshellDriver: "docker",
} as SandboxEntry;
const handoff = {
  providerId: "docker",
} as managedWorkload.ManagedWorkloadRebuildHandoff;

describe("managed workload rebuild mutation guard", () => {
  it("rebuilds a synthetic receipt-backed package from current authoritative intent", () => {
    const previousProfile = managedStartupE2eProfile("pi");
    const previousDesiredState = {
      ...managedStartupSettingsFromProfile(previousProfile),
      configuration: { agent: "future-harness" },
      dashboard: { agent: "future-harness", mode: "disabled" as const },
    };
    const catalogHandoff = {
      agent: "future-harness",
      harnessPackage: {
        kind: "agent-runtime",
        id: "future-harness",
        packageVersion: "1.2.3",
        contentDigest: "9".repeat(64),
      },
      previousProfile: {
        profileKind: "package",
        desiredState: previousDesiredState,
      },
      previousReceipt: { credentialProxyReplayRequired: false },
      previousDashboardRemoteBindPrepared: false,
      corporateCa: null,
    } as unknown as managedWorkload.PackageManagedWorkloadRebuildCatalogHandoff;
    const targetConfig = {
      agentDefinition: { runtime: { kind: "terminal" } },
      resumeConfig: {
        provider: "nvidia",
        model: "nvidia/new-model",
        preferredInferenceApi: "openai-completions",
        endpointUrl: null,
        compatibleEndpointReasoning: null,
        compatibleEndpointReasoningEffort: null,
      },
      durableConfig: { webSearchConfig: null },
      hermesToolGateways: [],
    } as unknown as RebuildTargetConfig;
    const stage = vi
      .spyOn(managedWorkload, "stagePreparedManagedPackageWorkloadRebuildProfile")
      .mockReturnValue(handoff as managedWorkload.PackageManagedWorkloadRebuildHandoff);
    vi.spyOn(managedRebuildProfileDependencies, "getSandboxInferenceConfig").mockReturnValue({
      providerKey: "inference",
      primaryModelRef: "inference/nvidia/new-model",
      inferenceBaseUrl: "https://inference.local/v1",
      inferenceApi: "openai-completions",
      inferenceCompat: null,
    });

    expect(
      prepareManagedRebuildProfileHandoff({
        catalogHandoff,
        targetConfig,
        recreateOptions: {
          controlUiPort: null,
          toolDisclosure: "direct",
          dcodeAutoApprovalMode: "disabled",
          observabilityEnabled: false,
          dcodeAutoApprovalRequestedExplicitly: false,
          observabilityRequestedExplicitly: false,
        } as RebuildRecreateOnboardOpts,
        messagingPlan: null,
        environment: {},
      }),
    ).toBe(handoff);
    expect(stage).toHaveBeenCalledExactlyOnceWith(
      catalogHandoff,
      expect.objectContaining({
        inference: expect.objectContaining({ model: "nvidia/new-model" }),
        messagingPlan: null,
        toolDisclosure: "direct",
      }),
    );
  });

  it("forwards explicit DCode package controls through startup reconciliation", () => {
    const previousProfile = managedStartupE2eProfile("langchain-deepagents-code");
    const catalogHandoff = {
      agent: "langchain-deepagents-code",
      harnessPackage: {
        kind: "agent-runtime",
        id: "langchain-deepagents-code",
        packageVersion: "1.2.3",
        contentDigest: "9".repeat(64),
      },
      previousProfile: {
        profileKind: "package",
        desiredState: managedStartupSettingsFromProfile(previousProfile),
      },
      previousReceipt: { credentialProxyReplayRequired: false },
      previousDashboardRemoteBindPrepared: false,
      corporateCa: null,
    } as unknown as managedWorkload.LegacyManagedWorkloadRebuildCatalogHandoff;
    const targetConfig = {
      agentDefinition: { runtime: { kind: "terminal" } },
      resumeConfig: {
        provider: "nvidia",
        model: "nvidia/new-model",
        preferredInferenceApi: "openai-completions",
        endpointUrl: "https://integrate.api.nvidia.com/v1",
        compatibleEndpointReasoning: null,
        compatibleEndpointReasoningEffort: null,
      },
      durableConfig: { webSearchConfig: null },
      hermesToolGateways: [],
    } as unknown as RebuildTargetConfig;
    const stage = vi
      .spyOn(managedWorkload, "stagePreparedManagedPackageWorkloadRebuildProfile")
      .mockReturnValue(handoff as managedWorkload.PackageManagedWorkloadRebuildHandoff);
    vi.spyOn(managedRebuildProfileDependencies, "getSandboxInferenceConfig").mockReturnValue({
      providerKey: "inference",
      primaryModelRef: "inference/nvidia/new-model",
      inferenceBaseUrl: "https://inference.local/v1",
      inferenceApi: "openai-completions",
      inferenceCompat: null,
    });

    expect(
      prepareManagedRebuildProfileHandoff({
        catalogHandoff,
        targetConfig,
        recreateOptions: {
          controlUiPort: null,
          toolDisclosure: "direct",
          dcodeAutoApprovalMode: "thread-opt-in",
          observabilityEnabled: true,
          dcodeAutoApprovalRequestedExplicitly: true,
          observabilityRequestedExplicitly: true,
        } as RebuildRecreateOnboardOpts,
        messagingPlan: null,
        toolDisclosureRequestedExplicitly: true,
        environment: {},
      }),
    ).toBe(handoff);
    expect(stage).toHaveBeenCalledWith(
      catalogHandoff,
      expect.objectContaining({
        approvalMode: "thread-opt-in",
        observabilityEnabled: true,
        toolDisclosure: "direct",
      }),
    );
  });

  it("blocks deletion when durable workload authority changes", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue(entry);

    expect(revalidateManagedWorkloadRebuildBeforeDelete("alpha", handoff)).toEqual({
      ok: false,
      message: "Managed workload authority changed before sandbox deletion.",
    });
  });

  it("blocks deletion when the sandbox entry disappeared", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue(null);

    expect(revalidateManagedWorkloadRebuildBeforeDelete("alpha", handoff)).toEqual({
      ok: false,
      message: "Managed workload authority changed before sandbox deletion.",
    });
  });

  it("blocks deletion when the recorded runtime provider is unknown", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      ...entry,
      openshellDriver: "not-a-provider",
    } as SandboxEntry);

    expect(revalidateManagedWorkloadRebuildBeforeDelete("alpha", handoff)).toEqual({
      ok: false,
      message: "Managed workload authority changed before sandbox deletion.",
    });
  });

  it("does not alter legacy rebuild validation", () => {
    expect(revalidateManagedWorkloadRebuildBeforeDelete("alpha", undefined)).toBeNull();
  });

  it("stages compatible-endpoint OpenClaw reasoning authority before deletion", () => {
    const catalogHandoff = {
      agent: "openclaw",
      harnessPackage: null,
      previousProfile: {
        inference: { model: "previous-model", upstreamProvider: "nvidia-prod" },
        dashboard: { agent: "openclaw", bindAddress: "127.0.0.1", wslExposure: false },
      },
    } as unknown as managedWorkload.LegacyManagedWorkloadRebuildCatalogHandoff;
    expect(catalogHandoff.harnessPackage).toBeNull();
    const targetConfig = {
      agentDefinition: {},
      resumeConfig: {
        provider: "compatible-endpoint",
        model: "reasoning-model",
        preferredInferenceApi: "openai-completions",
        endpointUrl: "https://inference.example.test/v1",
        compatibleEndpointReasoning: "true",
        compatibleEndpointReasoningEffort: "high",
      },
      durableConfig: { webSearchConfig: null },
      hermesToolGateways: [],
    } as unknown as RebuildTargetConfig;
    const stage = vi
      .spyOn(managedWorkload, "stageManagedWorkloadRebuildProfile")
      .mockReturnValue(handoff);
    vi.spyOn(managedRebuildProfileDependencies, "resolveContextWindowForModel").mockReturnValue(
      131_072,
    );

    expect(
      prepareManagedRebuildProfileHandoff({
        catalogHandoff,
        targetConfig,
        recreateOptions: {
          controlUiPort: 18_789,
          toolDisclosure: "progressive",
          dcodeAutoApprovalMode: "disabled",
          observabilityEnabled: false,
        } as unknown as RebuildRecreateOnboardOpts,
        messagingPlan: null,
        environment: {},
      }),
    ).toBe(handoff);
    expect(stage).toHaveBeenCalledWith(
      catalogHandoff,
      expect.objectContaining({
        inference: expect.objectContaining({
          model: "reasoning-model",
          upstreamProvider: "compatible-endpoint",
          api: "openai-completions",
        }),
      }),
      {},
      {
        openClawContextWindow: 131_072,
        openClawReasoning: true,
        openClawReasoningEffort: "high",
      },
    );

    vi.spyOn(
      managedRebuildProfileDependencies,
      "resolveManagedStartupInferenceRoute",
    ).mockReturnValue({
      providerKey: "compatible-endpoint",
      primaryModelRef: "reasoning-model",
      inferenceBaseUrl: "http://127.0.0.1:8080/v1",
      inferenceApi: "unsupported-api",
      inferenceCompat: null,
    });
    expect(() =>
      prepareManagedRebuildProfileHandoff({
        catalogHandoff,
        targetConfig,
        recreateOptions: {
          controlUiPort: 18_789,
          toolDisclosure: "progressive",
          dcodeAutoApprovalMode: "disabled",
          observabilityEnabled: false,
        } as unknown as RebuildRecreateOnboardOpts,
        messagingPlan: null,
        environment: {},
      }),
    ).toThrow("Unsupported managed startup inference API 'unsupported-api'.");
  });

  it("rejects a legacy Hermes dashboard before retaining a recorded browser host", () => {
    const previousProfile = managedStartupE2eProfile("hermes");
    const previousDashboard = previousProfile.dashboard as Extract<
      typeof previousProfile.dashboard,
      { readonly agent: "hermes" }
    >;
    expect(previousDashboard.agent).toBe("hermes");
    const browserUrl = "https://secure-link.example/dashboard";
    const catalogHandoff = {
      agent: "hermes",
      harnessPackage: null,
      previousProfile: {
        ...previousProfile,
        dashboard: { ...previousDashboard, browserUrl },
      },
      previousReceipt: { credentialProxyReplayRequired: false },
      corporateCa: null,
    } as unknown as managedWorkload.LegacyManagedWorkloadRebuildCatalogHandoff;
    expect(catalogHandoff.harnessPackage).toBeNull();
    const targetConfig = {
      agentDefinition: {},
      resumeConfig: {
        provider: "nvidia",
        model: previousProfile.inference.model,
        preferredInferenceApi: "openai-completions",
        endpointUrl: null,
        compatibleEndpointReasoning: null,
        compatibleEndpointReasoningEffort: null,
      },
      durableConfig: { webSearchConfig: null },
      hermesToolGateways: [],
    } as unknown as RebuildTargetConfig;
    vi.spyOn(
      managedRebuildProfileDependencies,
      "resolveManagedStartupInferenceRoute",
    ).mockReturnValue({
      providerKey: "inference",
      primaryModelRef: "inference/unused-for-hermes",
      inferenceBaseUrl: "https://inference.local/v1",
      inferenceApi: "openai-completions",
      inferenceCompat: null,
    });
    const recreateOptions = {
      controlUiPort: 29_443,
      toolDisclosure: "progressive",
      dcodeAutoApprovalMode: "disabled",
      observabilityEnabled: false,
    } as unknown as RebuildRecreateOnboardOpts;
    const environment = {
      NEMOCLAW_HERMES_DASHBOARD: "1",
      NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT: "19443",
    };
    const { browserUrl: _browserUrl, ...legacyDashboard } = previousDashboard;
    expect(() =>
      prepareManagedRebuildProfileHandoff({
        catalogHandoff: {
          ...catalogHandoff,
          previousProfile: {
            ...catalogHandoff.previousProfile,
            dashboard: legacyDashboard,
          },
        },
        targetConfig,
        recreateOptions,
        messagingPlan: null,
        environment,
      }),
    ).toThrow(
      "Cannot rebuild the Hermes dashboard because its managed startup profile has no recorded browser URL. Rerun onboarding, then rebuild the sandbox.",
    );

    const prepared = prepareManagedRebuildProfileHandoff({
      catalogHandoff,
      targetConfig,
      recreateOptions,
      messagingPlan: null,
      environment,
    });
    expect(prepared.replacementProfile.profile).not.toHaveProperty("profileKind");
    const replacementProfile = prepared.replacementProfile.profile as ManagedStartupProfile;

    expect(replacementProfile.dashboard).toMatchObject({
      agent: "hermes",
      browserUrl,
      publicPort: 29_443,
      url: "http://127.0.0.1:29443",
    });
    expect(
      mapManagedStartupProfileToAgentEnvironment(replacementProfile, {}).runtimeEnvironment
        .CHAT_UI_URL,
    ).toBe(browserUrl);

    const loopbackBrowserUrl = "http://127.0.0.2:18789/dashboard";
    const loopbackPrepared = prepareManagedRebuildProfileHandoff({
      catalogHandoff: {
        ...catalogHandoff,
        previousProfile: {
          ...catalogHandoff.previousProfile,
          dashboard: { ...previousDashboard, browserUrl: loopbackBrowserUrl },
        },
      },
      targetConfig,
      recreateOptions,
      messagingPlan: null,
      environment,
    });
    expect(loopbackPrepared.replacementProfile.profile).not.toHaveProperty("profileKind");
    const loopbackReplacementProfile = loopbackPrepared.replacementProfile
      .profile as ManagedStartupProfile;

    expect(loopbackReplacementProfile.dashboard).toMatchObject({
      browserUrl: "http://127.0.0.2:29443/dashboard",
      publicPort: 29_443,
    });
    expect(
      mapManagedStartupProfileToAgentEnvironment(loopbackReplacementProfile, {}).runtimeEnvironment
        .CHAT_UI_URL,
    ).toBe("http://127.0.0.2:29443/dashboard");
  });
});
