// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
"use strict";
const PACKAGE_ID = "pi";
const PROXY_ENVIRONMENT_NAMES = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
];
const UNSUPPORTED_RUNTIME_INPUTS = [
    "NEMOCLAW_AUTO_PAIR_DEADLINE_SECS",
    "NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS",
    "NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS",
    "NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS",
    "NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS",
    "NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS",
    "NEMOCLAW_DASHBOARD_BIND",
    "NEMOCLAW_MINIMAL_BOOTSTRAP",
];
function fail(message) {
    throw new Error(`Cannot build Pi startup plan: ${message}`);
}
function normalizeStartupRequest(request) {
    if (request.profileKind !== "package")
        return request;
    const keys = Object.keys(request.packageConfig);
    const settings = request.packageConfig.settings;
    if (request.harnessPackage.id !== request.packageId ||
        keys.length !== 1 ||
        keys[0] !== "settings" ||
        typeof settings !== "object" ||
        settings === null ||
        Array.isArray(settings)) {
        fail("receipt-backed package config is inconsistent");
    }
    return {
        packageId: request.packageId,
        settings: { ...settings, corporateCa: request.corporateCa },
        applicationEnvironment: request.applicationEnvironment,
    };
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
function appendHostProxy(environment, request) {
    const proxy = request.settings.proxy;
    const noProxy = proxy.hostNoProxy.join(",");
    Object.assign(environment, {
        HTTP_PROXY: proxy.hostHttpUrl ?? "",
        HTTPS_PROXY: proxy.hostHttpsUrl ?? "",
        NO_PROXY: noProxy,
        http_proxy: proxy.hostHttpUrl ?? "",
        https_proxy: proxy.hostHttpsUrl ?? "",
        no_proxy: noProxy,
    });
}
function buildStartupPlan(adapterRequest) {
    const request = normalizeStartupRequest(adapterRequest);
    const { settings } = request;
    if (request.packageId !== PACKAGE_ID ||
        settings.configuration.agent !== PACKAGE_ID ||
        settings.dashboard.agent !== PACKAGE_ID ||
        settings.dashboard.mode !== "disabled" ||
        settings.messaging.plan !== null) {
        fail("profile state is inconsistent");
    }
    const configurationEnvironment = {
        NEMOCLAW_CONTEXT_WINDOW: settings.tuning.contextWindow === null ? "" : String(settings.tuning.contextWindow),
        NEMOCLAW_INFERENCE_API: settings.inference.api,
        NEMOCLAW_INFERENCE_BASE_URL: settings.inference.routedBaseUrl,
        NEMOCLAW_INFERENCE_PROVIDER_ID: settings.inference.routeProvider,
        NEMOCLAW_MAX_TOKENS: settings.tuning.maxTokens === null ? "" : String(settings.tuning.maxTokens),
        NEMOCLAW_MODEL: settings.inference.model,
        NEMOCLAW_REASONING: settings.tuning.reasoning === null ? "" : String(settings.tuning.reasoning),
        NEMOCLAW_TOOL_DISCLOSURE: settings.tools.disclosure,
        NEMOCLAW_UPSTREAM_PROVIDER: settings.inference.upstreamProvider,
    };
    appendHostProxy(configurationEnvironment, request);
    const runtimeEnvironment = { ...configurationEnvironment };
    delete runtimeEnvironment.NEMOCLAW_INFERENCE_BASE_URL;
    delete runtimeEnvironment.NEMOCLAW_CONTEXT_WINDOW;
    delete runtimeEnvironment.NEMOCLAW_MAX_TOKENS;
    delete runtimeEnvironment.NEMOCLAW_REASONING;
    for (const name of PROXY_ENVIRONMENT_NAMES)
        delete runtimeEnvironment[name];
    return {
        schemaVersion: 1,
        packageId: PACKAGE_ID,
        configurationEnvironment,
        runtimeEnvironment,
        applicationRuntime: {
            exportEnvironment: {},
            unsetEnvironment: [...UNSUPPORTED_RUNTIME_INPUTS],
        },
        managedState: {
            root: "/sandbox/.pi",
            files: ["agent/fabric.json", "agent/models.json"],
            directories: ["agent"],
        },
        materials: [
            {
                kind: "corporate-ca-handoff",
                legacyInput: "NEMOCLAW_CORPORATE_CA_B64",
                expectedSha256: settings.corporateCa.bundleSha256,
            },
            rootFile("NEMOCLAW_PROXY_HOST", "/usr/local/share/nemoclaw/pi-proxy-host", settings.proxy.managedHost),
            rootFile("NEMOCLAW_PROXY_PORT", "/usr/local/share/nemoclaw/pi-proxy-port", String(settings.proxy.managedPort)),
        ],
        actions: [{ kind: "generate-config", runAs: "sandbox" }],
    };
}
function requireStartupProfileAuthority(request) {
    if (request.packageId !== PACKAGE_ID || request.harnessPackage.id !== PACKAGE_ID) {
        fail("startup profile identity is inconsistent");
    }
}
function preparationValue(request, name) {
    const value = request.input.environment[name];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
function optionalPositiveInteger(request, name, previous, maximum = 1_000_000_000) {
    const raw = preparationValue(request, name);
    if (raw === null)
        return previous;
    if (!/^[1-9][0-9]*$/u.test(raw))
        fail(`${name} must be a positive integer`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value > maximum) {
        fail(`${name} must be no greater than ${String(maximum)}`);
    }
    return value;
}
function prepareStartupProfile(request) {
    requireStartupProfileAuthority(request);
    const input = request.input;
    const candidate = input.inference.candidates.find((entry) => entry.requestedApi === "openai-completions" && entry.api === "openai-completions");
    if (!candidate)
        fail("an OpenAI Completions inference candidate is required");
    if (input.dashboard.managed || input.messagingPlan !== null || input.webSearch !== null) {
        fail("Pi does not support dashboard, messaging, or web-search startup intent");
    }
    if (input.tools.enabledGateways.length > 0)
        fail("Pi does not support tool gateways");
    const previous = request.previousDesiredState;
    const reasoningRaw = preparationValue(request, "NEMOCLAW_REASONING");
    if (reasoningRaw !== null && reasoningRaw !== "true" && reasoningRaw !== "false") {
        fail("NEMOCLAW_REASONING must be true or false");
    }
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
            contextWindow: optionalPositiveInteger(request, "NEMOCLAW_CONTEXT_WINDOW", previous?.tuning.contextWindow ?? null, 4_194_304),
            maxTokens: optionalPositiveInteger(request, "NEMOCLAW_MAX_TOKENS", previous?.tuning.maxTokens ?? null),
            reasoning: reasoningRaw === null ? (previous?.tuning.reasoning ?? null) : reasoningRaw === "true",
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
    requireStartupProfileAuthority(request);
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
    normalizeStartupRequest({
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
