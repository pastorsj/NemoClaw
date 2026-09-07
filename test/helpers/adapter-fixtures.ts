// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Fixed configuration adapter used by synthetic installable package fixtures. */
export const TEST_CONFIG_ADAPTER_SOURCE = `
"use strict";
module.exports = Object.freeze({
  describeInferenceConfig() {
    return { kind: "unsupported", reason: "Synthetic package configuration is fixed." };
  },
  prepareInferenceConfig() {
    return { kind: "unsupported", reason: "Synthetic package configuration is fixed." };
  },
  prepareConfigUpdate() {
    return { kind: "immutable", reason: "Synthetic package configuration is fixed." };
  },
  classifyConfigUrl() {
    return { allowPrivateUrls: false, allowOpenShellBridge: false };
  },
  describeMutableConfig() {
    return { kind: "not-required", reason: "Synthetic package configuration is immutable." };
  },
});
`;

/** Fixed disabled-messaging adapter used by synthetic installable package fixtures. */
export const TEST_MESSAGING_ADAPTER_SOURCE = `
"use strict";
module.exports = Object.freeze({
  describeMessagingIntegration(request) {
    return {
      kind: "disabled",
      packageId: request.packageId,
      reason: "Synthetic package messaging is disabled.",
    };
  },
});
`;

/** Fixed startup adapter used by synthetic installable package fixtures. */
export const TEST_STARTUP_ADAPTER_SOURCE = `
"use strict";
function settingsFrom(request) {
  const settings = request.profileKind === "package" ? request.packageConfig?.settings : request.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("Synthetic package startup settings are missing.");
  }
  return settings;
}
module.exports = Object.freeze({
  buildStartupPlan(request) {
    const settings = settingsFrom(request);
    return {
      schemaVersion: 1,
      packageId: request.packageId,
      configurationEnvironment: {},
      runtimeEnvironment: {},
      applicationRuntime: { exportEnvironment: {}, unsetEnvironment: [] },
      managedState: { root: "/sandbox/." + request.packageId, files: [], directories: [] },
      materials: [{
        kind: "corporate-ca-handoff",
        legacyInput: "NEMOCLAW_CORPORATE_CA_B64",
        expectedSha256: settings.corporateCa.bundleSha256,
      }],
      actions: [{ kind: "generate-config", runAs: "sandbox" }],
    };
  },
  prepareStartupProfile(request) {
    const candidate = request.input.inference.candidates[0];
    if (!candidate) throw new Error("Synthetic package requires one inference candidate.");
    const desiredState = {
      configuration: { agent: request.packageId },
      inference: {
        routeProvider: candidate.routeProvider,
        upstreamProvider: request.input.inference.selectedProvider || candidate.routeProvider,
        model: request.input.inference.model,
        routedBaseUrl: candidate.routedBaseUrl,
        upstreamEndpointUrl: request.input.inference.endpointUrl,
        api: candidate.api,
        primaryModelRef: candidate.primaryModelRef,
        compatibility: candidate.compatibility,
        inputModalities: null,
      },
      proxy: request.input.proxy,
      dashboard: { agent: request.packageId, mode: "disabled" },
      tools: request.input.tools,
      messaging: { plan: request.input.messagingPlan },
      tuning: {
        contextWindow: request.input.inference.resolvedContextWindow,
        maxTokens: null,
        reasoning: request.input.inference.reasoningEnabled,
        reasoningEffort: request.input.inference.reasoningEffort,
      },
      corporateCa: request.input.corporateCa,
    };
    return {
      kind: "prepared",
      desiredState,
      credentialProxyReplayRequired: false,
      dashboardRemoteBindPrepared: false,
    };
  },
  buildInitialStartupProfile(request) {
    return { kind: "package-config", packageConfig: { settings: request.desiredState } };
  },
  reconcileStartupProfile(request) {
    const packageConfig = { settings: request.desiredState };
    return {
      kind: "package-config",
      packageConfig,
      changed: JSON.stringify(packageConfig) !== JSON.stringify(request.currentPackageConfig),
    };
  },
});
`;
