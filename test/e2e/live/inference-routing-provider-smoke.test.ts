// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolvePinnedHarnessPackage } from "../../../src/lib/agent-runtime/package/store";
import {
  ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS,
  ONBOARD_SINGLE_FINAL_HANDOFF_TEST_TIMEOUT_MS,
} from "../../../tools/e2e/onboard-timeout-contract.mts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import { trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { installHarnessPackage } from "../fixtures/harness-package.ts";
import {
  buildHostedInferenceModelsProbe,
  requireHostedInferenceConfig,
} from "../fixtures/hosted-inference.ts";
import {
  buildHostedFabricCommandEnvironment,
  cleanupSandbox,
  expectAnthropicMessageThroughSandbox,
  expectOnboardSuccess,
  expectOpenAiChatThroughSandbox,
  expectResultOmitsSecret,
  inferenceSandboxName,
  onboardSandbox,
  parseJsonObject,
  rawOpenShellEnv,
  redactedResultText,
  requireCleanupTargetAbsent,
  requireLivePrerequisites,
  requireProviderSmokeSelected,
  requireSuccessfulCleanupCommand,
  runNemoclawCli,
  runOpenShell,
  skipLive,
  verifyCredentialPlaceholder,
  verifyProcessListCredentialIsolation,
} from "./inference-routing-helpers.ts";

// These credential-backed smokes are intentionally outside the PR-required
// inference-routing lane. A future workflow that supplies provider credentials
// must run them only from trusted main.

const HOSTED_FABRIC_MODEL = "nvidia/nvidia/nemotron-3-super-v3";
const HOSTED_FABRIC_WORKSPACE_FILE = "/sandbox/fabric-workspace-proof.txt";
const HOSTED_FABRIC_WORKSPACE_VIRTUAL_FILE = "/fabric-workspace-proof.txt";
const HOSTED_FABRIC_WORKSPACE_CONTENT = "NEMOCLAW_FABRIC_WORKSPACE_OK";
const HOSTED_FABRIC_WORKSPACE_RESPONSE = "WORKSPACE_WRITE_OK";
const HOSTED_FABRIC_WORKSPACE_PROMPT = [
  `Use the write_file tool exactly once to create ${HOSTED_FABRIC_WORKSPACE_VIRTUAL_FILE}.`,
  `Write exactly this UTF-8 content with no line break: ${HOSTED_FABRIC_WORKSPACE_CONTENT}`,
  "Do not use execute, shell, or another tool.",
  `After write_file succeeds, reply with exactly ${HOSTED_FABRIC_WORKSPACE_RESPONSE}.`,
].join(" ");

const HOSTED_FABRIC_WORKSPACE_INSPECT_SCRIPT = [
  "import hashlib, json",
  "from pathlib import Path",
  `path = Path(${JSON.stringify(HOSTED_FABRIC_WORKSPACE_FILE)})`,
  `expected = ${JSON.stringify(HOSTED_FABRIC_WORKSPACE_CONTENT)}.encode("utf-8")`,
  "if path.is_symlink() or not path.is_file(): raise SystemExit(1)",
  "data = path.read_bytes()",
  "if data != expected: raise SystemExit(1)",
  'print(json.dumps({"bytes": len(data), "path": str(path), "sha256": hashlib.sha256(data).hexdigest()}, separators=(",", ":"), sort_keys=True))',
].join("\n");

const HOSTED_FABRIC_WORKSPACE_REMOVE_SCRIPT = [
  "from pathlib import Path",
  `path = Path(${JSON.stringify(HOSTED_FABRIC_WORKSPACE_FILE)})`,
  "path.unlink(missing_ok=True)",
  "if path.exists() or path.is_symlink(): raise SystemExit(1)",
  'print("NEMOCLAW_FABRIC_WORKSPACE_CLEAN")',
].join("\n");

test(
  "TC-INF-05 real NVIDIA key is isolated from sandbox env, process list, and filesystem",
  {
    timeout: 15 * 60_000,
    meta: {
      e2ePhases: [
        "confirm NVIDIA credential prerequisites",
        "recreate the credential-isolation sandbox",
        "onboard with the real NVIDIA credential",
        "inspect sandbox environment and processes",
        "scan the sandbox filesystem for the credential",
        "confirm placeholder credential injection",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, sandbox, secrets, skip }) => {
    const apiKey =
      secrets.optional("NVIDIA_INFERENCE_API_KEY") ??
      skipLive(skip, "NVIDIA_INFERENCE_API_KEY not set — cannot test credential isolation");
    await requireLivePrerequisites(host, skip);
    const sandboxName = inferenceSandboxName("e2e-cred");
    cleanup.add(
      `best-effort inference-routing credential-isolation cleanup for ${sandboxName}`,
      () => cleanupSandbox(host, sandbox, sandboxName),
    );
    progress.phase("recreate the credential-isolation sandbox");
    await cleanupSandbox(host, sandbox, sandboxName);

    await artifacts.target.declare({
      id: "inference-routing-credential-isolation",
      contract: [
        "real NVIDIA_INFERENCE_API_KEY does not appear in sandbox environment",
        "real NVIDIA_INFERENCE_API_KEY does not appear in sandbox process list when ps is available",
        "real NVIDIA_INFERENCE_API_KEY does not appear in sampled sandbox filesystem",
        "sandbox NVIDIA_INFERENCE_API_KEY, when present, is a placeholder rather than the real key",
      ],
    });

    progress.phase("onboard with the real NVIDIA credential");
    const onboard = await onboardSandbox(
      artifacts,
      sandboxName,
      { NVIDIA_INFERENCE_API_KEY: apiKey },
      [apiKey],
      "tc-inf-05-onboard-credential-isolation",
      progress,
    );
    expectOnboardSuccess(onboard, "TC-INF-05 credential-isolation onboard");
    cleanup.add(`strict inference-routing credential-isolation cleanup for ${sandboxName}`, () =>
      cleanupSandbox(host, sandbox, sandboxName, { strict: true }),
    );

    progress.phase("inspect sandbox environment and processes");
    const sandboxEnv = await runOpenShell(["sandbox", "exec", "-n", sandboxName, "--", "env"], {
      artifactName: "tc-inf-05-sandbox-env",
      artifacts,
      env: buildAvailabilityProbeEnv(),
      progress,
      redactionValues: [apiKey],
      timeoutMs: 60_000,
    });
    expect(sandboxEnv.exitCode, redactedResultText(sandboxEnv)).toBe(0);
    expect(sandboxEnv.stdout.includes(apiKey), redactedResultText(sandboxEnv)).toBe(false);

    const processList = await runOpenShell(
      [
        "sandbox",
        "exec",
        "-n",
        sandboxName,
        "--",
        "sh",
        "-lc",
        "ps aux 2>/dev/null || ps -ef 2>/dev/null",
      ],
      {
        artifactName: "tc-inf-05-sandbox-process-list",
        artifacts,
        env: buildAvailabilityProbeEnv(),
        progress,
        redactionValues: [apiKey],
        timeoutMs: 60_000,
      },
    );
    await verifyProcessListCredentialIsolation(artifacts, processList, apiKey);

    progress.phase("scan the sandbox filesystem for the credential");
    const scanScript = [
      "const crypto=require('crypto')",
      "const fs=require('fs')",
      "const {execFileSync}=require('child_process')",
      "const len=Number(process.env.KEY_LEN||'0')",
      "const salt=process.env.SCAN_SALT||''",
      "const target=process.env.TARGET_HASH||''",
      "const digest=(value)=>crypto.createHash('sha256').update(salt).update(value).digest('hex')",
      "if(!len||!salt||!target){console.log('SCAN_CONFIG_MISSING');process.exit(0)}",
      "let out=''",
      "try{out=execFileSync('sh',['-lc','find /tmp /sandbox /home -type f -size -1M 2>/dev/null | head -200'],{encoding:'utf8'})}catch{console.log('SCAN_ERROR');process.exit(0)}",
      "for(const file of out.trim().split(/\\n/).filter(Boolean)){try{const content=fs.readFileSync(file,'utf8');for(let i=0;i<=content.length-len;i++){if(digest(content.slice(i,i+len))===target){console.log('FOUND:'+file);break}}}catch{}}",
      "console.log('SCAN_DONE')",
    ].join(";");
    const leakCanary = `nemoclaw-fs-scan-canary-${crypto.randomUUID()}`;
    const canaryPath = "/tmp/nemoclaw-fs-scan-canary.txt";
    const plantCanary = await sandbox.execShell(
      sandboxName,
      trustedSandboxShellScript(`printf '%s' '${leakCanary}' > ${canaryPath}`),
      {
        artifactName: "tc-inf-05-sandbox-filesystem-canary-plant",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(plantCanary.exitCode, resultText(plantCanary)).toBe(0);
    const canarySalt = crypto.randomUUID();
    const canaryScan = await runOpenShell(
      ["sandbox", "exec", "-n", sandboxName, "--", "node", "-e", scanScript],
      {
        artifactName: "tc-inf-05-sandbox-filesystem-canary-scan",
        artifacts,
        env: rawOpenShellEnv({
          KEY_LEN: String(leakCanary.length),
          SCAN_SALT: canarySalt,
          TARGET_HASH: crypto
            .createHash("sha256")
            .update(canarySalt)
            .update(leakCanary)
            .digest("hex"),
        }),
        progress,
        timeoutMs: 90_000,
      },
    );
    expect(canaryScan.stdout, redactedResultText(canaryScan)).toContain(`FOUND:${canaryPath}`);

    const removeCanary = await sandbox.execShell(
      sandboxName,
      trustedSandboxShellScript(`rm -f ${canaryPath}`),
      {
        artifactName: "tc-inf-05-sandbox-filesystem-canary-remove",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(removeCanary.exitCode, resultText(removeCanary)).toBe(0);

    const secretScanSalt = crypto.randomUUID();
    const filesystemScan = await runOpenShell(
      ["sandbox", "exec", "-n", sandboxName, "--", "node", "-e", scanScript],
      {
        artifactName: "tc-inf-05-sandbox-filesystem-scan",
        artifacts,
        env: rawOpenShellEnv({
          KEY_LEN: String(apiKey.length),
          SCAN_SALT: secretScanSalt,
          TARGET_HASH: crypto
            .createHash("sha256")
            .update(secretScanSalt)
            .update(apiKey)
            .digest("hex"),
        }),
        progress,
        redactionValues: [apiKey],
        timeoutMs: 90_000,
      },
    );
    expect(filesystemScan.stdout).not.toContain("SCAN_CONFIG_MISSING");
    expect(filesystemScan.stdout).not.toContain("FOUND:");
    expect(filesystemScan.stdout, redactedResultText(filesystemScan)).toContain("SCAN_DONE");

    progress.phase("confirm placeholder credential injection");
    const placeholder = await sandbox.execShell(
      sandboxName,
      trustedSandboxShellScript("printenv NVIDIA_INFERENCE_API_KEY 2>/dev/null || true"),
      {
        artifactName: "tc-inf-05-sandbox-placeholder",
        env: buildAvailabilityProbeEnv(),
        redactionValues: [apiKey],
        timeoutMs: 30_000,
      },
    );
    const placeholderValue = placeholder.stdout.trim();
    await verifyCredentialPlaceholder(artifacts, placeholderValue, apiKey);
  },
);

test(
  "TC-INF-02 OpenAI provider responds through inference.local",
  {
    timeout: 15 * 60_000,
    meta: {
      e2ePhases: [
        "confirm OpenAI provider prerequisites",
        "recreate the OpenAI sandbox",
        "onboard the OpenAI provider",
        "request OpenAI chat through inference.local",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, sandbox, secrets, skip }) => {
    requireProviderSmokeSelected("openai", skip);
    const apiKey = secrets.optional("OPENAI_API_KEY") ?? skipLive(skip, "OPENAI_API_KEY not set");
    await requireLivePrerequisites(host, skip);
    const sandboxName = inferenceSandboxName("e2e-openai");
    const model = process.env.NEMOCLAW_OPENAI_MODEL || "gpt-4o-mini";
    cleanup.add(`best-effort inference-routing OpenAI cleanup for ${sandboxName}`, () =>
      cleanupSandbox(host, sandbox, sandboxName),
    );
    progress.phase("recreate the OpenAI sandbox");
    await cleanupSandbox(host, sandbox, sandboxName);

    await artifacts.target.declare({
      id: "inference-routing-openai",
      contract: ["OpenAI provider onboards", "sandbox inference.local routes chat to OpenAI"],
      model,
    });

    progress.phase("onboard the OpenAI provider");
    const onboard = await onboardSandbox(
      artifacts,
      sandboxName,
      { NEMOCLAW_MODEL: model, NEMOCLAW_PROVIDER: "openai", OPENAI_API_KEY: apiKey },
      [apiKey],
      "tc-inf-02-onboard-openai",
      progress,
    );
    expectOnboardSuccess(onboard, "TC-INF-02 OpenAI onboard");
    cleanup.add(`strict inference-routing OpenAI cleanup for ${sandboxName}`, () =>
      cleanupSandbox(host, sandbox, sandboxName, { strict: true }),
    );
    progress.phase("request OpenAI chat through inference.local");
    await expectOpenAiChatThroughSandbox(
      sandbox,
      sandboxName,
      model,
      [apiKey],
      "openai-inference-local-chat",
    );
  },
);

test(
  "TC-INF-03 Anthropic provider responds through inference.local",
  {
    timeout: 15 * 60_000,
    meta: {
      e2ePhases: [
        "confirm Anthropic provider prerequisites",
        "recreate the Anthropic sandbox",
        "onboard the Anthropic provider",
        "request Anthropic messages through inference.local",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, sandbox, secrets, skip }) => {
    requireProviderSmokeSelected("anthropic", skip);
    const apiKey =
      secrets.optional("ANTHROPIC_API_KEY") ?? skipLive(skip, "ANTHROPIC_API_KEY not set");
    await requireLivePrerequisites(host, skip);
    const sandboxName = inferenceSandboxName("e2e-anth");
    const model = process.env.NEMOCLAW_ANTHROPIC_MODEL || "claude-sonnet-4-6";
    cleanup.add(`best-effort inference-routing Anthropic cleanup for ${sandboxName}`, () =>
      cleanupSandbox(host, sandbox, sandboxName),
    );
    progress.phase("recreate the Anthropic sandbox");
    await cleanupSandbox(host, sandbox, sandboxName);

    await artifacts.target.declare({
      id: "inference-routing-anthropic",
      contract: [
        "Anthropic provider onboards",
        "sandbox inference.local routes Messages API to Anthropic",
      ],
      model,
    });

    progress.phase("onboard the Anthropic provider");
    const onboard = await onboardSandbox(
      artifacts,
      sandboxName,
      { ANTHROPIC_API_KEY: apiKey, NEMOCLAW_MODEL: model, NEMOCLAW_PROVIDER: "anthropic" },
      [apiKey],
      "tc-inf-03-onboard-anthropic",
      progress,
    );
    expectOnboardSuccess(onboard, "TC-INF-03 Anthropic onboard");
    cleanup.add(`strict inference-routing Anthropic cleanup for ${sandboxName}`, () =>
      cleanupSandbox(host, sandbox, sandboxName, { strict: true }),
    );
    progress.phase("request Anthropic messages through inference.local");
    await expectAnthropicMessageThroughSandbox(sandbox, sandboxName, model, [apiKey]);
  },
);

test(
  "TC-INF-14 installed Fabric adapter completes hosted NVIDIA turns",
  {
    timeout: ONBOARD_SINGLE_FINAL_HANDOFF_TEST_TIMEOUT_MS + 10 * 60_000,
    meta: {
      e2ePhases: [
        "confirm hosted Fabric prerequisites",
        "install and verify the Deep Agents Code package",
        "recreate the isolated hosted Fabric sandbox",
        "onboard the hosted Fabric model from the installed package",
        "verify the Fabric identity and managed route",
        "request hosted Fabric model and workspace turns",
        "reject an invalid Fabric config without leaking credentials",
        "verify Fabric process and credential cleanup",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, sandbox, secrets, skip }) => {
    requireProviderSmokeSelected("fabric", skip);
    await requireLivePrerequisites(host, skip);
    const apiKey =
      secrets.optional("NVIDIA_INFERENCE_API_KEY") ??
      secrets.optional("INFERENCE_NVIDIA_API_KEY") ??
      skipLive(skip, "NVIDIA hosted inference API key is not set");
    artifacts.addRedactionValues([apiKey]);

    const endpointUrl = process.env.NEMOCLAW_ENDPOINT_URL ?? process.env.INFERENCE_NVIDIA_API_URL;
    const hosted = requireHostedInferenceConfig(
      { required: () => apiKey },
      {
        ...process.env,
        ...(endpointUrl ? { NEMOCLAW_ENDPOINT_URL: endpointUrl } : {}),
        NEMOCLAW_COMPAT_MODEL: HOSTED_FABRIC_MODEL,
        NEMOCLAW_MODEL: HOSTED_FABRIC_MODEL,
      },
      { model: HOSTED_FABRIC_MODEL },
    );
    const hostedEndpoint = new URL(hosted.endpointUrl);
    expect(hostedEndpoint.protocol).toBe("https:");
    expect(hostedEndpoint.username).toBe("");
    expect(hostedEndpoint.password).toBe("");
    expect(hostedEndpoint.search).toBe("");
    expect(hostedEndpoint.hash).toBe("");
    expect(hosted.model).toBe(HOSTED_FABRIC_MODEL);

    const { env: initialCommandEnv, gatewayName } = buildHostedFabricCommandEnvironment();
    cleanup.trackGateway(host, gatewayName, {
      artifactName: "tc-inf-14-gateway-cleanup",
      env: initialCommandEnv,
      timeoutMs: 60_000,
    });
    const modelsProbe = buildHostedInferenceModelsProbe(apiKey, hosted.endpointUrl);
    const modelInventory = await host.command(modelsProbe.command, modelsProbe.args, {
      artifactName: "tc-inf-14-hosted-models",
      env: { ...initialCommandEnv, ...modelsProbe.env },
      redactionValues: [apiKey],
      timeoutMs: 90_000,
    });
    expect(modelInventory.exitCode, resultText(modelInventory)).toBe(0);
    expectResultOmitsSecret(modelInventory, apiKey, "hosted model inventory");
    const modelInventoryJson = parseJsonObject(modelInventory.stdout, "hosted model inventory");
    const hostedModelIds = Array.isArray(modelInventoryJson.data)
      ? modelInventoryJson.data.flatMap((entry) =>
          entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string"
            ? [(entry as { id: string }).id]
            : [],
        )
      : [];
    expect(hostedModelIds).toContain(HOSTED_FABRIC_MODEL);

    await artifacts.target.declare({
      id: "inference-routing-hosted-fabric",
      contract: [
        "the public CLI installs and resolves one receipt-backed Deep Agents Code package",
        "source qualification builds the DCode base locally without a remote base override",
        "the released Fabric Deep Agents adapter returns hosted NVIDIA inference through inference.local",
        "one Fabric write_file call creates and removes a confined workspace artifact",
        "invalid config output, bounded package files, and command artifacts do not retain the hosted credential",
        "the isolated sandbox, provider, workspace proof, and Fabric processes are removed",
      ],
      endpointUrl: hosted.endpointUrl,
      model: HOSTED_FABRIC_MODEL,
    });

    progress.phase("install and verify the Deep Agents Code package");
    const packageEvidence = await installHarnessPackage(host, "langchain-deepagents-code");
    expect(packageEvidence.identity).toMatchObject({
      id: "langchain-deepagents-code",
      kind: "agent-runtime",
    });
    const pinnedPackage = resolvePinnedHarnessPackage(packageEvidence.identity);
    const dockerfilePath = path.join(
      path.dirname(pinnedPackage.packageManifest.manifestPath),
      "Dockerfile",
    );
    expect(fs.existsSync(dockerfilePath), "installed DCode package Dockerfile is missing").toBe(
      true,
    );
    const commandEnv: NodeJS.ProcessEnv = {
      ...initialCommandEnv,
      NEMOCLAW_FROM_DOCKERFILE: dockerfilePath,
    };
    await artifacts.writeJson("tc-inf-14-package-identity.json", packageEvidence.identity);

    progress.phase("recreate the isolated hosted Fabric sandbox");
    const sandboxName = inferenceSandboxName("e2e-fabric");
    cleanup.add(`best-effort hosted Fabric sandbox cleanup for ${sandboxName}`, () =>
      cleanupSandbox(host, sandbox, sandboxName, { env: commandEnv }),
    );
    await cleanupSandbox(host, sandbox, sandboxName, { env: commandEnv });
    const providerBefore = await sandbox.openshell(
      ["provider", "get", "-g", gatewayName, hosted.providerName],
      {
        artifactName: "tc-inf-14-provider-before",
        env: commandEnv,
        redactionValues: [apiKey],
        timeoutMs: 30_000,
      },
    );
    expect(
      providerBefore.exitCode,
      "the isolated gateway already contained the hosted Fabric provider",
    ).not.toBe(0);

    cleanup.add(`remove hosted Fabric provider ${hosted.providerName}`, async () => {
      const reset = await runNemoclawCli(["credentials", "reset", hosted.providerName, "--yes"], {
        artifactName: "tc-inf-14-provider-reset",
        artifacts,
        env: commandEnv,
        progress,
        redactionValues: [apiKey],
        timeoutMs: 90_000,
      });
      requireSuccessfulCleanupCommand(reset, "hosted Fabric provider reset");
      const providerAfter = await sandbox.openshell(
        ["provider", "get", "-g", gatewayName, hosted.providerName],
        {
          artifactName: "tc-inf-14-provider-after-cleanup",
          env: commandEnv,
          redactionValues: [apiKey],
          timeoutMs: 30_000,
        },
      );
      requireCleanupTargetAbsent(providerAfter, "hosted Fabric provider");
    });
    cleanup.add(`destroy isolated hosted Fabric sandbox ${sandboxName}`, () =>
      cleanupSandbox(host, sandbox, sandboxName, { env: commandEnv, strict: true }),
    );

    progress.phase("onboard the hosted Fabric model from the installed package");
    const onboard = await onboardSandbox(
      artifacts,
      sandboxName,
      {
        ...hosted.env,
        ...commandEnv,
        NEMOCLAW_AGENT: "langchain-deepagents-code",
        NEMOCLAW_SANDBOX_GPU: "0",
      },
      [apiKey],
      "tc-inf-14-onboard-hosted-fabric",
      progress,
      ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS,
    );
    expectResultOmitsSecret(onboard, apiKey, "hosted Fabric onboard");
    expectOnboardSuccess(onboard, "TC-INF-14 hosted Fabric onboard");

    progress.phase("verify the Fabric identity and managed route");
    const provider = await sandbox.openshell(
      ["provider", "get", "-g", gatewayName, hosted.providerName],
      {
        artifactName: "tc-inf-14-provider-route",
        env: commandEnv,
        redactionValues: [apiKey],
        timeoutMs: 30_000,
      },
    );
    const providerText = resultText(provider).replace(/\u001b\[[0-9;]*m/gu, "");
    expect(provider.exitCode, providerText).toBe(0);
    expect(providerText).toContain("Type: openai");
    expect(providerText).toContain("Credential keys: COMPATIBLE_API_KEY");
    expect(providerText).toContain("Config keys: OPENAI_BASE_URL");
    expectResultOmitsSecret(provider, apiKey, "hosted Fabric provider route");

    const fabricIdentity = await runNemoclawCli(
      [
        sandboxName,
        "exec",
        "--",
        "bash",
        "-c",
        'set -euo pipefail; [ "$(nemoclaw-fabric --version)" = "nemoclaw-fabric 0.1.2 (nemo-fabric 0.2.0)" ]; /opt/nemoclaw-fabric-venv/bin/python3 -I -c \'from importlib.metadata import metadata, version; expected = {"nemo-fabric": "0.2.0", "nemo-fabric-adapters-deepagents": "0.2.0", "nemoclaw-fabric": "0.1.2"}; actual = {name: version(name) for name in expected}; raise SystemExit(0 if actual == expected and metadata("nemoclaw-fabric")["Requires-Python"] == "<3.14,>=3.13" else 1)\'; printf "%s\\n" NEMOCLAW_FABRIC_IDENTITY_OK',
      ],
      {
        artifactName: "tc-inf-14-fabric-identity",
        artifacts,
        env: commandEnv,
        progress,
        redactionValues: [apiKey],
        timeoutMs: 30_000,
      },
    );
    expect(fabricIdentity.exitCode, redactedResultText(fabricIdentity)).toBe(0);
    expect(fabricIdentity.stdout.trim()).toBe("NEMOCLAW_FABRIC_IDENTITY_OK");
    expectResultOmitsSecret(fabricIdentity, apiKey, "Fabric identity");

    const fabricConfig = await runNemoclawCli(
      [
        sandboxName,
        "exec",
        "--",
        "/opt/nemoclaw-fabric-venv/bin/python3",
        "-I",
        "-c",
        [
          "import json, stat",
          "from pathlib import Path",
          'path = Path("/sandbox/.deepagents/fabric.json")',
          "if path.is_symlink() or not path.is_file() or stat.S_IMODE(path.stat().st_mode) != 0o600: raise SystemExit(1)",
          'config = json.loads(path.read_text(encoding="utf-8"))',
          'if config.get("harness") != {"adapter_id": "nvidia.fabric.langchain.deepagents", "resolution": "preinstalled"}: raise SystemExit(1)',
          'if config.get("models", {}).get("default") != {"provider": "openai-compatible", "model": "nvidia/nvidia/nemotron-3-super-v3", "api_key_env": "DEEPAGENTS_CODE_OPENAI_API_KEY", "base_url": "https://inference.local/v1"}: raise SystemExit(1)',
          'if "invocation_unavailable_reason" in config.get("environment", {}).get("metadata", {}).get("nemoclaw", {}): raise SystemExit(1)',
          'print("NEMOCLAW_FABRIC_ROUTE_OK")',
        ].join("\n"),
      ],
      {
        artifactName: "tc-inf-14-fabric-route",
        artifacts,
        env: commandEnv,
        progress,
        redactionValues: [apiKey],
        timeoutMs: 30_000,
      },
    );
    expect(fabricConfig.exitCode, redactedResultText(fabricConfig)).toBe(0);
    expect(fabricConfig.stdout.trim()).toBe("NEMOCLAW_FABRIC_ROUTE_OK");
    expectResultOmitsSecret(fabricConfig, apiKey, "Fabric route config");

    const fabricProcessesBefore = await runNemoclawCli(
      [
        sandboxName,
        "exec",
        "--",
        "bash",
        "-c",
        'set -euo pipefail; for command_line in /proc/[0-9]*/cmdline; do [ -r "$command_line" ] || continue; argv0="$(tr "\\000" "\\n" <"$command_line" 2>/dev/null | sed -n "1p")"; case "$argv0" in /opt/nemoclaw-fabric-venv/bin/python* | /usr/local/bin/nemoclaw-fabric) printf "%s\\n" "$argv0"; exit 1 ;; esac; done; printf "%s\\n" NEMOCLAW_FABRIC_PROCESSES_CLEAN',
      ],
      {
        artifactName: "tc-inf-14-fabric-processes-before",
        artifacts,
        env: commandEnv,
        progress,
        redactionValues: [apiKey],
        timeoutMs: 30_000,
      },
    );
    expect(fabricProcessesBefore.exitCode, redactedResultText(fabricProcessesBefore)).toBe(0);
    expect(fabricProcessesBefore.stdout.trim()).toBe("NEMOCLAW_FABRIC_PROCESSES_CLEAN");

    progress.phase("request hosted Fabric model and workspace turns");
    const pongTurn = await runNemoclawCli(
      [sandboxName, "agent", "-m", "Reply with exactly one word: PONG", "--json"],
      {
        artifactName: "tc-inf-14-fabric-pong",
        artifacts,
        env: commandEnv,
        progress,
        redactionValues: [apiKey],
        timeoutMs: 3 * 60_000,
      },
    );
    expect(pongTurn.timedOut, redactedResultText(pongTurn)).toBe(false);
    expect(pongTurn.exitCode, redactedResultText(pongTurn)).toBe(0);
    expectResultOmitsSecret(pongTurn, apiKey, "hosted Fabric PONG turn");
    const pongResult = parseJsonObject(pongTurn.stdout, "hosted Fabric PONG turn") as {
      adapter_kind?: unknown;
      harness?: unknown;
      output?: { response?: unknown };
      status?: unknown;
      usage?: { total_tokens?: unknown };
    };
    expect(pongResult).toMatchObject({
      adapter_kind: "python",
      harness: "nvidia.fabric.langchain.deepagents",
      status: "succeeded",
    });
    expect(pongResult.output?.response).toMatch(/\bPONG\b/u);
    expect(
      typeof pongResult.usage?.total_tokens === "number" && pongResult.usage.total_tokens > 0,
    ).toBe(true);

    cleanup.add(`remove hosted Fabric workspace proof from ${sandboxName}`, async () => {
      const result = await runNemoclawCli(
        [
          sandboxName,
          "exec",
          "--",
          "/opt/nemoclaw-fabric-venv/bin/python3",
          "-I",
          "-c",
          HOSTED_FABRIC_WORKSPACE_REMOVE_SCRIPT,
        ],
        {
          artifactName: "tc-inf-14-workspace-fallback-cleanup",
          artifacts,
          env: commandEnv,
          progress,
          redactionValues: [apiKey],
          timeoutMs: 30_000,
        },
      );
      requireSuccessfulCleanupCommand(result, "hosted Fabric workspace cleanup");
    });
    const workspaceBefore = await runNemoclawCli(
      [
        sandboxName,
        "exec",
        "--",
        "/opt/nemoclaw-fabric-venv/bin/python3",
        "-I",
        "-c",
        `from pathlib import Path; path = Path(${JSON.stringify(HOSTED_FABRIC_WORKSPACE_FILE)}); raise SystemExit(1 if path.exists() or path.is_symlink() else 0)`,
      ],
      {
        artifactName: "tc-inf-14-workspace-before",
        artifacts,
        env: commandEnv,
        progress,
        redactionValues: [apiKey],
        timeoutMs: 30_000,
      },
    );
    expect(workspaceBefore.exitCode, redactedResultText(workspaceBefore)).toBe(0);

    const workspaceTurn = await runNemoclawCli(
      [sandboxName, "agent", "-m", HOSTED_FABRIC_WORKSPACE_PROMPT, "--json"],
      {
        artifactName: "tc-inf-14-fabric-workspace",
        artifacts,
        env: commandEnv,
        progress,
        redactionValues: [apiKey],
        timeoutMs: 3 * 60_000,
      },
    );
    expect(workspaceTurn.timedOut, redactedResultText(workspaceTurn)).toBe(false);
    expect(workspaceTurn.exitCode, redactedResultText(workspaceTurn)).toBe(0);
    expectResultOmitsSecret(workspaceTurn, apiKey, "hosted Fabric workspace turn");
    const workspaceResult = parseJsonObject(
      workspaceTurn.stdout,
      "hosted Fabric workspace turn",
    ) as {
      adapter_kind?: unknown;
      harness?: unknown;
      output?: {
        messages?: Array<{
          tool_calls?: Array<{ args?: unknown; name?: unknown }>;
        }>;
        response?: unknown;
      };
      status?: unknown;
    };
    expect(workspaceResult).toMatchObject({
      adapter_kind: "python",
      harness: "nvidia.fabric.langchain.deepagents",
      status: "succeeded",
    });
    expect(typeof workspaceResult.output?.response).toBe("string");
    expect((workspaceResult.output?.response as string).trim()).toBe(
      HOSTED_FABRIC_WORKSPACE_RESPONSE,
    );
    const workspaceToolCalls = (workspaceResult.output?.messages ?? []).flatMap(
      ({ tool_calls }) => tool_calls ?? [],
    );
    expect(workspaceToolCalls).toEqual([
      expect.objectContaining({
        args: {
          content: HOSTED_FABRIC_WORKSPACE_CONTENT,
          file_path: HOSTED_FABRIC_WORKSPACE_VIRTUAL_FILE,
        },
        name: "write_file",
      }),
    ]);

    const workspaceProof = await runNemoclawCli(
      [
        sandboxName,
        "exec",
        "--",
        "/opt/nemoclaw-fabric-venv/bin/python3",
        "-I",
        "-c",
        HOSTED_FABRIC_WORKSPACE_INSPECT_SCRIPT,
      ],
      {
        artifactName: "tc-inf-14-workspace-proof",
        artifacts,
        env: commandEnv,
        progress,
        redactionValues: [apiKey],
        timeoutMs: 30_000,
      },
    );
    expect(workspaceProof.exitCode, redactedResultText(workspaceProof)).toBe(0);
    expect(parseJsonObject(workspaceProof.stdout, "hosted Fabric workspace proof")).toEqual({
      bytes: Buffer.byteLength(HOSTED_FABRIC_WORKSPACE_CONTENT),
      path: HOSTED_FABRIC_WORKSPACE_FILE,
      sha256: crypto.createHash("sha256").update(HOSTED_FABRIC_WORKSPACE_CONTENT).digest("hex"),
    });
    const workspaceCleanup = await runNemoclawCli(
      [
        sandboxName,
        "exec",
        "--",
        "/opt/nemoclaw-fabric-venv/bin/python3",
        "-I",
        "-c",
        HOSTED_FABRIC_WORKSPACE_REMOVE_SCRIPT,
      ],
      {
        artifactName: "tc-inf-14-workspace-cleanup",
        artifacts,
        env: commandEnv,
        progress,
        redactionValues: [apiKey],
        timeoutMs: 30_000,
      },
    );
    expect(workspaceCleanup.exitCode, redactedResultText(workspaceCleanup)).toBe(0);
    expect(workspaceCleanup.stdout.trim()).toBe("NEMOCLAW_FABRIC_WORKSPACE_CLEAN");

    progress.phase("reject an invalid Fabric config without leaking credentials");
    const redactionSentinel = "sk-proj-tc-inf-14-redaction-0123456789";
    const missingConfig = `/sandbox/.deepagents/missing-${redactionSentinel}.json`;
    const rejectedFabric = await runNemoclawCli(
      [sandboxName, "agent", "--config", missingConfig, "-m", "redaction probe", "--json"],
      {
        artifactName: "tc-inf-14-fabric-invalid-config",
        artifacts,
        env: commandEnv,
        progress,
        redactionValues: [apiKey],
        timeoutMs: 30_000,
      },
    );
    expect(rejectedFabric.timedOut).toBe(false);
    expect(rejectedFabric.exitCode).toBe(2);
    expectResultOmitsSecret(rejectedFabric, apiKey, "invalid Fabric config");
    expect(rejectedFabric.stdout.includes(redactionSentinel)).toBe(false);
    expect(parseJsonObject(rejectedFabric.stdout, "invalid Fabric config")).toMatchObject({
      error: {
        code: "invalid_config",
        message: expect.stringContaining("<redacted>"),
        stage: "config",
      },
      status: "failed",
    });

    progress.phase("verify Fabric process and credential cleanup");
    const fabricProcessesAfter = await runNemoclawCli(
      [
        sandboxName,
        "exec",
        "--",
        "bash",
        "-c",
        'set -euo pipefail; for command_line in /proc/[0-9]*/cmdline; do [ -r "$command_line" ] || continue; argv0="$(tr "\\000" "\\n" <"$command_line" 2>/dev/null | sed -n "1p")"; case "$argv0" in /opt/nemoclaw-fabric-venv/bin/python* | /usr/local/bin/nemoclaw-fabric) printf "%s\\n" "$argv0"; exit 1 ;; esac; done; printf "%s\\n" NEMOCLAW_FABRIC_PROCESSES_CLEAN',
      ],
      {
        artifactName: "tc-inf-14-fabric-processes-after",
        artifacts,
        env: commandEnv,
        progress,
        redactionValues: [apiKey],
        timeoutMs: 30_000,
      },
    );
    expect(fabricProcessesAfter.exitCode, redactedResultText(fabricProcessesAfter)).toBe(0);
    expect(fabricProcessesAfter.stdout.trim()).toBe("NEMOCLAW_FABRIC_PROCESSES_CLEAN");
    expectResultOmitsSecret(fabricProcessesAfter, apiKey, "Fabric process cleanup");

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
        artifactName: "tc-inf-14-fabric-credential-snapshot",
        artifactOutputMode: "metadata-only",
        artifacts,
        env: commandEnv,
        progress,
        redactionValues: [apiKey],
        timeoutMs: 30_000,
      },
    );
    expect(credentialSnapshot.exitCode, redactedResultText(credentialSnapshot)).toBe(0);
    expectResultOmitsSecret(credentialSnapshot, apiKey, "bounded Fabric credential snapshot");
    expect(credentialSnapshot.stdout).toMatch(/api_key_env[" =:]+DEEPAGENTS_CODE_OPENAI_API_KEY/u);
    await artifacts.target.complete({
      id: "inference-routing-hosted-fabric",
      packageIdentity: packageEvidence.identity,
      status: "passed",
    });
  },
);
