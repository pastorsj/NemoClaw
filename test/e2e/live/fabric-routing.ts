// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { parseHarnessPackageIdentity } from "../../../src/lib/harness/package-identity";
import { resolvePinnedHarnessPackage } from "../../../src/lib/harness/package-store";
import { ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS } from "../../../tools/e2e/onboard-timeout-contract.mts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import { type E2ETargetFixtures, expect } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import {
  cleanupSandbox,
  expectOnboardSuccess,
  expectOpenAiChatThroughSandbox,
  inferenceSandboxName,
  onboardSandbox,
  redactedResultText,
  requireLivePrerequisites,
  runNemoclawCli,
} from "./inference-routing-helpers.ts";

type FabricCompatibleEndpointContext = Pick<
  E2ETargetFixtures,
  "artifacts" | "cleanup" | "host" | "progress" | "sandbox"
> & {
  skip(note?: string): void;
};

interface FabricLiveEnvironment {
  readonly commandEnv: NodeJS.ProcessEnv;
  readonly gatewayName: string;
}

function fabricLiveEnvironment(base: NodeJS.ProcessEnv = process.env): FabricLiveEnvironment {
  const gatewayPort = base.NEMOCLAW_GATEWAY_PORT?.trim();
  const gatewayName =
    gatewayPort && gatewayPort !== "8080" ? `nemoclaw-${gatewayPort}` : "nemoclaw";
  const commandEnv = {
    ...buildAvailabilityProbeEnv(base),
    ...(gatewayPort ? { NEMOCLAW_GATEWAY_PORT: gatewayPort, OPENSHELL_GATEWAY: gatewayName } : {}),
    ...(base.NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD === "1"
      ? { NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD: "1" }
      : {}),
  };
  return { commandEnv, gatewayName };
}

export async function runFabricCompatibleEndpointJourney({
  artifacts,
  cleanup,
  host,
  progress,
  sandbox,
  skip,
}: FabricCompatibleEndpointContext): Promise<void> {
  const model = "nemoclaw-e2e-compatible";
  const apiKey = "sk-compatible-TEST-NOT-A-REAL-VALUE";
  const { commandEnv: initialCommandEnv, gatewayName } = fabricLiveEnvironment();
  let commandEnv = initialCommandEnv;
  await requireLivePrerequisites(host, skip);

  progress.phase("install and verify the Deep Agents Code harness package");
  const installation = await runNemoclawCli(["harness", "install", "langchain-deepagents-code"], {
    artifactName: "tc-inf-09-harness-install",
    artifacts,
    env: commandEnv,
    progress,
    timeoutMs: 60_000,
  });
  expect(installation.exitCode, redactedResultText(installation)).toBe(0);
  const inventoryResult = await runNemoclawCli(["harness", "list", "--json"], {
    artifactName: "tc-inf-09-harness-list",
    artifacts,
    env: commandEnv,
    progress,
    timeoutMs: 30_000,
  });
  expect(inventoryResult.exitCode, redactedResultText(inventoryResult)).toBe(0);
  const inventory = JSON.parse(inventoryResult.stdout) as {
    available?: Array<{
      identity?: { id?: unknown };
      installationState?: unknown;
    }>;
    installed?: Array<{ health?: unknown; id?: unknown; identity?: unknown }>;
  };
  const installedPackage = inventory.installed?.find(
    ({ id }) => id === "langchain-deepagents-code",
  );
  const availablePackage = inventory.available?.find(
    ({ identity }) => identity?.id === "langchain-deepagents-code",
  );
  if (!installedPackage || !availablePackage) {
    throw new Error("Deep Agents Code was not present in both installed and available inventory");
  }
  expect(installedPackage).toMatchObject({ health: "healthy" });
  expect(availablePackage).toMatchObject({ installationState: "active" });
  const installedIdentity = parseHarnessPackageIdentity(installedPackage.identity);
  const availableIdentity = parseHarnessPackageIdentity(availablePackage.identity);
  expect(installedIdentity).toEqual(availableIdentity);
  const pinnedPackage = resolvePinnedHarnessPackage(installedIdentity);
  commandEnv = {
    ...commandEnv,
    NEMOCLAW_FROM_DOCKERFILE: path.join(
      path.dirname(pinnedPackage.packageManifest.manifestPath),
      "Dockerfile",
    ),
  };

  const sandboxName = inferenceSandboxName("e2e-compat");
  cleanup.add(`best-effort inference-routing compatible-endpoint cleanup for ${sandboxName}`, () =>
    cleanupSandbox(host, sandbox, sandboxName, { env: commandEnv }),
  );
  cleanup.add(`strict inference-routing compatible-endpoint cleanup for ${sandboxName}`, () =>
    cleanupSandbox(host, sandbox, sandboxName, { env: commandEnv, strict: true }),
  );
  await cleanupSandbox(host, sandbox, sandboxName, { env: commandEnv });

  progress.phase("start the local compatible endpoint");
  const fake = await startFakeOpenAiCompatibleServer({
    apiKey,
    chatContent: "PONG",
    chatUsage: { inputTokens: 7, outputTokens: 4, totalTokens: 11 },
    host: "0.0.0.0",
    model,
    port: 8000,
    progress,
    publicHost: "localhost",
    requestCanaryMarker: apiKey,
    requireAuth: true,
    requireAuthModels: true,
  });
  cleanup.add("close inference-routing compatible endpoint", async () => {
    try {
      await artifacts.writeJson("tc-inf-09-compatible-endpoint-requests.json", fake.requests());
    } finally {
      await fake.close();
    }
  });

  await artifacts.target.declare({
    id: "inference-routing-compatible-endpoint",
    contract: [
      "the reviewed Deep Agents Code harness package installs and becomes the active exact identity",
      "Deep Agents Code custom OpenAI-compatible endpoint onboards",
      "sandbox inference.local routes chat to compatible endpoint",
      "dcode returns the compatible endpoint response through the rewritten gateway route",
      "the public agent command runs the released Fabric Deep Agents adapter",
      "Fabric failures redact credential-shaped config paths and leave no process",
      "the exact compatible endpoint credential is not retained in sandbox files",
    ],
    endpointUrl: fake.baseUrl,
    model,
  });

  progress.phase("onboard Deep Agents Code to the endpoint");
  const onboard = await onboardSandbox(
    artifacts,
    sandboxName,
    {
      COMPATIBLE_API_KEY: apiKey,
      NEMOCLAW_AGENT: "langchain-deepagents-code",
      NEMOCLAW_ENDPOINT_URL: fake.baseUrl,
      NEMOCLAW_MODEL: model,
      NEMOCLAW_PREFERRED_API: "openai-completions",
      NEMOCLAW_PROVIDER: "custom",
      NEMOCLAW_SANDBOX_GPU: "0",
      ...commandEnv,
    },
    [apiKey],
    "tc-inf-09-onboard-compatible-endpoint",
    progress,
    ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS,
  );
  expectOnboardSuccess(onboard, "TC-INF-09 compatible-endpoint onboard");

  progress.phase("inspect the compatible provider route");
  const provider = await sandbox.openshell(
    ["provider", "get", "-g", gatewayName, "compatible-endpoint"],
    {
      artifactName: "tc-inf-09-provider-get-compatible-endpoint",
      env: commandEnv,
      timeoutMs: 30_000,
    },
  );
  const providerText = resultText(provider).replace(/\u001b\[[0-9;]*m/g, "");
  expect(provider.exitCode, providerText).toBe(0);
  expect(providerText).toContain("Type: openai");
  expect(providerText).toContain("Credential keys: COMPATIBLE_API_KEY");
  expect(providerText).toContain("Config keys: OPENAI_BASE_URL");
  expect(fake.requests()).toContainEqual(
    expect.objectContaining({
      auth: "ok",
      hostHeader: "localhost:8000",
    }),
  );

  progress.phase("request sandbox chat through inference.local");
  const sandboxRequestOffset = fake.requests().length;
  await expectOpenAiChatThroughSandbox(
    sandbox,
    sandboxName,
    model,
    [apiKey],
    "compatible-endpoint-inference-local-chat",
    commandEnv,
  );
  expect(fake.requests().slice(sandboxRequestOffset)).toContainEqual(
    expect.objectContaining({
      auth: "ok",
      hostHeader: "host.openshell.internal:8000",
      method: "POST",
      model,
      path: "/v1/chat/completions",
    }),
  );

  progress.phase("request a dcode completion through the route");
  const dcodeRequestOffset = fake.requests().length;
  const dcode = await runNemoclawCli(
    [sandboxName, "exec", "--", "dcode", "-n", "Reply with exactly one word: PONG"],
    {
      artifactName: "tc-inf-09-dcode-compatible-endpoint",
      artifacts,
      env: commandEnv,
      progress,
      redactionValues: [apiKey],
      timeoutMs: 3 * 60_000,
    },
  );
  const dcodeText = redactedResultText(dcode);
  expect(dcode.timedOut, `TC-INF-09 dcode timed out\n${dcodeText}`).toBe(false);
  expect(dcode.exitCode, `TC-INF-09 dcode failed\n${dcodeText}`).toBe(0);
  expect(dcodeText).toMatch(/\bPONG\b/);
  expect(fake.requests().slice(dcodeRequestOffset)).toContainEqual(
    expect.objectContaining({
      auth: "ok",
      hostHeader: "host.openshell.internal:8000",
      method: "POST",
      model,
      path: "/v1/chat/completions",
    }),
  );

  progress.phase("verify the installed Fabric identity");
  const fabricIdentity = await runNemoclawCli(
    [
      sandboxName,
      "exec",
      "--",
      "bash",
      "-c",
      'set -euo pipefail; [ "$(nemoclaw-fabric --version)" = "nemoclaw-fabric 0.1.1 (nemo-fabric 0.2.0)" ]; /opt/nemoclaw-fabric-venv/bin/python3 -I -c \'from importlib.metadata import version; expected = {"nemo-fabric": "0.2.0", "nemo-fabric-adapters-deepagents": "0.2.0"}; actual = {name: version(name) for name in expected}; raise SystemExit(0 if actual == expected else 1)\'; printf "%s\\n" NEMOCLAW_FABRIC_IDENTITY_OK',
    ],
    {
      artifactName: "tc-inf-09-fabric-identity",
      artifacts,
      env: commandEnv,
      progress,
      redactionValues: [apiKey],
      timeoutMs: 30_000,
    },
  );
  expect(fabricIdentity.exitCode, redactedResultText(fabricIdentity)).toBe(0);
  expect(fabricIdentity.stdout.trim()).toBe("NEMOCLAW_FABRIC_IDENTITY_OK");

  progress.phase("request a Fabric completion through the public agent command");
  const fabricRequestOffset = fake.requests().length;
  const fabric = await runNemoclawCli(
    [sandboxName, "agent", "-m", "Reply with exactly one word: PONG", "--json"],
    {
      artifactName: "tc-inf-09-fabric-compatible-endpoint",
      artifacts,
      env: commandEnv,
      progress,
      redactionValues: [apiKey],
      timeoutMs: 3 * 60_000,
    },
  );
  const fabricText = redactedResultText(fabric);
  expect(fabric.timedOut, `TC-INF-09 Fabric turn timed out\n${fabricText}`).toBe(false);
  expect(fabric.exitCode, `TC-INF-09 Fabric turn failed\n${fabricText}`).toBe(0);
  const fabricOutputExposedCredential =
    fabric.stdout.includes(apiKey) || fabric.stderr.includes(apiKey);
  expect(
    fabricOutputExposedCredential,
    "raw Fabric output retained the compatible-endpoint credential",
  ).toBe(false);
  const fabricResult = JSON.parse(fabric.stdout.trim()) as {
    adapter_kind?: unknown;
    harness?: unknown;
    output?: { response?: unknown };
    status?: unknown;
    usage?: { total_tokens?: unknown };
  };
  expect(fabricResult).toMatchObject({
    adapter_kind: "python",
    harness: "nvidia.fabric.langchain.deepagents",
    output: { response: "PONG" },
    status: "succeeded",
    usage: { total_tokens: 11 },
  });
  expect(fake.requests().slice(fabricRequestOffset)).toContainEqual(
    expect.objectContaining({
      auth: "ok",
      hostHeader: "host.openshell.internal:8000",
      method: "POST",
      model,
      path: "/v1/chat/completions",
      requestCanaryPresent: true,
    }),
  );

  progress.phase("verify Fabric failure redaction and process cleanup");
  const redactionSentinel = "sk-proj-tc-inf-09-redaction-0123456789";
  const missingConfig = `/sandbox/.deepagents/missing-${redactionSentinel}.json`;
  const rejectedFabric = await runNemoclawCli(
    [sandboxName, "agent", "--config", missingConfig, "-m", "redaction probe", "--json"],
    {
      artifactName: "tc-inf-09-fabric-redacted-config-failure",
      artifacts,
      env: commandEnv,
      progress,
      redactionValues: [apiKey],
      timeoutMs: 30_000,
    },
  );
  expect(rejectedFabric.timedOut).toBe(false);
  expect(rejectedFabric.exitCode).toBe(2);
  expect(rejectedFabric.stdout.includes(redactionSentinel)).toBe(false);
  expect(JSON.parse(rejectedFabric.stdout.trim())).toMatchObject({
    error: {
      code: "invalid_config",
      message: expect.stringContaining("<redacted>"),
      stage: "config",
    },
    status: "failed",
  });
  const fabricProcesses = await runNemoclawCli(
    [
      sandboxName,
      "exec",
      "--",
      "bash",
      "-c",
      'set -euo pipefail; for command_line in /proc/[0-9]*/cmdline; do [ -r "$command_line" ] || continue; argv0="$(tr "\\000" "\\n" <"$command_line" 2>/dev/null | sed -n "1p")"; case "$argv0" in /opt/nemoclaw-fabric-venv/bin/python* | /usr/local/bin/nemoclaw-fabric) printf "%s\\n" "$argv0"; exit 1 ;; esac; done; printf "%s\\n" NEMOCLAW_FABRIC_PROCESSES_CLEAN',
    ],
    {
      artifactName: "tc-inf-09-fabric-process-cleanup",
      artifacts,
      env: commandEnv,
      progress,
      redactionValues: [apiKey],
      timeoutMs: 30_000,
    },
  );
  expect(fabricProcesses.exitCode, redactedResultText(fabricProcesses)).toBe(0);
  expect(fabricProcesses.stdout.trim()).toBe("NEMOCLAW_FABRIC_PROCESSES_CLEAN");

  progress.phase("verify compatible credential custody");
  const credentialSnapshot = await runNemoclawCli(
    [
      sandboxName,
      "exec",
      "--",
      "bash",
      "-c",
      'set -euo pipefail; emitted=0; emit_file() { artifact="$1"; [ -r "$artifact" ] || return 0; bytes="$(wc -c <"$artifact")"; [ "$bytes" -le 1048576 ] || exit 1; emitted=$((emitted + 1)); [ "$emitted" -le 100 ] || exit 1; printf "@@NEMOCLAW_E2E_FILE@@ %s\\n" "$artifact"; cat "$artifact"; }; for artifact in /sandbox/.deepagents/config.toml /sandbox/.deepagents/fabric.json /sandbox/.deepagents/.env /sandbox/.deepagents/.mcp.json /sandbox/.deepagents/.nemoclaw-mcp.json /tmp/nemoclaw-proxy-env.sh; do emit_file "$artifact"; done; while IFS= read -r -d "" artifact; do emit_file "$artifact"; done < <(find /sandbox/.deepagents/fabric-artifacts -xdev -maxdepth 3 -type f -print0 2>/dev/null || true)',
    ],
    {
      artifactName: "tc-inf-09-fabric-credential-snapshot",
      artifactOutputMode: "metadata-only",
      artifacts,
      env: commandEnv,
      progress,
      redactionValues: [apiKey],
      timeoutMs: 30_000,
    },
  );
  expect(credentialSnapshot.exitCode, redactedResultText(credentialSnapshot)).toBe(0);
  expect(
    credentialSnapshot.stdout.includes(apiKey),
    "the exact compatible endpoint credential was retained in a sandbox file",
  ).toBe(false);
  expect(credentialSnapshot.stdout).toMatch(/api_key_env[" =:]+DEEPAGENTS_CODE_OPENAI_API_KEY/u);
  await artifacts.target.complete({
    id: "inference-routing-compatible-endpoint",
    status: "passed",
  });
}
