// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { FabricHarnessE2eContract } from "../../../tools/e2e/fabric-contract.mts";
import { readBundledFabricHarnessE2eFixture } from "../../../tools/e2e/fabric-package.mts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  type PublicFabricHarnessContract,
  PUBLIC_FABRIC_RUNNER_IDENTITY,
  PUBLIC_FABRIC_TURN_PROMPT,
  PUBLIC_FABRIC_TURN_RESPONSE,
  runPublicFabricTurn,
} from "../live/public-fabric-turn.ts";

type TestFabricContract = PublicFabricHarnessContract & { readonly descriptorPath: string };

function loadBundledTestContract(packageId: string): TestFabricContract {
  const contract = readBundledFabricHarnessE2eFixture(packageId);
  return Object.freeze({ ...contract, descriptorPath: contract.descriptorGlob });
}

const CONTRACTS = {
  hermes: loadBundledTestContract("hermes"),
  openclaw: loadBundledTestContract("openclaw"),
} as const;

const FUTURE_CONTRACT = {
  packageId: "future-harness",
  adapterId: "example.fabric.future",
  artifactRoot: "/sandbox/.future-harness/fabric-artifacts",
  configPath: "/sandbox/.future-harness/fabric.json",
  descriptorGlob: "/usr/local/share/nemoclaw/future-harness.fabric-adapter.json",
  descriptorPath: "/usr/local/share/nemoclaw/future-harness.fabric-adapter.json",
  descriptorPathPrefix: "/usr/local/share/nemoclaw",
  descriptorRunnerModule: "future_harness_fabric.adapter",
  processMarkers: ["future_harness_headless"],
} as const satisfies FabricHarnessE2eContract & { readonly descriptorPath: string };

type BundledFabricPackage = keyof typeof CONTRACTS;

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
  contract: TestFabricContract,
  overrides: Record<string, unknown> = {},
  scanPrivateState = true,
): ShellProbeResult {
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
      stateBytesScanned: scanPrivateState ? 128 : null,
      stateCredentialFree: scanPrivateState ? true : null,
      stateEntryCount: scanPrivateState ? 4 : null,
      stateScanComplete: scanPrivateState ? true : null,
      stateScanRequired: scanPrivateState,
      stateTreeBounded: scanPrivateState ? true : null,
      ...overrides,
    })}\n`,
  });
}

function processProbe(overrides: Record<string, unknown> = {}): ShellProbeResult {
  return shellResult({
    stdout: `${JSON.stringify({
      inspectionComplete: true,
      matchingPids: [],
      unreadablePids: [],
      ...overrides,
    })}\n`,
  });
}

function successfulSandboxResults(
  contract: TestFabricContract,
  scanPrivateState: boolean,
): ShellProbeResult[] {
  return [
    processProbe(),
    shellResult({ stdout: `${PUBLIC_FABRIC_RUNNER_IDENTITY}\n` }),
    shellResult({ stdout: '{"checks":[],"status":"pass"}\n' }),
    configProbe(contract, {}, scanPrivateState),
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

function runTurn(
  packageId: BundledFabricPackage,
  harness: ReturnType<typeof fixture>,
  scanPrivateState: boolean,
) {
  const contract = CONTRACTS[packageId];
  return runPublicFabricTurn({
    artifacts: harness.artifacts,
    contract,
    env: { PATH: "/test/bin" },
    host: harness.host,
    lifecyclePhase: "before-gateway-restart",
    redactionValues: ["fixture-credential"],
    sandbox: harness.sandbox,
    sandboxName: `fabric-${packageId}`,
    scanPrivateState,
    timeoutMs: 45_000,
  });
}

describe("public Fabric live turn", () => {
  it.each(["openclaw", "hermes"] as const)(
    "proves one plain %s turn and its pinned runtime integrity",
    async (packageId) => {
      const contract = CONTRACTS[packageId];
      const harness = fixture({
        sandboxResults: successfulSandboxResults(contract, false),
      });

      await expect(runTurn(packageId, harness, false)).resolves.toEqual({
        schemaVersion: 1,
        adapterId: contract.adapterId,
        agent: packageId,
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
        sandboxName: `fabric-${packageId}`,
        stateBytesScanned: null,
        stateCredentialFree: null,
        stateEntryCount: null,
        stateScanRequired: false,
        stateTreeBounded: null,
      });

      expect(harness.nemoclaw).toHaveBeenCalledExactlyOnceWith(
        ["sandbox", "agent", `fabric-${packageId}`, PUBLIC_FABRIC_TURN_PROMPT],
        {
          artifactName: `fabric-${packageId}-before-gateway-restart-public-agent-turn`,
          env: { PATH: "/test/bin" },
          redactionValues: ["fixture-credential"],
          timeoutMs: 45_000,
        },
      );
      expect(harness.sandboxExec).toHaveBeenCalledTimes(5);
      expect(harness.sandboxExec).toHaveBeenNthCalledWith(
        1,
        `fabric-${packageId}`,
        [
          "/opt/nemoclaw-fabric-venv/bin/python3",
          "-I",
          "-c",
          expect.any(String),
          expect.any(String),
        ],
        expect.objectContaining({
          artifactName: `fabric-${packageId}-before-gateway-restart-process-baseline`,
        }),
      );
      expect(harness.sandboxExec).toHaveBeenNthCalledWith(
        2,
        `fabric-${packageId}`,
        ["/usr/local/bin/nemoclaw-fabric", "--version"],
        expect.objectContaining({
          artifactName: `fabric-${packageId}-before-gateway-restart-runner-version`,
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
      expect(configCommand[11]).toBe("not-required");

      expect(harness.sandboxExec.mock.calls[2]![1]).toEqual([
        "/bin/bash",
        "-lc",
        expect.stringContaining('nemoclaw-fabric doctor --config "$1" --json'),
        "nemoclaw-fabric-doctor",
        contract.configPath,
      ]);
      expect(harness.sandboxExec.mock.calls[4]![1]).toEqual([
        "/opt/nemoclaw-fabric-venv/bin/python3",
        "-I",
        "-c",
        expect.any(String),
        expect.any(String),
      ]);
      expect(JSON.parse(harness.sandboxExec.mock.calls[4]![1][4]!)).toEqual(
        expect.arrayContaining([
          PUBLIC_FABRIC_TURN_PROMPT,
          contract.adapterId,
          contract.descriptorRunnerModule,
        ]),
      );
      expect(harness.writeJson).toHaveBeenCalledWith(
        `fabric-${packageId}-before-gateway-restart-proof.json`,
        expect.objectContaining({
          adapterId: contract.adapterId,
          agent: packageId,
          descriptorRunnerModule: contract.descriptorRunnerModule,
          noLingeringProcesses: true,
          outcome: "succeeded",
          runnerIdentity: PUBLIC_FABRIC_RUNNER_IDENTITY,
        }),
      );
    },
  );

  it("proves a future package with an explicit private-state scan", async () => {
    const harness = fixture({
      sandboxResults: successfulSandboxResults(FUTURE_CONTRACT, true),
    });

    await expect(
      runPublicFabricTurn({
        artifacts: harness.artifacts,
        contract: FUTURE_CONTRACT,
        env: { PATH: "/test/bin" },
        host: harness.host,
        lifecyclePhase: "after-onboard",
        redactionValues: ["fixture-credential"],
        sandbox: harness.sandbox,
        sandboxName: "fabric-future-harness",
        scanPrivateState: true,
      }),
    ).resolves.toMatchObject({
      adapterId: FUTURE_CONTRACT.adapterId,
      agent: FUTURE_CONTRACT.packageId,
      descriptorRunnerModule: FUTURE_CONTRACT.descriptorRunnerModule,
      outcome: "succeeded",
    });

    const processCommand = harness.sandboxExec.mock.calls[4]![1];
    const configCommand = harness.sandboxExec.mock.calls[3]![1];
    expect(configCommand[11]).toBe("required");
    expect(JSON.parse(processCommand[4]!)).toEqual(
      expect.arrayContaining([
        FUTURE_CONTRACT.adapterId,
        FUTURE_CONTRACT.descriptorRunnerModule,
        "future-harness.fabric-adapter.json",
        "future_harness_headless",
      ]),
    );
    expect(harness.writeJson).toHaveBeenCalledWith(
      "fabric-future-harness-after-onboard-proof.json",
      expect.objectContaining({
        agent: "future-harness",
        stateCredentialFree: true,
        stateScanRequired: true,
        stateTreeBounded: true,
      }),
    );
  });

  it("scans private state by default for a package contract journey", async () => {
    const harness = fixture({
      sandboxResults: successfulSandboxResults(FUTURE_CONTRACT, true),
    });

    await expect(
      runPublicFabricTurn({
        artifacts: harness.artifacts,
        contract: FUTURE_CONTRACT,
        env: { PATH: "/test/bin" },
        host: harness.host,
        lifecyclePhase: "after-onboard",
        redactionValues: [],
        sandbox: harness.sandbox,
        sandboxName: "fabric-future-harness",
      }),
    ).resolves.toMatchObject({ stateScanRequired: true });
    expect(harness.sandboxExec.mock.calls[3]![1][11]).toBe("required");
  });

  it.each([
    {
      ...FUTURE_CONTRACT,
      packageId: "../future-harness",
    },
    {
      ...FUTURE_CONTRACT,
      descriptorGlob: "relative/adapter.json",
    },
    {
      ...FUTURE_CONTRACT,
      descriptorRunnerModule: "future-harness.adapter",
    },
    {
      ...FUTURE_CONTRACT,
      processMarkers: ["invalid\nmarker"],
    },
    {
      ...FUTURE_CONTRACT,
      processMarkers: Array.from({ length: 17 }, (_, index) => `marker-${index}`),
    },
    {
      ...FUTURE_CONTRACT,
      processMarkers: ["x".repeat(257)],
    },
  ])("rejects an invalid package-owned proof contract", async (contract) => {
    const harness = fixture();

    await expect(
      runPublicFabricTurn({
        artifacts: harness.artifacts,
        contract,
        env: { PATH: "/test/bin" },
        host: harness.host,
        lifecyclePhase: "after-onboard",
        redactionValues: [],
        sandbox: harness.sandbox,
        sandboxName: "fabric-future-harness",
      }),
    ).rejects.toThrow("public Fabric proof contract is invalid");
    expect(harness.sandboxExec).not.toHaveBeenCalled();
  });

  it("uses an immutable proof-contract snapshot across asynchronous probes", async () => {
    const mutableContract = structuredClone(FUTURE_CONTRACT);
    const harness = fixture({
      sandboxResults: successfulSandboxResults(FUTURE_CONTRACT, true),
    });
    const pending = runPublicFabricTurn({
      artifacts: harness.artifacts,
      contract: mutableContract,
      env: { PATH: "/test/bin" },
      host: harness.host,
      lifecyclePhase: "after-onboard",
      redactionValues: [],
      sandbox: harness.sandbox,
      sandboxName: "fabric-future-harness",
    });

    const mutationTarget = mutableContract as unknown as { adapterId: string };
    mutationTarget.adapterId = "example.fabric.changed";

    await expect(pending).resolves.toMatchObject({ adapterId: FUTURE_CONTRACT.adapterId });
    expect(harness.sandboxExec.mock.calls[3]![1]).toContain(FUTURE_CONTRACT.adapterId);
    expect(harness.sandboxExec.mock.calls[3]![1]).not.toContain(mutationTarget.adapterId);
  });

  it("accepts the exact root-owned read-only Shields posture and a warning-only doctor", async () => {
    const results = successfulSandboxResults(CONTRACTS.openclaw, false);
    results[2] = shellResult({ stdout: '{"checks":[],"status":"warn"}\n' });
    results[3] = configProbe(
      CONTRACTS.openclaw,
      { configMode: "0444", configOwner: "root:root" },
      false,
    );
    const harness = fixture({ sandboxResults: results });

    await expect(runTurn("openclaw", harness, false)).resolves.toMatchObject({
      configMode: "0444",
      configOwner: "root:root",
      doctorStatus: "warn",
    });
  });

  it("executes the bounded private state probe without publishing credential evidence", async () => {
    const harness = fixture({
      sandboxResults: successfulSandboxResults(CONTRACTS.openclaw, false),
    });
    await runTurn("openclaw", harness, false);
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
      const sessionRoot = join(stateRoot, "sessions");
      const sessionPath = join(sessionRoot, "turn.json");
      mkdirSync(artifactRoot, { recursive: true });
      mkdirSync(descriptorRoot, { recursive: true });
      mkdirSync(sessionRoot, { recursive: true });
      writeFileSync(join(artifactRoot, "turn.json"), "{}\n");
      writeFileSync(sessionPath, '{"status":"clean"}\n');
      writeFileSync(
        descriptorPath,
        `${JSON.stringify({
          contract_version: "fabric.adapter/v1alpha2",
          adapter_id: CONTRACTS.openclaw.adapterId,
          runner: { module: CONTRACTS.openclaw.descriptorRunnerModule },
        })}\n`,
      );
      const cleanConfig = `${JSON.stringify({
        schema_version: "fabric.agent/v1alpha1",
        harness: { adapter_id: CONTRACTS.openclaw.adapterId },
        runtime: { artifacts: artifactRoot },
        environment: { artifacts: artifactRoot },
      })}\n`;
      writeFileSync(configPath, cleanConfig);
      chmodSync(configPath, 0o600);

      const secret = "fixture-probe-secret";
      const fingerprintDigest = createHash("sha256").update(secret).digest("hex");
      const fingerprints = JSON.stringify([
        {
          length: Buffer.byteLength(secret),
          sha256: fingerprintDigest,
        },
      ]);
      const probeArguments = [
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
        "required",
      ];
      const runConfigProbe = () =>
        spawnSync("python3", probeArguments, {
          encoding: "utf8",
          killSignal: "SIGKILL",
          timeout: 30_000,
        });

      const probe = runConfigProbe();
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
        stateCredentialFree: true,
        stateScanComplete: true,
        stateTreeBounded: true,
      });
      expect(JSON.parse(probe.stdout).stateBytesScanned).toBeGreaterThan(0);
      expect(JSON.parse(probe.stdout).stateEntryCount).toBeGreaterThan(0);
      expect(probe.stdout).not.toContain(secret);
      expect(probe.stdout).not.toContain(fingerprintDigest);

      writeFileSync(sessionPath, `{"credential":"${secret}"}\n`);
      const nativeCredentialProbe = runConfigProbe();
      expect(nativeCredentialProbe.status, nativeCredentialProbe.stderr).toBe(0);
      expect(JSON.parse(nativeCredentialProbe.stdout)).toMatchObject({
        configCredentialFree: true,
        stateCredentialFree: false,
        stateScanComplete: true,
        stateTreeBounded: true,
      });
      expect(nativeCredentialProbe.stdout).not.toContain(secret);
      expect(nativeCredentialProbe.stdout).not.toContain(fingerprintDigest);

      writeFileSync(sessionPath, '{"status":"clean"}\n');
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
      const credentialProbe = runConfigProbe();
      expect(credentialProbe.status, credentialProbe.stderr).toBe(0);
      expect(JSON.parse(credentialProbe.stdout).configCredentialFree).toBe(false);
      expect(credentialProbe.stdout).not.toContain(secret);
      expect(credentialProbe.stdout).not.toContain(fingerprintDigest);

      writeFileSync(configPath, cleanConfig);
      chmodSync(configPath, 0o600);
      const unsafeTarget = join(root, "outside-state.txt");
      const unsafeLink = join(stateRoot, "outside-state-link");
      writeFileSync(unsafeTarget, secret);
      symlinkSync(unsafeTarget, unsafeLink);
      const unsafeTreeProbe = runConfigProbe();
      expect(unsafeTreeProbe.status, unsafeTreeProbe.stderr).toBe(0);
      expect(JSON.parse(unsafeTreeProbe.stdout)).toMatchObject({
        stateCredentialFree: true,
        stateScanComplete: true,
        stateTreeBounded: false,
      });
      expect(unsafeTreeProbe.stdout).not.toContain("outside-state-link");
      expect(unsafeTreeProbe.stdout).not.toContain(secret);
      expect(unsafeTreeProbe.stdout).not.toContain(fingerprintDigest);
      rmSync(unsafeLink);

      const oversizedPath = join(stateRoot, "oversized-state.bin");
      writeFileSync(oversizedPath, "");
      truncateSync(oversizedPath, 64 * 1024 * 1024 + 1);
      const oversizedProbe = runConfigProbe();
      expect(oversizedProbe.status, oversizedProbe.stderr).toBe(0);
      expect(JSON.parse(oversizedProbe.stdout)).toMatchObject({
        stateCredentialFree: true,
        stateScanComplete: false,
        stateTreeBounded: true,
      });
      expect(JSON.parse(oversizedProbe.stdout).stateBytesScanned).toBeLessThanOrEqual(
        64 * 1024 * 1024,
      );
      rmSync(oversizedPath);

      const manyEntriesRoot = join(stateRoot, "many-entries");
      mkdirSync(manyEntriesRoot);
      for (let index = 0; index < 4097; index += 1) {
        writeFileSync(join(manyEntriesRoot, `entry-${index}`), "");
      }
      const excessiveEntriesProbe = runConfigProbe();
      expect(excessiveEntriesProbe.status, excessiveEntriesProbe.stderr).toBe(0);
      expect(JSON.parse(excessiveEntriesProbe.stdout)).toMatchObject({
        stateCredentialFree: true,
        stateEntryCount: 4097,
        stateScanComplete: false,
        stateTreeBounded: true,
      });

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
    "reports a detached Hermes process without treating transport as harness state",
    async () => {
      const harness = fixture({
        sandboxResults: successfulSandboxResults(CONTRACTS.hermes, false),
      });
      await runTurn("hermes", harness, false);
      const processScript = harness.sandboxExec.mock.calls[4]![1][3]!;
      const leaked = spawn(
        "python3",
        ["-c", "import time; time.sleep(30)", "nemoclaw_hermes_fabric-detached-child"],
        { stdio: "ignore" },
      );
      const transport = spawn(
        "python3",
        ["-c", "import time; time.sleep(30)", "unrelated-openshell-exec-session"],
        { stdio: "ignore" },
      );
      try {
        await Promise.all(
          [leaked, transport].map(
            (child) =>
              new Promise<void>((resolve, reject) => {
                child.once("spawn", resolve);
                child.once("error", reject);
              }),
          ),
        );
        const processProbeResult = spawnSync(
          "python3",
          [
            "-I",
            "-c",
            processScript,
            JSON.stringify([
              "nemoclaw-fabric",
              "nemoclaw_fabric",
              PUBLIC_FABRIC_TURN_PROMPT,
              CONTRACTS.hermes.adapterId,
              CONTRACTS.hermes.descriptorRunnerModule,
              "hermes.fabric-adapter.json",
              ...(CONTRACTS.hermes.processMarkers ?? []),
            ]),
          ],
          { encoding: "utf8", killSignal: "SIGKILL", timeout: 30_000 },
        );
        expect(processProbeResult.status, processProbeResult.stderr).toBe(0);
        const processRecord = JSON.parse(processProbeResult.stdout) as {
          matchingPids: number[];
        };
        expect(processRecord.matchingPids).toContain(leaked.pid);
        expect(processRecord.matchingPids).not.toContain(transport.pid);
      } finally {
        leaked.kill("SIGKILL");
        transport.kill("SIGKILL");
        await Promise.all(
          [leaked, transport].map(
            (child) => new Promise<void>((resolve) => child.once("close", () => resolve())),
          ),
        );
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

    await expect(runTurn("hermes", harness, false)).rejects.toThrow(message);
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
        configProbe(CONTRACTS.hermes, { configCredentialFree: false }, false),
      ],
      message: "config, state, or artifact integrity",
    },
    {
      label: "a mismatched adapter descriptor",
      results: [
        processProbe(),
        shellResult({ stdout: `${PUBLIC_FABRIC_RUNNER_IDENTITY}\n` }),
        shellResult({ stdout: '{"checks":[],"status":"pass"}\n' }),
        configProbe(CONTRACTS.hermes, { descriptorRunnerModule: "unreviewed.adapter" }, false),
      ],
      message: "config, state, or artifact integrity",
    },
    {
      label: "an artifact tree outside its package root",
      results: [
        processProbe(),
        shellResult({ stdout: `${PUBLIC_FABRIC_RUNNER_IDENTITY}\n` }),
        shellResult({ stdout: '{"checks":[],"status":"pass"}\n' }),
        configProbe(CONTRACTS.hermes, { artifactTreeBounded: false }, false),
      ],
      message: "config, state, or artifact integrity",
    },
    {
      label: "a missing artifact root",
      results: [
        processProbe(),
        shellResult({ stdout: `${PUBLIC_FABRIC_RUNNER_IDENTITY}\n` }),
        shellResult({ stdout: '{"checks":[],"status":"pass"}\n' }),
        configProbe(CONTRACTS.hermes, { artifactRootExists: false }, false),
      ],
      message: "config, state, or artifact integrity",
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
        configProbe(CONTRACTS.hermes, { artifactEntryCount: 1 }, false),
      ],
      message: "config, state, or artifact integrity",
    },
    {
      label: "a lingering adapter process",
      results: [
        ...successfulSandboxResults(CONTRACTS.hermes, false).slice(0, 4),
        processProbe({ matchingPids: [321] }),
      ],
      message: "left a known runner, adapter, or harness process",
    },
    {
      label: "an unreadable process during cleanup inspection",
      results: [
        ...successfulSandboxResults(CONTRACTS.hermes, false).slice(0, 4),
        processProbe({ inspectionComplete: false, unreadablePids: [321] }),
      ],
      message: "left a known runner, adapter, or harness process",
    },
  ])("rejects $label without writing a success proof", async ({ results, message }) => {
    const harness = fixture({ sandboxResults: results });

    await expect(runTurn("hermes", harness, false)).rejects.toThrow(message);
    expect(harness.writeJson).not.toHaveBeenCalled();
  });

  it.each([
    ["credential content", { stateCredentialFree: false }],
    ["an incomplete scan", { stateScanComplete: false }],
    ["an unbounded tree", { stateTreeBounded: false }],
  ])("rejects package-native state with %s", async (_label, stateOverride) => {
    const results = successfulSandboxResults(FUTURE_CONTRACT, true);
    results[3] = configProbe(FUTURE_CONTRACT, stateOverride);
    const harness = fixture({ sandboxResults: results });

    await expect(
      runPublicFabricTurn({
        artifacts: harness.artifacts,
        contract: FUTURE_CONTRACT,
        env: { PATH: "/test/bin" },
        host: harness.host,
        lifecyclePhase: "after-onboard",
        redactionValues: ["fixture-credential"],
        sandbox: harness.sandbox,
        sandboxName: "fabric-future-harness",
      }),
    ).rejects.toThrow("config, state, or artifact integrity");
    expect(harness.writeJson).not.toHaveBeenCalled();
  });
});
