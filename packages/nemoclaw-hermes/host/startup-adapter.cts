// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
"use strict";
const PACKAGE_ID = "hermes";
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
    throw new Error(`Cannot build Hermes startup plan: ${message}`);
}
function booleanFlag(value) {
    return value ? "1" : "0";
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
function encodedJson(value) {
    return { kind: "canonical-json-base64", value };
}
function jsonObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function appendHostProxy(environment, request) {
    const proxy = request.settings.proxy;
    if (proxy.hostHttpUrl === null && proxy.hostHttpsUrl === null && proxy.hostNoProxy.length === 0) {
        return;
    }
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
function messagingManagedFiles(plan) {
    if (plan === null || !jsonObject(plan))
        return [];
    const files = new Set();
    const addTarget = (target) => {
        if (typeof target !== "string")
            return;
        if (target.startsWith("~/.hermes/"))
            files.add(target.slice("~/.hermes/".length));
        else if (target.startsWith("/sandbox/.hermes/")) {
            files.add(target.slice("/sandbox/.hermes/".length));
        }
    };
    if (Array.isArray(plan.agentRender)) {
        for (const entry of plan.agentRender) {
            if (jsonObject(entry))
                addTarget(entry.target);
        }
    }
    if (Array.isArray(plan.buildSteps)) {
        for (const step of plan.buildSteps) {
            if (!jsonObject(step))
                continue;
            const value = step.value;
            if (jsonObject(value))
                addTarget(value.path);
        }
    }
    return [...files].sort();
}
function buildStartupPlan(adapterRequest) {
    const request = normalizeStartupRequest(adapterRequest);
    const { settings } = request;
    const config = settings.configuration;
    const dashboard = settings.dashboard;
    if (request.packageId !== PACKAGE_ID ||
        config.agent !== PACKAGE_ID ||
        dashboard.agent !== PACKAGE_ID ||
        config.webSearch === undefined) {
        fail("profile state is inconsistent");
    }
    let chatUiUrl = dashboard.browserUrl ?? dashboard.url;
    if (dashboard.mode === "loopback-forwarded") {
        if (dashboard.browserUrl === undefined) {
            fail("dashboard profile has no recorded browser URL; rerun onboarding before starting the sandbox");
        }
        chatUiUrl = dashboard.browserUrl;
    }
    if (chatUiUrl === undefined)
        fail("dashboard.url is required");
    const configurationEnvironment = {
        CHAT_UI_URL: chatUiUrl,
        NEMOCLAW_CONTEXT_WINDOW: settings.tuning.contextWindow === null ? "" : String(settings.tuning.contextWindow),
        NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER: booleanFlag(settings.tools.enabledGateways.length > 0),
        NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64: encodedJson(settings.tools.enabledGateways),
        NEMOCLAW_INFERENCE_API: settings.inference.api,
        NEMOCLAW_INFERENCE_BASE_URL: settings.inference.routedBaseUrl,
        NEMOCLAW_INFERENCE_PROVIDER_ID: settings.inference.routeProvider,
        NEMOCLAW_MODEL: settings.inference.model,
        NEMOCLAW_TOOL_DISCLOSURE: settings.tools.disclosure,
        NEMOCLAW_UPSTREAM_PROVIDER: settings.inference.upstreamProvider,
        NEMOCLAW_WEB_SEARCH_ENABLED: booleanFlag(config.webSearch.enabled),
        NEMOCLAW_WEB_SEARCH_PROVIDER: config.webSearch.provider,
    };
    if (settings.messaging.plan !== null) {
        const { workflow: _workflow, ...imagePlan } = settings.messaging.plan;
        configurationEnvironment.NEMOCLAW_MESSAGING_PLAN_B64 = encodedJson(imagePlan);
    }
    const runtimeEnvironment = {
        ...configurationEnvironment,
        HERMES_BUNDLED_PLUGINS: "/opt/hermes/plugins",
        HERMES_HOME: "/sandbox/.hermes",
        HERMES_LAZY_INSTALL_TARGET: "/sandbox/.hermes/lazy-packages",
        NEMOCLAW_DASHBOARD_PORT: dashboard.publicPort === null || dashboard.publicPort === undefined
            ? ""
            : String(dashboard.publicPort),
        NEMOCLAW_HERMES_DASHBOARD: dashboard.mode === "loopback-forwarded" ? "1" : "0",
        NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT: dashboard.internalPort === null || dashboard.internalPort === undefined
            ? ""
            : String(dashboard.internalPort),
        NEMOCLAW_HERMES_DASHBOARD_PORT: dashboard.publicPort === null || dashboard.publicPort === undefined
            ? ""
            : String(dashboard.publicPort),
        NEMOCLAW_HERMES_DASHBOARD_TUI: booleanFlag(dashboard.tuiEnabled ?? false),
        NEMOCLAW_PROXY_HOST: settings.proxy.managedHost,
        NEMOCLAW_PROXY_PORT: String(settings.proxy.managedPort),
    };
    delete runtimeEnvironment.NEMOCLAW_MESSAGING_PLAN_B64;
    appendHostProxy(runtimeEnvironment, request);
    const messagingMode = settings.messaging.plan === null ? "clear" : "apply";
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
            root: "/sandbox/.hermes",
            files: [
                ...new Set([
                    ".config-hash",
                    ".env",
                    "config.yaml",
                    "fabric.json",
                    ...messagingManagedFiles(settings.messaging.plan),
                ]),
            ].sort(),
            directories: [],
        },
        materials: [
            {
                kind: "corporate-ca-handoff",
                legacyInput: "NEMOCLAW_CORPORATE_CA_B64",
                expectedSha256: settings.corporateCa.bundleSha256,
            },
        ],
        actions: [
            { kind: "apply-messaging", mode: messagingMode, phase: "runtime-setup", runAs: "root" },
            { kind: "generate-config", runAs: "sandbox" },
            {
                kind: "apply-messaging",
                mode: messagingMode,
                phase: "post-agent-install",
                runAs: "sandbox",
            },
            { kind: "seal-config", runAs: "root", committedReplay: "run" },
        ],
    };
}
const startupAdapter = { buildStartupPlan };
module.exports = startupAdapter;
