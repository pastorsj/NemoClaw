// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
"use strict";
const PACKAGE_ID = "deepseek-harness";
function fail(message) {
    throw new Error(`Cannot build DeepSeek Harness startup plan: ${message}`);
}
function requirePackageIdentity(request) {
    if (request.packageId !== PACKAGE_ID ||
        (request.harnessPackage !== undefined && request.harnessPackage.id !== PACKAGE_ID)) {
        fail("package identity is inconsistent");
    }
}
function settingsFromRequest(request) {
    requirePackageIdentity(request);
    if (request.profileKind !== "package")
        return request.settings;
    const settings = request.packageConfig.settings;
    if (Object.keys(request.packageConfig).length !== 1 ||
        typeof settings !== "object" ||
        settings === null ||
        Array.isArray(settings)) {
        fail("receipt-backed package config is inconsistent");
    }
    return { ...settings, corporateCa: request.corporateCa };
}
function rootFile(legacyInput, path, value) {
    return {
        kind: "root-owned-file",
        legacyInput,
        path,
        contents: `${value}\n`,
        owner: "root",
        group: "root",
        mode: 0o444,
    };
}
function assertSupportedSettings(settings) {
    if (settings.configuration.agent !== PACKAGE_ID ||
        settings.dashboard.agent !== PACKAGE_ID ||
        settings.dashboard.mode !== "disabled" ||
        settings.messaging.plan !== null ||
        settings.tools.enabledGateways.length > 0 ||
        settings.inference.api !== "openai-completions") {
        fail("startup settings request unsupported package behavior");
    }
}
function buildStartupPlan(request) {
    const settings = settingsFromRequest(request);
    assertSupportedSettings(settings);
    return {
        schemaVersion: 1,
        packageId: PACKAGE_ID,
        configurationEnvironment: {
            NEMOCLAW_INFERENCE_API: settings.inference.api,
            NEMOCLAW_INFERENCE_BASE_URL: settings.inference.routedBaseUrl,
            NEMOCLAW_MODEL: settings.inference.model,
        },
        runtimeEnvironment: {
            NEMOCLAW_INFERENCE_API: settings.inference.api,
            NEMOCLAW_MODEL: settings.inference.model,
        },
        applicationRuntime: {
            exportEnvironment: {},
            unsetEnvironment: ["NEMOCLAW_DASHBOARD_BIND", "NEMOCLAW_MINIMAL_BOOTSTRAP"],
        },
        managedState: {
            root: "/sandbox/.deepseek-harness",
            files: ["fabric.json"],
            directories: ["sessions", "logs", "cache", "fabric-artifacts"],
        },
        materials: [
            {
                kind: "corporate-ca-handoff",
                legacyInput: "NEMOCLAW_CORPORATE_CA_B64",
                expectedSha256: settings.corporateCa.bundleSha256,
            },
            rootFile("NEMOCLAW_PROXY_HOST", "/usr/local/share/nemoclaw/deepseek-proxy-host", settings.proxy.managedHost),
            rootFile("NEMOCLAW_PROXY_PORT", "/usr/local/share/nemoclaw/deepseek-proxy-port", String(settings.proxy.managedPort)),
        ],
        actions: [{ kind: "generate-config", runAs: "sandbox" }],
    };
}
function prepareStartupProfile(request) {
    requirePackageIdentity(request);
    const input = request.input;
    const candidate = input.inference.candidates.find((entry) => entry.requestedApi === "openai-completions" && entry.api === "openai-completions");
    if (!candidate)
        fail("an OpenAI Completions inference candidate is required");
    if (input.dashboard.managed || input.messagingPlan !== null || input.webSearch !== null) {
        fail("dashboard, messaging, and web search are not supported");
    }
    if (input.tools.enabledGateways.length > 0)
        fail("tool gateways are not supported");
    const desiredState = {
        configuration: { agent: PACKAGE_ID },
        inference: {
            routeProvider: candidate.routeProvider,
            upstreamProvider: input.inference.selectedProvider ?? candidate.routeProvider,
            model: input.inference.model,
            routedBaseUrl: candidate.routedBaseUrl,
            upstreamEndpointUrl: null,
            api: candidate.api,
            primaryModelRef: null,
            compatibility: null,
            inputModalities: null,
        },
        proxy: input.proxy,
        dashboard: { agent: PACKAGE_ID, mode: "disabled" },
        tools: { disclosure: input.tools.disclosure, enabledGateways: [] },
        messaging: { plan: null },
        tuning: {
            contextWindow: null,
            maxTokens: null,
            reasoning: null,
            reasoningEffort: null,
        },
        corporateCa: input.corporateCa,
    };
    buildStartupPlan({ packageId: PACKAGE_ID, settings: desiredState, applicationEnvironment: {} });
    return {
        kind: "prepared",
        desiredState,
        credentialProxyReplayRequired: false,
        dashboardRemoteBindPrepared: false,
    };
}
function packageConfigForDesiredState(request) {
    requirePackageIdentity(request);
    buildStartupPlan({
        packageId: request.packageId,
        settings: request.desiredState,
        applicationEnvironment: {},
    });
    return { settings: request.desiredState };
}
function canonicalStartupJson(value) {
    if (Array.isArray(value))
        return `[${value.map(canonicalStartupJson).join(",")}]`;
    if (value !== null && typeof value === "object") {
        const record = value;
        return `{${Object.keys(record)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalStartupJson(record[key])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value) ?? fail("startup profile contains a non-JSON value");
}
function buildInitialStartupProfile(request) {
    return { kind: "package-config", packageConfig: packageConfigForDesiredState(request) };
}
function reconcileStartupProfile(request) {
    settingsFromRequest({
        profileKind: "package",
        packageId: request.packageId,
        harnessPackage: request.harnessPackage,
        packageConfig: request.currentPackageConfig,
        corporateCa: request.desiredState.corporateCa,
        applicationEnvironment: {},
    });
    const packageConfig = packageConfigForDesiredState(request);
    return {
        kind: "package-config",
        packageConfig,
        changed: canonicalStartupJson(packageConfig) !== canonicalStartupJson(request.currentPackageConfig),
    };
}
const startupAdapter = {
    buildStartupPlan,
    prepareStartupProfile,
    buildInitialStartupProfile,
    reconcileStartupProfile,
};
module.exports = startupAdapter;
