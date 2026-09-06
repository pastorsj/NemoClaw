// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { trackGuardedSandboxNameDelete } from "../fixtures/cleanup.ts";
import { testTimeout } from "../../helpers/timeouts.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import {
  createPrivateTestHome,
  requireIsolatedTestGateway,
} from "../fixtures/environment-profiles.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { trackIsolatedGatewayCleanup } from "../fixtures/gateway-cleanup.ts";
import { readBundledFabricHarnessE2eFixture } from "../../../tools/e2e/fabric-target.mts";
import { DEFAULT_HOSTED_INFERENCE_BASE_URL } from "../fixtures/hosted-inference.ts";
import { inferenceResponseModel } from "../fixtures/inference-switch-retry.ts";
import {
  apiKeyShape,
  chatContent,
  cleanupHermesSwitch,
  compatibleAnthropicMetadataArgs,
  env,
  envHash,
  expectAuthenticatedBaselineInventoryRequest,
  expectAuthenticatedProxyResolutionRequests,
  expectedApiMode,
  expectedBaseUrl,
  expectOpenAiProvider,
  hasAuthenticatedProxyResolutionRequest,
  hashCheck,
  hermesApiCommand,
  hermesGatewayPid,
  hostedInstallModel,
  inferenceLocalCommand,
  inferenceLocalMaxTokens,
  installHermes,
  maybeAssertEnvHashStable,
  maybeAssertPidStable,
  mockAnthropicSwitchEnabled,
  PROXY_FORBIDDEN_MARKERS,
  PROXY_RESOLUTION_PROVIDER,
  parseHermesModelBlock,
  parseInferenceRoute,
  prepareCompatibleAnthropicSwitchBinding,
  prepareProxyResolutionRoute,
  RUNTIME_SWITCH_API,
  registryState,
  runHermesCliPongWithRetry,
  runHermesInferenceSetWithRetry,
  runHermesPongWithRetry,
  SANDBOX_NAME,
  SWITCH_API,
  SWITCH_MODEL,
  SWITCH_PROVIDER,
  strictHashPerms,
} from "./hermes-inference-switch-helpers.ts";
import {
  PUBLIC_NVIDIA_SWITCH_PROVIDER,
  registerPublicNvidiaSwitchProvider,
  requirePublicNvidiaSwitchKey,
} from "./public-nvidia-switch-provider.ts";
import { runPublicFabricTurn } from "./public-fabric-turn.ts";

const TIMEOUT_MS = testTimeout(45 * 60_000);
const HERMES_FABRIC_CONTRACT = readBundledFabricHarnessE2eFixture("hermes");
const MOCK_BASELINE_API_KEY = "hermes-inference-switch-baseline-credential";
const MOCK_BASELINE_MODEL = "hermes-inference-switch-baseline-model";
const HERMES_DASHBOARD_INTERNAL_PORT =
  process.env.NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT ?? "19119";

function canonicalEndpoint(value: unknown): string | null {
  return typeof value === "string" ? new URL(value).toString() : null;
}

test(
  "Hermes inference set updates route/config and preserves live runtime",
  {
    timeout: TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "prepare clean Hermes inference sandbox",
        "install baseline Hermes runtime",
        "switch Hermes inference provider",
        "validate switched route and mutable config",
        "exercise inference.local and Hermes API",
        "run Hermes CLI adapter forms against switched provider",
        "prove split provider/model credential resolution",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox, secrets }) => {
    const testGateway = requireIsolatedTestGateway();
    const gatewayName = testGateway.name;
    const gatewayPort = Number(testGateway.environment.NEMOCLAW_GATEWAY_PORT);
    const home = createPrivateTestHome(".nemoclaw-hermes-switch-home-");
    trackIsolatedGatewayCleanup(cleanup, host, {
      artifactName: "cleanup-hermes-inference-switch-gateway",
      environment: env(undefined, {}, home),
      gatewayName,
      gatewayPort,
      home,
      timeoutMs: 60_000,
    });
    await artifacts.target.declare({
      id: "hermes-inference-switch",
      boundary:
        "install.sh + Hermes sandbox + inference set + in-sandbox health/chat + managed Hermes CLI probes",
      sandboxName: SANDBOX_NAME,
      switchProvider: SWITCH_PROVIDER,
      switchModel: SWITCH_MODEL,
      switchApi: SWITCH_API,
      runtimeSwitchApi: RUNTIME_SWITCH_API,
    });

    const commandEnv = (apiKey?: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv =>
      env(apiKey, extra, home);
    const cleanupEnv = commandEnv();
    // Cleanup is LIFO: raw OpenShell deletion must run before NemoClaw destroy.
    cleanup.trackSandbox(host, SANDBOX_NAME, {
      artifactName: "cleanup-nemoclaw-destroy",
      env: cleanupEnv,
      timeoutMs: 120_000,
    });
    const sandboxDeleteGuard = trackGuardedSandboxNameDelete(
      cleanup,
      `delete OpenShell sandbox ${SANDBOX_NAME}`,
      () =>
        sandbox.cleanupSandbox(SANDBOX_NAME, {
          artifactName: "cleanup-openshell-delete",
          env: cleanupEnv,
          timeoutMs: 60_000,
        }),
    );
    await cleanupHermesSwitch(host, sandbox, home);

    await runtimeProvider.requireAvailable({
      artifactName: "runtime-info",
      scenarioLabel: "Hermes inference switch",
    });

    // OpenShell reaches this fixture from its gateway network namespace, where
    // the runner's loopback address is not routable.
    const mockBaseline = mockAnthropicSwitchEnabled()
      ? await startFakeOpenAiCompatibleServer({
          apiKey: MOCK_BASELINE_API_KEY,
          chatContent: "PONG",
          forbiddenMarkers: PROXY_FORBIDDEN_MARKERS,
          host: "0.0.0.0",
          model: MOCK_BASELINE_MODEL,
          publicHost: "host.openshell.internal",
          progress,
          requireAuth: true,
        })
      : undefined;
    cleanup.trackDisposable("close Hermes inference switch baseline fixture", async () => {
      await artifacts.writeJson(
        "baseline-openai-compatible-requests.json",
        mockBaseline?.requests() ?? [],
      );
      await mockBaseline?.close();
    });
    const apiKey = mockBaseline
      ? MOCK_BASELINE_API_KEY
      : secrets.required("NVIDIA_INFERENCE_API_KEY");
    const publicApiKey =
      SWITCH_PROVIDER === PUBLIC_NVIDIA_SWITCH_PROVIDER
        ? requirePublicNvidiaSwitchKey(secrets.required("NVIDIA_API_KEY"))
        : null;
    const redactionValues = [apiKey, publicApiKey].filter(
      (value): value is string => typeof value === "string",
    );
    const installEnv: NodeJS.ProcessEnv = {
      NEMOCLAW_HERMES_DASHBOARD: "1",
      NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT: HERMES_DASHBOARD_INTERNAL_PORT,
      ...(mockBaseline
        ? {
            COMPATIBLE_API_KEY: apiKey,
            NEMOCLAW_COMPAT_MODEL: MOCK_BASELINE_MODEL,
            NEMOCLAW_ENDPOINT_URL: mockBaseline.baseUrl,
            NEMOCLAW_MODEL: MOCK_BASELINE_MODEL,
            NEMOCLAW_PREFERRED_API: "openai-completions",
            NEMOCLAW_PROVIDER: "custom",
          }
        : {}),
    };

    progress.phase("install baseline Hermes runtime");
    const install = await installHermes(host, apiKey, installEnv, home);
    sandboxDeleteGuard.observeLifecycleResult(install);
    expect(install.exitCode, resultText(install)).toBe(0);
    expectAuthenticatedBaselineInventoryRequest(mockBaseline);
    const baselineRoute = await sandbox.openshell(["inference", "get", "-g", gatewayName], {
      artifactName: "openshell-inference-route-before-switch",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(baselineRoute.exitCode, resultText(baselineRoute)).toBe(0);
    expect(parseInferenceRoute(resultText(baselineRoute))).toEqual({
      provider: "compatible-endpoint",
      model: hostedInstallModel(installEnv),
    });
    const publicProvider = publicApiKey
      ? await registerPublicNvidiaSwitchProvider(host, publicApiKey, commandEnv())
      : null;
    publicProvider && expect(publicProvider.exitCode, resultText(publicProvider)).toBe(0);
    const switchBinding = await prepareCompatibleAnthropicSwitchBinding(host, cleanup, home);
    const switchEndpointUrl = switchBinding?.endpointUrl ?? null;
    switchBinding && redactionValues.push(switchBinding.credentialValue);

    const pidBefore = await hermesGatewayPid(sandbox, "pid-before", home);
    const envHashBefore = await envHash(sandbox, "env-hash-before", home);

    progress.phase("switch Hermes inference provider");
    const compatibleMetadataArgs = compatibleAnthropicMetadataArgs(switchEndpointUrl);
    const switched = await runHermesInferenceSetWithRetry(
      host,
      redactionValues,
      compatibleMetadataArgs,
      {
        artifacts,
        compatibleBinding: switchBinding,
        home,
      },
    );
    expect(switched.exitCode, resultText(switched)).toBe(0);
    expect(resultText(switched)).not.toContain("writing the in-sandbox config failed");
    expect(resultText(switched)).toContain(`Inference route synced for '${SANDBOX_NAME}'`);
    switchBinding &&
      (await expectOpenAiProvider(
        host,
        "compatible-anthropic-endpoint",
        "COMPATIBLE_ANTHROPIC_API_KEY",
        home,
      ));

    progress.phase("validate switched route and mutable config");
    const pidAfter = await hermesGatewayPid(sandbox, "pid-after", home);
    maybeAssertPidStable(pidBefore, pidAfter, (actual, expected) => expect(actual).toBe(expected));

    const health = await sandbox.exec(
      SANDBOX_NAME,
      ["curl", "-sf", "--max-time", "10", "http://localhost:8642/health"],
      { artifactName: "hermes-health-after-switch", env: commandEnv(), timeoutMs: 30_000 },
    );
    expect(health.exitCode, resultText(health)).toBe(0);
    expect(resultText(health)).toMatch(/ok/i);

    const route = await sandbox.openshell(["inference", "get", "-g", gatewayName], {
      artifactName: "openshell-inference-route",
      env: commandEnv(),
      timeoutMs: 30_000,
    });
    expect(route.exitCode, resultText(route)).toBe(0);
    expect(parseInferenceRoute(resultText(route))).toEqual({
      provider: SWITCH_PROVIDER,
      model: SWITCH_MODEL,
    });

    const config = await sandbox.exec(SANDBOX_NAME, ["cat", "/sandbox/.hermes/config.yaml"], {
      artifactName: "hermes-config-yaml",
      env: commandEnv(),
      redactionValues,
      timeoutMs: 30_000,
    });
    expect(config.exitCode, resultText(config)).toBe(0);
    const model = parseHermesModelBlock(config.stdout);
    expect(model.default).toBe(SWITCH_MODEL);
    expect(model.provider).toBe("custom");
    expect(model.base_url).toBe(expectedBaseUrl());
    expect(model.api_mode).toBe(expectedApiMode());
    expect((await apiKeyShape(sandbox, home)).exitCode).toBe(0);
    expect(config.stdout).not.toMatch(/^models:\s*$/mu);

    const fabricConfig = await sandbox.exec(SANDBOX_NAME, ["cat", "/sandbox/.hermes/fabric.json"], {
      artifactName: "hermes-fabric-config-after-switch",
      env: commandEnv(),
      redactionValues,
      timeoutMs: 30_000,
    });
    expect(fabricConfig.exitCode, resultText(fabricConfig)).toBe(0);
    const fabricModel = (
      JSON.parse(fabricConfig.stdout) as {
        models?: {
          default?: {
            api_key_env?: unknown;
            base_url?: unknown;
            model?: unknown;
            provider?: unknown;
          };
        };
      }
    ).models?.default;
    expect(fabricModel).toEqual({
      api_key_env: "HERMES_FABRIC_API_KEY",
      base_url: expectedBaseUrl(),
      model: SWITCH_MODEL,
      provider: "custom",
    });

    const dashboardConfig = await sandbox.exec(
      SANDBOX_NAME,
      ["cat", "/sandbox/.hermes/profiles/dashboard-home/config.yaml"],
      {
        artifactName: "hermes-dashboard-config-yaml-after-switch",
        env: commandEnv(),
        redactionValues,
        timeoutMs: 30_000,
      },
    );
    expect(dashboardConfig.exitCode, resultText(dashboardConfig)).toBe(0);
    const dashboardModel = parseHermesModelBlock(dashboardConfig.stdout);
    expect(dashboardModel.default).toBe(SWITCH_MODEL);
    expect(dashboardModel.provider).toBe(SWITCH_PROVIDER);
    expect(dashboardModel.base_url).toBe(expectedBaseUrl());
    expect(dashboardModel.api_mode).toBe(expectedApiMode());
    ["approvals", "browser", "session_reset", "display", "updates"].forEach(
      (reviewedPolicySection) => {
        expect(dashboardConfig.stdout).toMatch(new RegExp(`^${reviewedPolicySection}:`, "mu"));
      },
    );

    const dashboardModelInfo = await sandbox.exec(
      SANDBOX_NAME,
      [
        "curl",
        "-sf",
        "--max-time",
        "10",
        `http://127.0.0.1:${HERMES_DASHBOARD_INTERNAL_PORT}/api/model/info`,
      ],
      {
        artifactName: "hermes-dashboard-model-info-after-switch",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(dashboardModelInfo.exitCode, resultText(dashboardModelInfo)).toBe(0);
    expect(JSON.parse(dashboardModelInfo.stdout)).toMatchObject({ model: SWITCH_MODEL });

    const strictHash = await hashCheck(sandbox, "/etc/nemoclaw/hermes.config-hash", "strict", home);
    expect(strictHash.exitCode, resultText(strictHash)).toBe(0);
    expect(strictHash.stdout).toContain("OK");
    const compatHash = await hashCheck(sandbox, "/sandbox/.hermes/.config-hash", "compat", home);
    expect(compatHash.exitCode, resultText(compatHash)).toBe(0);
    expect(compatHash.stdout).toContain("OK");
    const strictPerms = await strictHashPerms(sandbox, home);
    expect(strictPerms.stdout.trim()).toMatch(/^0\s+[0-7]+$/u);
    expect(Number.parseInt(strictPerms.stdout.trim().split(/\s+/u)[1], 8) & 0o222).toBe(0);

    maybeAssertEnvHashStable(
      envHashBefore,
      await envHash(sandbox, "env-hash-after", home),
      (actual, expected) => expect(actual).toBe(expected),
    );

    const state = registryState(home, gatewayPort);
    expect(state.registry.sandboxes?.[SANDBOX_NAME]?.agent).toBe("hermes");
    expect(state.registry.sandboxes?.[SANDBOX_NAME]?.provider).toBe(SWITCH_PROVIDER);
    expect(state.registry.sandboxes?.[SANDBOX_NAME]?.model).toBe(SWITCH_MODEL);
    expect(state.session.sandboxName).toBe(SANDBOX_NAME);
    expect(state.session.agent).toBe("hermes");
    expect(state.session.provider).toBe(SWITCH_PROVIDER);
    expect(state.session.model).toBe(SWITCH_MODEL);
    const publicSwitch = SWITCH_PROVIDER === PUBLIC_NVIDIA_SWITCH_PROVIDER;
    const durableEndpointUrl = publicSwitch
      ? null
      : (switchEndpointUrl ??
        process.env.NEMOCLAW_ENDPOINT_URL ??
        DEFAULT_HOSTED_INFERENCE_BASE_URL);
    const durableCredentialEnv = publicSwitch
      ? null
      : switchEndpointUrl
        ? "COMPATIBLE_ANTHROPIC_API_KEY"
        : "COMPATIBLE_API_KEY";
    expect(canonicalEndpoint(state.registry.sandboxes?.[SANDBOX_NAME]?.endpointUrl)).toBe(
      canonicalEndpoint(durableEndpointUrl),
    );
    expect(state.registry.sandboxes?.[SANDBOX_NAME]?.credentialEnv).toBe(durableCredentialEnv);
    expect(state.registry.sandboxes?.[SANDBOX_NAME]?.preferredInferenceApi).toBe(
      publicSwitch ? null : RUNTIME_SWITCH_API,
    );
    expect(state.registry.sandboxes?.[SANDBOX_NAME]?.nimContainer).toBeNull();
    expect(canonicalEndpoint(state.session.endpointUrl)).toBe(
      canonicalEndpoint(publicSwitch ? "https://inference.local/v1" : durableEndpointUrl),
    );
    expect(state.session.credentialEnv).toBe(
      publicSwitch ? "OPENAI_API_KEY" : durableCredentialEnv,
    );
    expect(state.session.preferredInferenceApi).toBe(RUNTIME_SWITCH_API);
    expect(state.session.nimContainer).toBeNull();

    progress.phase("exercise inference.local and Hermes API");
    const inferenceLocalPayload = JSON.stringify({
      model: SWITCH_MODEL,
      messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
      max_tokens: inferenceLocalMaxTokens(),
    });
    const inferenceLocal = await runHermesPongWithRetry({
      expectedModel: SWITCH_MODEL,
      onEvidence: async (evidence) => {
        await artifacts.writeJson("retry/hermes-inference-local-after-switch.json", evidence);
      },
      run: (attempt) =>
        sandbox.execShell(
          SANDBOX_NAME,
          trustedSandboxShellScript(inferenceLocalCommand(inferenceLocalPayload)),
          {
            artifactName: `hermes-inference-local-chat-after-switch-${attempt}`,
            env: commandEnv(),
            redactionValues,
            timeoutMs: 120_000,
          },
        ),
    });
    expect(inferenceLocal.exitCode, resultText(inferenceLocal)).toBe(0);
    expect(chatContent(inferenceLocal.stdout)).toMatch(/PONG/i);
    expect(inferenceResponseModel(inferenceLocal.stdout)).toBe(SWITCH_MODEL);

    const hermesApiPayload = JSON.stringify({
      model: SWITCH_MODEL,
      messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
      max_tokens: 100,
    });
    const chat = await runHermesPongWithRetry({
      expectedModel: SWITCH_MODEL,
      onEvidence: async (evidence) => {
        await artifacts.writeJson("retry/hermes-api-after-switch.json", evidence);
      },
      run: (attempt) =>
        sandbox.execShell(
          SANDBOX_NAME,
          trustedSandboxShellScript(hermesApiCommand(hermesApiPayload)),
          {
            artifactName: `hermes-api-chat-after-switch-${attempt}`,
            env: commandEnv(),
            redactionValues,
            timeoutMs: 150_000,
          },
        ),
    });
    expect(chat.exitCode, resultText(chat)).toBe(0);
    expect(chatContent(chat.stdout)).toMatch(/PONG/i);
    expect(inferenceResponseModel(chat.stdout)).toBe(SWITCH_MODEL);

    await runPublicFabricTurn({
      artifacts,
      contract: HERMES_FABRIC_CONTRACT,
      env: commandEnv(),
      host,
      lifecyclePhase: "after-inference-switch",
      redactionValues,
      sandbox,
      sandboxName: SANDBOX_NAME,
      scanPrivateState: false,
    });

    progress.phase("run Hermes CLI adapter forms against switched provider");
    const hermesCli = await runHermesCliPongWithRetry({
      onEvidence: async (evidence) => {
        await artifacts.writeJson("retry/hermes-cli-after-switch.json", evidence);
      },
      run: (attempt) =>
        sandbox.exec(
          SANDBOX_NAME,
          [
            "hermes",
            "-z",
            "Reply with exactly one word: PONG",
            "--provider",
            SWITCH_PROVIDER,
            "--model",
            SWITCH_MODEL,
          ],
          {
            artifactName: `hermes-cli-split-provider-model-after-switch-${attempt}`,
            env: commandEnv(),
            redactionValues,
            timeoutMs: 150_000,
          },
        ),
    });
    expect(hermesCli.exitCode, resultText(hermesCli)).toBe(0);
    expect(hermesCli.stdout).toMatch(/\bPONG\b/iu);

    progress.phase("prove split provider/model credential resolution");
    const { model: proxyResolutionModel, requestOffset } = await prepareProxyResolutionRoute({
      apiKey,
      home,
      host,
      mockBaseline,
      publicProvider,
      redactionValues,
    });
    const persistedProxyRoute = await sandbox.openshell(["inference", "get", "-g", gatewayName], {
      artifactName: "proxy-resolution-route-after-set",
      env: commandEnv(),
      redactionValues,
      timeoutMs: 30_000,
    });
    expect(persistedProxyRoute.exitCode, resultText(persistedProxyRoute)).toBe(0);
    expect(parseInferenceRoute(persistedProxyRoute.stdout)).toEqual({
      provider: PROXY_RESOLUTION_PROVIDER,
      model: proxyResolutionModel,
    });

    const proxyResolutionCli = await runHermesCliPongWithRetry({
      accept: () =>
        hasAuthenticatedProxyResolutionRequest(mockBaseline, requestOffset, proxyResolutionModel),
      onEvidence: async (evidence) => {
        await artifacts.writeJson("retry/hermes-cli-proxy-resolution-after-switch.json", evidence);
      },
      run: (attempt) =>
        sandbox.exec(
          SANDBOX_NAME,
          [
            "hermes",
            "chat",
            "--query",
            "Reply with exactly one word: PONG",
            "--quiet",
            "--provider",
            PROXY_RESOLUTION_PROVIDER,
            "--model",
            proxyResolutionModel,
          ],
          {
            artifactName: `hermes-cli-chat-split-provider-namespaced-model-proxy-resolution-${attempt}`,
            env: commandEnv(),
            redactionValues,
            timeoutMs: 150_000,
          },
        ),
    });
    expect(proxyResolutionCli.exitCode, resultText(proxyResolutionCli)).toBe(0);
    expect(proxyResolutionCli.stdout).toMatch(/\bPONG\b/iu);

    expectAuthenticatedProxyResolutionRequests(mockBaseline, requestOffset, proxyResolutionModel);
  },
);
