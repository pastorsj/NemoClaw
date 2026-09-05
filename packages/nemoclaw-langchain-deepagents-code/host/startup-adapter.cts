// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
"use strict";
const PACKAGE_ID = "langchain-deepagents-code";
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
    throw new Error(`Cannot build LangChain Deep Agents Code startup plan: ${message}`);
}
function booleanFlag(value) {
    return value ? "1" : "0";
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
function buildStartupPlan(request) {
    const { settings } = request;
    const config = settings.configuration;
    if (request.packageId !== PACKAGE_ID ||
        config.agent !== PACKAGE_ID ||
        settings.dashboard.agent !== PACKAGE_ID ||
        settings.dashboard.mode !== "disabled" ||
        settings.messaging.plan !== null ||
        config.autoApprovalMode === undefined ||
        config.observabilityEnabled === undefined) {
        fail("profile state is inconsistent");
    }
    const reasoningEffort = settings.tuning.reasoningEffort === null || settings.tuning.reasoningEffort === "default"
        ? ""
        : settings.tuning.reasoningEffort;
    const configurationEnvironment = {
        NEMOCLAW_INFERENCE_API: settings.inference.api,
        NEMOCLAW_INFERENCE_BASE_URL: settings.inference.routedBaseUrl,
        NEMOCLAW_INFERENCE_PROVIDER_ID: settings.inference.routeProvider,
        NEMOCLAW_MODEL: settings.inference.model,
        NEMOCLAW_REASONING_EFFORT: reasoningEffort,
        NEMOCLAW_TOOL_DISCLOSURE: settings.tools.disclosure,
        NEMOCLAW_UPSTREAM_ENDPOINT_URL: settings.inference.upstreamEndpointUrl ?? "",
        NEMOCLAW_UPSTREAM_PROVIDER: settings.inference.upstreamProvider,
    };
    appendHostProxy(configurationEnvironment, request);
    const runtimeEnvironment = {
        ...configurationEnvironment,
        NEMOCLAW_OBSERVABILITY: booleanFlag(config.observabilityEnabled),
    };
    delete runtimeEnvironment.NEMOCLAW_INFERENCE_BASE_URL;
    delete runtimeEnvironment.NEMOCLAW_REASONING_EFFORT;
    delete runtimeEnvironment.NEMOCLAW_UPSTREAM_PROVIDER;
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
        materials: [
            {
                kind: "corporate-ca-handoff",
                legacyInput: "NEMOCLAW_CORPORATE_CA_B64",
                expectedSha256: settings.corporateCa.bundleSha256,
            },
            rootFile("NEMOCLAW_DCODE_AUTO_APPROVAL", "/usr/local/share/nemoclaw/dcode-auto-approval", config.autoApprovalMode),
            rootFile("NEMOCLAW_INFERENCE_BASE_URL", "/usr/local/share/nemoclaw/dcode-inference-base-url", settings.inference.routedBaseUrl),
            rootFile("NEMOCLAW_UPSTREAM_PROVIDER", "/usr/local/share/nemoclaw/dcode-upstream-provider", settings.inference.upstreamProvider),
            rootFile("NEMOCLAW_PROXY_HOST", "/usr/local/share/nemoclaw/dcode-proxy-host", settings.proxy.managedHost),
            rootFile("NEMOCLAW_PROXY_PORT", "/usr/local/share/nemoclaw/dcode-proxy-port", String(settings.proxy.managedPort)),
            rootFile("NEMOCLAW_REASONING_EFFORT", "/usr/local/share/nemoclaw/dcode-reasoning-effort", reasoningEffort),
        ],
        actions: [{ kind: "generate-config", runAs: "sandbox" }],
    };
}
const startupAdapter = { buildStartupPlan };
module.exports = startupAdapter;
