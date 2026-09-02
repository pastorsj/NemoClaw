// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { execFile as execFileCallback, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import type { ArtifactSink } from "../fixtures/artifacts.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  type PublicFabricAgent,
  PUBLIC_FABRIC_RUNNER_IDENTITY,
  PUBLIC_FABRIC_TURN_PROMPT,
  PUBLIC_FABRIC_TURN_RESPONSE,
  runPublicFabricTurn,
} from "../live/public-fabric-turn.ts";

const execFile = promisify(execFileCallback);

const CONTRACTS = {
  hermes: {
    adapterId: "nvidia.nemoclaw.hermes",
    artifactRoot: "/sandbox/.hermes/fabric-artifacts",
    configPath: "/sandbox/.hermes/fabric.json",
    descriptorGlob: "/usr/local/share/nemoclaw/hermes.fabric-adapter.json",
    descriptorPath: "/usr/local/share/nemoclaw/hermes.fabric-adapter.json",
    descriptorPathPrefix: "/usr/local/share/nemoclaw",
    descriptorRunnerModule: "nemoclaw_hermes_fabric.adapter",
  },
  openclaw: {
    adapterId: "nvidia.nemoclaw.openclaw",
    artifactRoot: "/sandbox/.openclaw/fabric-artifacts",
    configPath: "/sandbox/.openclaw/fabric.json",
    descriptorGlob: "/usr/local/share/nemoclaw/openclaw.fabric-adapter.json",
    descriptorPath: "/usr/local/share/nemoclaw/openclaw.fabric-adapter.json",
    descriptorPathPrefix: "/usr/local/share/nemoclaw",
    descriptorRunnerModule: "nemoclaw_openclaw_fabric.adapter",
  },
} as const;

function shellResult(overrides: Partial<ShellProbeResult> = {}): ShellProbeResult {
  return {
    command: [],
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: `${PUBLIC_FABRIC_TURN_RESPONSE}\n`,
    stderr: "",
    artifacts: {
      stdout: "/tmp/stdout",
      stderr: "/tmp/stderr",
      result: "/tmp/result",
    },
    ...overrides,
  };
}

function configProbe(
  agent: PublicFabricAgent,
  overrides: Record<string, unknown> = {},
): ShellProbeResult {
  const contract = CONTRACTS[agent];
  return shellResult({
    stdout: `${JSON.stringify({
      adapterId: contract.adapterId,
      artifactEntryCount: 0,
      artifactRoot: contract.artifactRoot,
      artifactRootExists: true,
      artifactScanComplete: true,
      artifactTreeBounded: true,
      configCredentialFree: true,
      configMode: "0600",
      configOwner: "sandbox:sandbox",
      configPath: contract.configPath,
      configRegularFile: true,
      configuredArtifactRootsExact: true,
      descriptorAdapterId: contract.adapterId,
      descriptorContractVersion: "fabric.adapter/v1alpha2",
      descriptorPath: contract.descriptorPath,
      descriptorPathBounded: true,
      descriptorRegularFile: true,
      descriptorRunnerModule: contract.descriptorRunnerModule,
      expectedAdapterId: contract.adapterId,
      expectedRunnerModule: contract.descriptorRunnerModule,
      schemaVersion: "fabric.agent/v1alpha1",
      ...overrides,
    })}\n`,
  });
}

function processProbe(overrides: Record<string, unknown> = {}): ShellProbeResult {
  const record: Record<string, unknown> = {
    inspectionComplete: true,
    matchingPids: [],
    newPids: [],
    processIdentities: [{ pid: 7, startTime: "100" }],
    unreadablePids: [],
    ...overrides,
  };
  record.observations =
    "observations" in overrides
      ? overrides.observations
      : [
          {
            attempt: 1,
            matchingCount: (record.matchingPids as unknown[]).length,
            newCount: (record.newPids as unknown[]).length,
            unreadableCount: (record.unreadablePids as unknown[]).length,
          },
        ];
  return shellResult({
    stdout: `${JSON.stringify(record)}\n`,
  });
}

function successfulSandboxResults(agent: PublicFabricAgent): ShellProbeResult[] {
  return [
    processProbe(),
    shellResult({ stdout: `${PUBLIC_FABRIC_RUNNER_IDENTITY}\n` }),
    shellResult({ stdout: '{"checks":[],"status":"pass"}\n' }),
    configProbe(agent),
    processProbe(),
  ];
}

function fixture(
  options: {
    sandboxResults?: ShellProbeResult[];
    turnResult?: ShellProbeResult;
  } = {},
) {
  const nemoclaw = vi
    .fn<HostCliClient["nemoclaw"]>()
    .mockResolvedValue(options.turnResult ?? shellResult());
  const exec = vi.fn<SandboxClient["exec"]>();
  for (const result of options.sandboxResults ?? [processProbe()]) {
    exec.mockResolvedValueOnce(result);
  }
  const writeJson = vi.fn<ArtifactSink["writeJson"]>().mockResolvedValue("/tmp/proof.json");
  return {
    artifacts: { writeJson } as Pick<ArtifactSink, "writeJson">,
    host: { nemoclaw } as Pick<HostCliClient, "nemoclaw">,
    nemoclaw,
    sandbox: { exec } as unknown as SandboxClient,
    sandboxExec: exec,
    writeJson,
  };
}

function runTurn(agent: PublicFabricAgent, harness: ReturnType<typeof fixture>) {
  return runPublicFabricTurn({
    agent,
    artifacts: harness.artifacts,
    env: { PATH: "/test/bin" },
    host: harness.host,
    lifecyclePhase: "before-gateway-restart",
    redactionValues: ["fixture-credential"],
    sandbox: harness.sandbox,
    sandboxName: `fabric-${agent}`,
    timeoutMs: 45_000,
  });
}

describe("public Fabric live turn", () => {
  it.each(["openclaw", "hermes"] as const)(
    "proves one plain %s turn and its pinned runtime integrity",
    async (agent) => {
      const contract = CONTRACTS[agent];
      const harness = fixture({ sandboxResults: successfulSandboxResults(agent) });

      await expect(runTurn(agent, harness)).resolves.toEqual({
        schemaVersion: 1,
        adapterId: contract.adapterId,
        agent,
        artifactEntryCount: 0,
        artifactRoot: contract.artifactRoot,
        artifactRootExists: true,
        command: "nemoclaw sandbox agent <sandbox> <plain prompt>",
        configMode: "0600",
        configOwner: "sandbox:sandbox",
        configPath: contract.configPath,
        descriptorPath: contract.descriptorPath,
        descriptorRunnerModule: contract.descriptorRunnerModule,
        doctorStatus: "pass",
        lifecyclePhase: "before-gateway-restart",
        noLingeringProcesses: true,
        outcome: "succeeded",
        responseSha256: createHash("sha256").update(PUBLIC_FABRIC_TURN_RESPONSE).digest("hex"),
        runnerIdentity: PUBLIC_FABRIC_RUNNER_IDENTITY,
        sandboxName: `fabric-${agent}`,
      });

      expect(harness.nemoclaw).toHaveBeenCalledExactlyOnceWith(
        ["sandbox", "agent", `fabric-${agent}`, PUBLIC_FABRIC_TURN_PROMPT],
        {
          artifactName: `fabric-${agent}-before-gateway-restart-public-agent-turn`,
          env: { PATH: "/test/bin" },
          redactionValues: ["fixture-credential"],
          timeoutMs: 45_000,
        },
      );
      expect(harness.sandboxExec).toHaveBeenCalledTimes(5);
      expect(harness.sandboxExec).toHaveBeenNthCalledWith(
        1,
        `fabric-${agent}`,
        [
          "/opt/nemoclaw-fabric-venv/bin/python3",
          "-I",
          "-c",
          expect.any(String),
          "baseline",
          agent,
          PUBLIC_FABRIC_TURN_PROMPT,
          "[]",
        ],
        expect.objectContaining({
          artifactName: `fabric-${agent}-before-gateway-restart-process-baseline`,
        }),
      );
      expect(harness.sandboxExec).toHaveBeenNthCalledWith(
        2,
        `fabric-${agent}`,
        ["/usr/local/bin/nemoclaw-fabric", "--version"],
        expect.objectContaining({
          artifactName: `fabric-${agent}-before-gateway-restart-runner-version`,
        }),
      );

      const configCommand = harness.sandboxExec.mock.calls[3]![1];
      expect(configCommand.slice(0, 3)).toEqual([
        "/opt/nemoclaw-fabric-venv/bin/python3",
        "-I",
        "-c",
      ]);
      expect(configCommand.slice(4, 10)).toEqual([
        contract.configPath,
        contract.artifactRoot,
        contract.adapterId,
        contract.descriptorGlob,
        contract.descriptorPathPrefix,
        contract.descriptorRunnerModule,
      ]);
      expect(JSON.parse(configCommand[10]!)).toEqual([
        {
          length: Buffer.byteLength("fixture-credential"),
          sha256: createHash("sha256").update("fixture-credential").digest("hex"),
        },
      ]);

      expect(harness.sandboxExec.mock.calls[2]![1]).toEqual([
        "/bin/bash",
        "-lc",
        expect.stringContaining(`nemoclaw-fabric doctor --config ${contract.configPath} --json`),
      ]);
      expect(harness.sandboxExec.mock.calls[4]![1]).toEqual([
        "/opt/nemoclaw-fabric-venv/bin/python3",
        "-I",
        "-c",
        expect.any(String),
        "verify",
        agent,
        PUBLIC_FABRIC_TURN_PROMPT,
        JSON.stringify([{ pid: 7, startTime: "100" }]),
      ]);
      expect(harness.writeJson).toHaveBeenCalledWith(
        `fabric-${agent}-before-gateway-restart-proof.json`,
        expect.objectContaining({
          adapterId: contract.adapterId,
          agent,
          descriptorRunnerModule: contract.descriptorRunnerModule,
          noLingeringProcesses: true,
          outcome: "succeeded",
          runnerIdentity: PUBLIC_FABRIC_RUNNER_IDENTITY,
        }),
      );
    },
  );

  it("accepts the exact root-owned read-only Shields posture and a warning-only doctor", async () => {
    const results = successfulSandboxResults("openclaw");
    results[2] = shellResult({ stdout: '{"checks":[],"status":"warn"}\n' });
    results[3] = configProbe("openclaw", { configMode: "0444", configOwner: "root:root" });
    const harness = fixture({ sandboxResults: results });

    await expect(runTurn("openclaw", harness)).resolves.toMatchObject({
      configMode: "0444",
      configOwner: "root:root",
      doctorStatus: "warn",
    });
  });

  it("executes the private config probe without publishing config bytes or credential digests", async () => {
    const harness = fixture({ sandboxResults: successfulSandboxResults("openclaw") });
    await runTurn("openclaw", harness);
    const configCommand = harness.sandboxExec.mock.calls[3]![1];
    const processCommand = harness.sandboxExec.mock.calls[4]![1];
    const configScript = configCommand[3]!;
    const processScript = processCommand[3]!;
    const root = realpathSync(mkdtempSync(join(tmpdir(), "nemoclaw-fabric-e2e-probe-")));
    try {
      const stateRoot = join(root, "state");
      const artifactRoot = join(stateRoot, "fabric-artifacts");
      const descriptorRoot = join(root, "descriptor");
      const configPath = join(stateRoot, "fabric.json");
      const descriptorPath = join(descriptorRoot, "adapter.json");
      mkdirSync(artifactRoot, { recursive: true });
      mkdirSync(descriptorRoot, { recursive: true });
      writeFileSync(join(artifactRoot, "turn.json"), "{}\n");
      writeFileSync(
        descriptorPath,
        `${JSON.stringify({
          contract_version: "fabric.adapter/v1alpha2",
          adapter_id: CONTRACTS.openclaw.adapterId,
          runner: { module: CONTRACTS.openclaw.descriptorRunnerModule },
        })}\n`,
      );
      writeFileSync(
        configPath,
        `${JSON.stringify({
          schema_version: "fabric.agent/v1alpha1",
          harness: { adapter_id: CONTRACTS.openclaw.adapterId },
          runtime: { artifacts: artifactRoot },
          environment: { artifacts: artifactRoot },
        })}\n`,
      );
      chmodSync(configPath, 0o600);

      const secret = "fixture-probe-secret";
      const fingerprints = JSON.stringify([
        {
          length: Buffer.byteLength(secret),
          sha256: createHash("sha256").update(secret).digest("hex"),
        },
      ]);
      const probe = spawnSync(
        "python3",
        [
          "-I",
          "-c",
          configScript,
          configPath,
          artifactRoot,
          CONTRACTS.openclaw.adapterId,
          descriptorPath,
          descriptorRoot,
          CONTRACTS.openclaw.descriptorRunnerModule,
          fingerprints,
        ],
        { encoding: "utf8", killSignal: "SIGKILL", timeout: 30_000 },
      );
      expect(probe.status, probe.stderr).toBe(0);
      expect(JSON.parse(probe.stdout)).toMatchObject({
        artifactEntryCount: 1,
        artifactTreeBounded: true,
        configCredentialFree: true,
        configMode: "0600",
        configRegularFile: true,
        descriptorAdapterId: CONTRACTS.openclaw.adapterId,
        descriptorPathBounded: true,
        descriptorRegularFile: true,
        descriptorRunnerModule: CONTRACTS.openclaw.descriptorRunnerModule,
      });

      writeFileSync(
        configPath,
        `${JSON.stringify({
          schema_version: "fabric.agent/v1alpha1",
          harness: { adapter_id: CONTRACTS.openclaw.adapterId },
          runtime: { artifacts: artifactRoot },
          environment: { artifacts: artifactRoot },
          leaked: secret,
        })}\n`,
      );
      chmodSync(configPath, 0o600);
      const credentialProbe = spawnSync(
        "python3",
        [
          "-I",
          "-c",
          configScript,
          configPath,
          artifactRoot,
          CONTRACTS.openclaw.adapterId,
          descriptorPath,
          descriptorRoot,
          CONTRACTS.openclaw.descriptorRunnerModule,
          fingerprints,
        ],
        { encoding: "utf8", killSignal: "SIGKILL", timeout: 30_000 },
      );
      expect(credentialProbe.status, credentialProbe.stderr).toBe(0);
      expect(JSON.parse(credentialProbe.stdout).configCredentialFree).toBe(false);

      const syntax = spawnSync(
        "python3",
        ["-c", "compile(__import__('sys').argv[1], '<process-probe>', 'exec')", processScript],
        { encoding: "utf8", killSignal: "SIGKILL", timeout: 30_000 },
      );
      expect(syntax.status, syntax.stderr).toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it.runIf(process.platform === "linux")(
    "detects a detached harness process that appears after the Fabric turn",
    async () => {
      const harness = fixture({ sandboxResults: successfulSandboxResults("hermes") });
      await runTurn("hermes", harness);
      const processScript = harness.sandboxExec.mock.calls[4]![1][3]!;
      const baseline = spawnSync(
        "python3",
        ["-I", "-c", processScript, "baseline", "hermes", PUBLIC_FABRIC_TURN_PROMPT, "[]"],
        { encoding: "utf8", killSignal: "SIGKILL", timeout: 30_000 },
      );
      expect(baseline.status, baseline.stderr).toBe(0);
      const baselineRecord = JSON.parse(baseline.stdout) as {
        processIdentities: Array<{ pid: number; startTime: string }>;
      };
      const leaked = spawn(
        "python3",
        ["-c", "import time; time.sleep(30)", "arbitrary-detached-hermes-tool"],
        { stdio: "ignore" },
      );
      try {
        await new Promise<void>((resolve, reject) => {
          leaked.once("spawn", resolve);
          leaked.once("error", reject);
        });
        const processProbeResult = spawnSync(
          "python3",
          [
            "-I",
            "-c",
            processScript,
            "verify",
            "hermes",
            PUBLIC_FABRIC_TURN_PROMPT,
            JSON.stringify(baselineRecord.processIdentities),
          ],
          { encoding: "utf8", killSignal: "SIGKILL", timeout: 30_000 },
        );
        expect(processProbeResult.status, processProbeResult.stderr).toBe(0);
        const processRecord = JSON.parse(processProbeResult.stdout) as {
          newPids: number[];
          observations: Array<{ newCount: number }>;
        };
        expect(processRecord.newPids).toContain(leaked.pid);
        expect(processRecord.observations).toHaveLength(3);
        expect(processRecord.observations.every((observation) => observation.newCount > 0)).toBe(
          true,
        );
      } finally {
        leaked.kill("SIGKILL");
        await new Promise<void>((resolve) => leaked.once("close", () => resolve()));
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "drops a short-lived exec process from the final observation",
    async () => {
      const harness = fixture({ sandboxResults: successfulSandboxResults("openclaw") });
      await runTurn("openclaw", harness);
      const processScript = harness.sandboxExec.mock.calls[4]![1][3]!;
      const baseline = spawnSync(
        "python3",
        ["-I", "-c", processScript, "baseline", "openclaw", PUBLIC_FABRIC_TURN_PROMPT, "[]"],
        { encoding: "utf8", killSignal: "SIGKILL", timeout: 30_000 },
      );
      expect(baseline.status, baseline.stderr).toBe(0);
      const baselineRecord = JSON.parse(baseline.stdout) as {
        processIdentities: Array<{ pid: number; startTime: string }>;
      };
      const transient = spawn(
        "python3",
        [
          "-u",
          "-c",
          "import time; print('ready', flush=True); time.sleep(0.5)",
          "transient-openshell-exec-session",
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      try {
        await once(transient.stdout!, "data");
        const processProbeResult = await execFile(
          "python3",
          [
            "-I",
            "-c",
            processScript,
            "verify",
            "openclaw",
            PUBLIC_FABRIC_TURN_PROMPT,
            JSON.stringify(baselineRecord.processIdentities),
          ],
          { encoding: "utf8", killSignal: "SIGKILL", timeout: 30_000 },
        );
        const processRecord = JSON.parse(processProbeResult.stdout) as {
          newPids: number[];
          observations: Array<{ newCount: number }>;
        };
        expect(processRecord.observations.length).toBeGreaterThanOrEqual(2);
        expect(processRecord.observations.length).toBeLessThanOrEqual(3);
        expect(processRecord.observations[0]!.newCount).toBeGreaterThan(0);
        expect(transient.pid).toBeTypeOf("number");
        expect(processRecord.newPids).not.toContain(transient.pid);
      } finally {
        await (transient.exitCode === null && transient.signalCode === null
          ? new Promise<void>((resolve) => {
              transient.once("close", () => resolve());
              transient.kill("SIGKILL");
            })
          : Promise.resolve());
      }
    },
  );

  it.each([
    ["a timeout", shellResult({ timedOut: true }), "timed out"],
    ["a failed command", shellResult({ exitCode: 1 }), "turn failed"],
    ["an unexpected response", shellResult({ stdout: "not-pong\n" }), "unexpected response"],
    [
      "credential-bearing output",
      shellResult({ stdout: "fixture-credential\n" }),
      "retained a credential",
    ],
    [
      "redacted credential-bearing output",
      shellResult({ stderr: "[REDACTED]\n" }),
      "retained a credential",
    ],
  ])("rejects %s after only the clean process baseline", async (_label, turnResult, message) => {
    const harness = fixture({ turnResult });

    await expect(runTurn("hermes", harness)).rejects.toThrow(message);
    expect(harness.sandboxExec).toHaveBeenCalledTimes(1);
    expect(harness.writeJson).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "a different runner identity",
      results: [
        processProbe(),
        shellResult({ stdout: "nemoclaw-fabric 0.1.1 (nemo-fabric 0.2.0)\n" }),
      ],
      message: "runner identity",
    },
    {
      label: "credential content in fabric.json",
      results: [
        processProbe(),
        shellResult({ stdout: `${PUBLIC_FABRIC_RUNNER_IDENTITY}\n` }),
        shellResult({ stdout: '{"checks":[],"status":"pass"}\n' }),
        configProbe("hermes", { configCredentialFree: false }),
      ],
      message: "config or artifact-root integrity",
    },
    {
      label: "a mismatched adapter descriptor",
      results: [
        processProbe(),
        shellResult({ stdout: `${PUBLIC_FABRIC_RUNNER_IDENTITY}\n` }),
        shellResult({ stdout: '{"checks":[],"status":"pass"}\n' }),
        configProbe("hermes", { descriptorRunnerModule: "unreviewed.adapter" }),
      ],
      message: "config or artifact-root integrity",
    },
    {
      label: "an artifact tree outside its package root",
      results: [
        processProbe(),
        shellResult({ stdout: `${PUBLIC_FABRIC_RUNNER_IDENTITY}\n` }),
        shellResult({ stdout: '{"checks":[],"status":"pass"}\n' }),
        configProbe("hermes", { artifactTreeBounded: false }),
      ],
      message: "config or artifact-root integrity",
    },
    {
      label: "a missing artifact root",
      results: [
        processProbe(),
        shellResult({ stdout: `${PUBLIC_FABRIC_RUNNER_IDENTITY}\n` }),
        shellResult({ stdout: '{"checks":[],"status":"pass"}\n' }),
        configProbe("hermes", { artifactRootExists: false }),
      ],
      message: "config or artifact-root integrity",
    },
    {
      label: "an unhealthy doctor result",
      results: [
        processProbe(),
        shellResult({ stdout: `${PUBLIC_FABRIC_RUNNER_IDENTITY}\n` }),
        shellResult({ stdout: '{"checks":[],"status":"fail"}\n' }),
      ],
      message: "unhealthy status",
    },
    {
      label: "retained Fabric request artifacts",
      results: [
        processProbe(),
        shellResult({ stdout: `${PUBLIC_FABRIC_RUNNER_IDENTITY}\n` }),
        shellResult({ stdout: '{"checks":[],"status":"pass"}\n' }),
        configProbe("hermes", { artifactEntryCount: 1 }),
      ],
      message: "config or artifact-root integrity",
    },
    {
      label: "a lingering adapter process",
      results: [
        ...successfulSandboxResults("hermes").slice(0, 4),
        processProbe({ matchingPids: [321] }),
      ],
      message: "left a runner, adapter, or agent child process",
    },
    {
      label: "a malformed cleanup observation ledger",
      results: [
        ...successfulSandboxResults("hermes").slice(0, 4),
        processProbe({ observations: [] }),
      ],
      message: "left a runner, adapter, or agent child process",
    },
  ])("rejects $label without writing a success proof", async ({ results, message }) => {
    const harness = fixture({ sandboxResults: results });

    await expect(runTurn("hermes", harness)).rejects.toThrow(message);
    expect(harness.writeJson).not.toHaveBeenCalled();
  });
});
