// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, expectTypeOf, it } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import {
  type CommandRunner,
  GatewayClient,
  HostCliClient,
  SandboxClient,
} from "../fixtures/clients/index.ts";
import type { E2ETargetFixtures } from "../fixtures/e2e-test.ts";
import type {
  HarnessPackageEvidence,
  HarnessPackageIdentity,
} from "../fixtures/harness-package.ts";
import { type NemoClawInstance, StateValidationPhaseFixture } from "../fixtures/phases/index.ts";
import {
  latestRebuildBackupDir,
  listCredentialLeakPaths,
  patchRegistrySandboxEntry,
  readRebuildBackupManifest,
  readRegistrySandboxEntry,
  restoreRegistryAndSession,
  snapshotRegistryAndSession,
} from "../fixtures/phases/state-validation.ts";
import type {
  ShellProbeResult,
  ShellProbeRunOptions,
  TrustedShellCommand,
} from "../fixtures/shell-probe.ts";

interface RunnerCall {
  command: string;
  args: string[];
  options?: ShellProbeRunOptions;
}

const GATEWAY_HEALTH_CURL_ARGS = [
  "-fsS",
  "-o",
  "/dev/null",
  "-w",
  "%{http_code}",
  "--max-time",
  "5",
  "http://127.0.0.1:18789/health",
];
const GATEWAY_BASE_CURL_ARGS = [
  "-fsS",
  "-o",
  "/dev/null",
  "-w",
  "%{http_code}",
  "--max-time",
  "5",
  "http://127.0.0.1:18789/",
];
const GATEWAY_ABSENT_HEALTH_CURL_ARGS = [
  "-fsS",
  "-o",
  "/dev/null",
  "-w",
  "%{http_code}",
  "--max-time",
  "3",
  "http://127.0.0.1:18789/health",
];

function shellResult(exitCode: number, output = ""): ShellProbeResult {
  return {
    command: [],
    exitCode,
    signal: null,
    timedOut: false,
    stdout: exitCode === 0 ? output : "",
    stderr: exitCode === 0 ? "" : output,
    artifacts: {
      stdout: "/tmp/stdout.txt",
      stderr: "/tmp/stderr.txt",
      result: "/tmp/result.json",
    },
  };
}

function packageIdentity(
  id: "openclaw" | "hermes" | "langchain-deepagents-code" = "openclaw",
  digest = "a".repeat(64),
): HarnessPackageIdentity {
  return {
    kind: "agent-runtime",
    id,
    packageVersion: "1.0.0",
    contentDigest: digest,
  };
}

function packageInventory(identity: HarnessPackageIdentity): string {
  return JSON.stringify({
    schemaVersion: 1,
    installed: [
      {
        id: identity.id,
        displayName: `Display ${identity.id}`,
        health: "healthy",
        identity,
      },
    ],
    available: [
      {
        displayName: `Display ${identity.id}`,
        identity,
        installationState: "active",
      },
    ],
  });
}

function packageEvidence(identity: HarnessPackageIdentity): HarnessPackageEvidence {
  return {
    identity,
    installResult: shellResult(0, "installed\n"),
    inventoryResult: shellResult(0, packageInventory(identity)),
  };
}

function packageStateIo(
  identity: HarnessPackageIdentity,
  options: {
    registryAgent?: unknown;
    registryIdentity?: unknown;
    sessionAgent?: unknown;
    sessionIdentity?: unknown;
  } = {},
) {
  return {
    readOnboardSession: () => ({
      agent: options.sessionAgent === undefined ? identity.id : options.sessionAgent,
      harnessPackage: options.sessionIdentity === undefined ? identity : options.sessionIdentity,
    }),
    readRegistry: () => ({
      entries: {
        "e2e-cloud-oc": {
          agent: options.registryAgent === undefined ? identity.id : options.registryAgent,
          harnessPackage:
            options.registryIdentity === undefined ? identity : options.registryIdentity,
        },
      },
    }),
  };
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

class FakeRunner implements CommandRunner {
  readonly calls: RunnerCall[] = [];
  private readonly responses: Array<ShellProbeResult | Error> = [];

  enqueue(response: ShellProbeResult): void {
    this.responses.push(response);
  }

  enqueueError(error: Error): void {
    this.responses.push(error);
  }

  async run(
    command: TrustedShellCommand,
    options?: ShellProbeRunOptions,
  ): Promise<ShellProbeResult> {
    this.calls.push({
      command: command.command,
      args: [...command.args],
      options,
    });
    const response = this.responses.shift();
    if (response instanceof Error) {
      throw response;
    }
    return response ?? shellResult(0);
  }
}

function instance(overrides: Partial<NemoClawInstance> = {}): NemoClawInstance {
  return {
    onboarding: "cloud-openclaw",
    sandboxName: "e2e-cloud-oc",
    agent: "openclaw",
    provider: "nvidia",
    providerEnv: "cloud",
    gatewayUrl: "http://127.0.0.1:18789",
    harnessPackage: null,
    result: shellResult(0),
    ...overrides,
  };
}

function fixture(
  runner: FakeRunner,
  io: ConstructorParameters<typeof StateValidationPhaseFixture>[3] = {},
  artifacts?: ArtifactSink,
): StateValidationPhaseFixture {
  const host = new HostCliClient(runner);
  const sandbox = new SandboxClient(runner);
  return new StateValidationPhaseFixture(
    host,
    new GatewayClient(host, sandbox),
    sandbox,
    io,
    artifacts,
  );
}

describe("state-validation phase fixture", () => {
  it("validates a ready expected state through CLI, gateway health, and sandbox registry probes", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(0, "200"));
    runner.enqueue(shellResult(0, "NAME\ne2e-cloud-oc\n"));

    const result = await fixture(runner).from("cloud-openclaw-ready", instance());

    expect(result.state.id).toBe("cloud-openclaw-ready");
    expect(result.probes.map((probe) => probe.id)).toEqual([
      "cli-installed",
      "gateway-healthy",
      "sandbox-running",
    ]);
    expect(runner.calls).toEqual([
      {
        command: "nemoclaw",
        args: ["--version"],
        options: {
          artifactName: "nemoclaw-version",
          env: expect.objectContaining({
            PATH: expect.any(String),
          }),
        },
      },
      {
        command: "curl",
        args: GATEWAY_HEALTH_CURL_ARGS,
        options: {
          artifactName: "gateway-health",
          env: expect.objectContaining({
            PATH: expect.any(String),
          }),
          redactionValues: ["http://127.0.0.1:18789/health"],
        },
      },
      {
        command: "nemoclaw",
        args: ["list"],
        options: {
          artifactName: "sandbox-running-nemoclaw-list",
          env: expect.objectContaining({
            PATH: expect.any(String),
          }),
        },
      },
    ]);
  });

  it("accepts a healthy gateway base URL fallback when the health endpoint is unavailable", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(7, "connection refused"));
    runner.enqueue(shellResult(0, "204"));
    runner.enqueue(shellResult(0, "NAME\ne2e-cloud-oc\n"));

    const result = await fixture(runner).from("cloud-openclaw-ready", instance());

    expect(result.probes.find((probe) => probe.id === "gateway-healthy")?.results).toHaveLength(2);
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["--version"],
      GATEWAY_HEALTH_CURL_ARGS,
      GATEWAY_BASE_CURL_ARGS,
      ["list"],
    ]);
  });

  it("accepts the sandbox-local Ollama gateway fallback", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(7, "connection refused"));
    runner.enqueue(shellResult(7, "connection refused"));
    runner.enqueue(shellResult(0, "401"));
    runner.enqueue(shellResult(0, "NAME\ne2e-cloud-oc\n"));

    const result = await fixture(runner).from(
      "local-ollama-openclaw-ready",
      instance({
        provider: "ollama",
        providerEnv: "local",
      }),
    );

    expect(result.probes.find((probe) => probe.id === "gateway-healthy")?.results).toHaveLength(3);
    expect(runner.calls[3]).toMatchObject({
      command: "openshell",
      args: [
        "sandbox",
        "exec",
        "-n",
        "e2e-cloud-oc",
        "--",
        "curl",
        "-sS",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "--max-time",
        "5",
        "http://localhost:18789/health",
      ],
    });
  });

  it("fails a gateway-healthy probe if the gateway HTTP probes are unhealthy", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(7, "connection refused"));
    runner.enqueue(shellResult(7, "connection refused"));

    await expect(fixture(runner).from("cloud-openclaw-ready", instance())).rejects.toThrow(
      /expected gateway .* to be healthy/,
    );
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["--version"],
      GATEWAY_HEALTH_CURL_ARGS,
      GATEWAY_BASE_CURL_ARGS,
    ]);
  });

  it("fails a sandbox-running probe if NemoClaw does not list the sandbox", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(0, "200"));
    runner.enqueue(shellResult(0, "NAME\nother-sandbox\n"));

    await expect(fixture(runner).from("cloud-openclaw-ready", instance())).rejects.toThrow(
      /nemoclaw did not list it/,
    );
  });

  it("validates an expected preflight failure with absent gateway and sandbox probes", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(1, "gateway stopped"));
    runner.enqueue(shellResult(7, "connection refused"));
    runner.enqueue(shellResult(0, "NAME\nother-sandbox\n"));
    runner.enqueue(shellResult(0, "other-sandbox\n"));

    const result = await fixture(runner).from(
      "preflight-failure-no-sandbox",
      instance({
        onboarding: "cloud-openclaw-no-docker",
        sandboxName: "e2e-no-docker",
        expectedFailure: {
          phase: "preflight",
          errorClass: "docker-missing",
        },
      }),
    );

    expect(result.probes.map((probe) => probe.id)).toEqual([
      "cli-installed",
      "gateway-absent",
      "sandbox-absent",
    ]);
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["--version"],
      ["gateway", "status"],
      GATEWAY_ABSENT_HEALTH_CURL_ARGS,
      ["list"],
      ["sandbox", "list"],
    ]);
    expect(result.probes.find((probe) => probe.id === "gateway-absent")?.results).toHaveLength(2);
  });

  it("fails a gateway-absent probe if the gateway is running", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(0, "gateway healthy\n"));

    await expect(fixture(runner).from("preflight-failure-no-sandbox", instance())).rejects.toThrow(
      /expected gateway to be absent/,
    );
  });

  it("fails a gateway-absent probe if the gateway health endpoint responds", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(1, "gateway status unavailable\n"));
    runner.enqueue(shellResult(0, "ok\n"));

    await expect(fixture(runner).from("preflight-failure-no-sandbox", instance())).rejects.toThrow(
      /health responded healthy/,
    );
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["--version"],
      ["gateway", "status"],
      GATEWAY_ABSENT_HEALTH_CURL_ARGS,
    ]);
  });

  it("requires a loopback gateway URL for gateway-absent health probes", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(1, "gateway stopped"));

    await expect(
      fixture(runner).from(
        "preflight-failure-no-sandbox",
        instance({
          gatewayUrl: "http://10.0.0.1:18789",
        }),
      ),
    ).rejects.toThrow(/private or link-local/);
  });

  it("fails a sandbox-absent probe if NemoClaw lists the sandbox", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(1, "gateway stopped"));
    runner.enqueue(shellResult(7, "connection refused"));
    runner.enqueue(shellResult(0, "NAME\ne2e-cloud-oc\n"));

    await expect(fixture(runner).from("preflight-failure-no-sandbox", instance())).rejects.toThrow(
      /nemoclaw listed it/,
    );
  });

  it("fails a sandbox-absent probe if OpenShell lists the sandbox", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(1, "gateway stopped"));
    runner.enqueue(shellResult(7, "connection refused"));
    runner.enqueue(shellResult(0, "NAME\nother-sandbox\n"));
    runner.enqueue(shellResult(0, "NAME\ne2e-cloud-oc\n"));

    await expect(fixture(runner).from("preflight-failure-no-sandbox", instance())).rejects.toThrow(
      /OpenShell listed it/,
    );
  });

  it("tolerates an unavailable OpenShell list after NemoClaw list reports no sandbox", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(1, "gateway stopped"));
    runner.enqueue(shellResult(7, "connection refused"));
    runner.enqueue(shellResult(0, "NAME\nother-sandbox\n"));
    runner.enqueueError(new Error("spawn openshell ENOENT"));

    const result = await fixture(runner).from("preflight-failure-no-sandbox", instance());

    const sandboxAbsent = result.probes.find((probe) => probe.id === "sandbox-absent");
    expect(sandboxAbsent?.results).toHaveLength(1);
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["--version"],
      ["gateway", "status"],
      GATEWAY_ABSENT_HEALTH_CURL_ARGS,
      ["list"],
      ["sandbox", "list"],
    ]);
  });

  it("fails a sandbox-absent probe if OpenShell list errors unexpectedly", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(1, "gateway stopped"));
    runner.enqueue(shellResult(7, "connection refused"));
    runner.enqueue(shellResult(0, "NAME\nother-sandbox\n"));
    runner.enqueueError(new Error("openshell permission denied"));

    await expect(fixture(runner).from("preflight-failure-no-sandbox", instance())).rejects.toThrow(
      /could not verify OpenShell sandbox absence/,
    );
  });

  it("does not treat sandbox name substrings as present", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
    runner.enqueue(shellResult(1, "gateway stopped"));
    runner.enqueue(shellResult(7, "connection refused"));
    runner.enqueue(shellResult(0, "NAME\ne2e-cloud-oc-old\n"));
    runner.enqueue(shellResult(0, "NAME\nold-e2e-cloud-oc\n"));

    const result = await fixture(runner).from("preflight-failure-no-sandbox", instance());

    expect(result.probes.map((probe) => probe.id)).toEqual([
      "cli-installed",
      "gateway-absent",
      "sandbox-absent",
    ]);
  });

  it("does not pass unrelated secret environment values to status probes", async () => {
    const original = process.env.NVIDIA_INFERENCE_API_KEY;
    process.env.NVIDIA_INFERENCE_API_KEY = "nvapi-test-secret-value";
    try {
      const runner = new FakeRunner();
      runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
      runner.enqueue(shellResult(1, "gateway stopped"));
      runner.enqueue(shellResult(7, "connection refused"));
      runner.enqueue(shellResult(0, "NAME\nother-sandbox\n"));
      runner.enqueue(shellResult(0, "other-sandbox\n"));

      await fixture(runner).from("preflight-failure-no-sandbox", instance());

      runner.calls.slice(1).forEach((call) => {
        expect(call.options?.env).toEqual(expect.objectContaining({ PATH: expect.any(String) }));
        expect(call.options?.env).not.toHaveProperty("NVIDIA_INFERENCE_API_KEY");
      });
    } finally {
      if (original === undefined) {
        delete process.env.NVIDIA_INFERENCE_API_KEY;
      } else {
        process.env.NVIDIA_INFERENCE_API_KEY = original;
      }
    }
  });

  it("requires an instance for probes that use instance context", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));

    await expect(fixture(runner).from("cloud-openclaw-ready")).rejects.toThrow(
      /probe 'gateway-healthy' requires a NemoClaw instance/,
    );
  });

  it("runs only the CLI probe for optional platform state", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));

    const result = await fixture(runner).from("macos-cli-ready-docker-optional");

    expect(result.probes.map((probe) => probe.id)).toEqual(["cli-installed"]);
    expect(runner.calls.map((call) => call.args)).toEqual([["--version"]]);
  });

  it("rejects unknown expected-state IDs", async () => {
    const runner = new FakeRunner();

    await expect(fixture(runner).from("missing-state", instance())).rejects.toThrow(
      /Unknown expected_state/,
    );
  });

  it("exposes direct registry and sandbox marker helpers for survival checks", async () => {
    const runner = new FakeRunner();
    const fx = fixture(runner, {
      readRegistry: () => ({
        entries: { "e2e-cloud-oc": {} },
      }),
    });

    expect(() => fx.expectLocalRegistryContains("e2e-cloud-oc")).not.toThrow();
    runner.enqueue(shellResult(0));
    runner.enqueue(shellResult(0, "survived\n"));
    runner.enqueue(shellResult(0, "/sandbox/.openclaw/config.json\n"));

    const marker = {
      path: "/sandbox/.openclaw/.survival-marker",
      value: "survived",
    };
    await fx.writeSandboxMarkers(instance(), [marker]);
    await fx.expectSandboxMarkers(instance(), [marker]);
    await fx.expectSandboxDirectoryPopulated(instance(), "/sandbox/.openclaw");

    expect(runner.calls.map((call) => call.args.slice(0, 7))).toEqual([
      ["sandbox", "exec", "-n", "e2e-cloud-oc", "--", "sh", "-lc"],
      ["sandbox", "exec", "-n", "e2e-cloud-oc", "--", "sh", "-lc"],
      ["sandbox", "exec", "-n", "e2e-cloud-oc", "--", "sh", "-lc"],
    ]);
  });

  it("writes a state-validation phase result artifact on success", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-state-validation-artifacts-"));
    try {
      const runner = new FakeRunner();
      runner.enqueue(shellResult(0, "nemoclaw v0.0.0\n"));
      const fx = fixture(runner, {}, new ArtifactSink(tmp));

      await fx.from("macos-cli-ready-docker-optional");

      expect(readJson(path.join(tmp, "state-validation.result.json"))).toMatchObject({
        phase: "state-validation",
        status: "passed",
        expectedStateId: "macos-cli-ready-docker-optional",
        probes: ["cli-installed"],
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("writes a state-validation phase result artifact on failure", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-state-validation-artifacts-"));
    try {
      const fx = fixture(new FakeRunner(), {}, new ArtifactSink(tmp));

      await expect(fx.from("missing-state", instance())).rejects.toThrow(/Unknown expected_state/);

      expect(readJson(path.join(tmp, "state-validation.result.json"))).toMatchObject({
        phase: "state-validation",
        status: "failed",
        expectedStateId: "missing-state",
        probes: [],
        error: expect.stringContaining("Unknown expected_state"),
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("requires final inventory, Session, and registry to retain one exact package identity", async () => {
    const identity = packageIdentity();
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, packageInventory(identity)));
    const io = packageStateIo(identity, { registryAgent: null, sessionAgent: null });

    const result = await fixture(runner, io).from(
      { id: "synthetic-package-identity-ready" },
      instance({ harnessPackage: packageEvidence(identity) }),
    );

    expect(result.harnessPackage).toEqual(identity);
    expect(result.harnessPackage?.contentDigest).toHaveLength(64);
    expect(runner.calls).toEqual([
      {
        command: "nemoclaw",
        args: ["harness", "list", "--json"],
        options: {
          artifactName: "harness-list-openclaw",
          env: expect.objectContaining({ PATH: expect.any(String) }),
          timeoutMs: 30_000,
        },
      },
    ]);
  });

  it.each([
    {
      authority: "inventory",
      finalIdentity: packageIdentity("openclaw", "b".repeat(64)),
      io: packageStateIo(packageIdentity()),
    },
    {
      authority: "session",
      finalIdentity: packageIdentity(),
      io: packageStateIo(packageIdentity(), {
        sessionIdentity: packageIdentity("openclaw", "b".repeat(64)),
      }),
    },
    {
      authority: "registry",
      finalIdentity: packageIdentity(),
      io: packageStateIo(packageIdentity(), {
        registryIdentity: packageIdentity("openclaw", "b".repeat(64)),
      }),
    },
  ])("rejects package digest drift in $authority authority", async (scenario) => {
    const identity = packageIdentity();
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, packageInventory(scenario.finalIdentity)));

    await expect(
      fixture(runner, scenario.io).from(
        { id: "synthetic-package-identity-drift" },
        instance({ harnessPackage: packageEvidence(identity) }),
      ),
    ).rejects.toThrow(new RegExp(`Harness package ${scenario.authority} identity`));
  });

  it.each([
    {
      authority: "session",
      io: {
        readOnboardSession: () => null,
        readRegistry: packageStateIo(packageIdentity()).readRegistry,
      },
    },
    {
      authority: "registry",
      io: {
        readOnboardSession: packageStateIo(packageIdentity()).readOnboardSession,
        readRegistry: () => ({ entries: {} }),
      },
    },
  ])("rejects an absent $authority package identity", async (scenario) => {
    const identity = packageIdentity();
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, packageInventory(identity)));

    await expect(
      fixture(runner, scenario.io).from(
        { id: "synthetic-package-identity-absent" },
        instance({ harnessPackage: packageEvidence(identity) }),
      ),
    ).rejects.toThrow(new RegExp(`Harness package ${scenario.authority} identity`));
  });

  it("rejects a durable agent that disagrees with the effective package id", async () => {
    const identity = packageIdentity("hermes", "b".repeat(64));
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, packageInventory(identity)));
    const io = packageStateIo(identity, { sessionAgent: "openclaw" });

    await expect(
      fixture(runner, io).from(
        { id: "synthetic-package-agent-drift" },
        instance({
          agent: "hermes",
          harnessPackage: packageEvidence(identity),
        }),
      ),
    ).rejects.toThrow(/Harness package session agent/);
  });

  it("keeps malformed durable-identity diagnostics free of paths and secrets", async () => {
    const identity = packageIdentity();
    const secret = `nvapi-${"q".repeat(24)}`;
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, packageInventory(identity)));
    const io = packageStateIo(identity, {
      sessionIdentity: {
        ...identity,
        packageRoot: `/private/store/${secret}`,
      },
    });

    let thrown: unknown;
    try {
      await fixture(runner, io).from(
        { id: "synthetic-package-identity-malformed" },
        instance({ harnessPackage: packageEvidence(identity) }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain("Harness package session identity");
    expect(message).not.toContain("/private/store");
    expect(message).not.toContain(secret);
  });

  it("explicitly skips standard package assertions for a candidate instance", async () => {
    const runner = new FakeRunner();
    const result = await fixture(runner, {
      readOnboardSession: () => {
        throw new Error("candidate validation must not read Session package state");
      },
      readRegistry: () => {
        throw new Error("candidate validation must not read registry package state");
      },
    }).from({ id: "synthetic-candidate-ready" }, instance({ harnessPackage: null }));

    expect(result.harnessPackage).toBeUndefined();
    expect(runner.calls).toEqual([]);
  });

  it("exposes the state-validation phase on the E2E target context", () => {
    expectTypeOf<
      E2ETargetFixtures["stateValidation"]
    >().toEqualTypeOf<StateValidationPhaseFixture>();
  });
});

describe("state-validation host-side probes", () => {
  const localRegistryState = {
    id: "synthetic-local-registry-present",
    localRegistry: { expected: "present" as const },
  };
  const dockerContainerState = {
    id: "synthetic-docker-container-present",
    dockerSandboxContainer: { expected: "present" as const },
  };

  it("local-registry-entry-present passes when the registry contains the sandbox name", async () => {
    const runner = new FakeRunner();
    const fx = fixture(runner, {
      readRegistry: () => ({
        entries: {
          "e2e-cloud-oc": {
            name: "e2e-cloud-oc",
          },
        },
      }),
    });

    const result = await fx.from(localRegistryState, instance());

    expect(result.probes.map((probe) => probe.id)).toEqual(["local-registry-entry-present"]);
    expect(runner.calls).toEqual([]);
  });

  it("local-registry-entry-present fails when the registry file is missing", async () => {
    const runner = new FakeRunner();
    const fx = fixture(runner, { readRegistry: () => null });

    await expect(fx.from(localRegistryState, instance())).rejects.toThrow(
      /expected local registry entry for 'e2e-cloud-oc'.*does not exist/,
    );
  });

  it("local-registry-entry-present fails when the sandbox name is missing from registry", async () => {
    const runner = new FakeRunner();
    const fx = fixture(runner, {
      readRegistry: () => ({ entries: { "some-other-sandbox": {} } }),
    });

    await expect(fx.from(localRegistryState, instance())).rejects.toThrow(
      /registry contains: some-other-sandbox/,
    );
  });

  it("docker-sandbox-container-present passes when docker ps -a returns labeled names", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "e2e-cloud-oc\n"));
    const fx = fixture(runner);

    const result = await fx.from(dockerContainerState, instance());

    expect(result.probes.map((probe) => probe.id)).toEqual(["docker-sandbox-container-present"]);
    expect(runner.calls).toEqual([
      {
        command: "docker",
        args: [
          "ps",
          "-a",
          "--filter",
          "label=openshell.ai/sandbox-name=e2e-cloud-oc",
          "--format",
          "{{.Names}}",
        ],
        options: {
          artifactName: "docker-sandbox-container-present-e2e-cloud-oc",
          env: expect.objectContaining({ PATH: expect.any(String) }),
          timeoutMs: 15_000,
        },
      },
    ]);
  });

  it("docker-sandbox-container-present matches *-nemoclaw-gpu-backup-* sibling containers", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "e2e-cloud-oc-nemoclaw-gpu-backup-1717280000000\n"));
    const fx = fixture(runner);

    const result = await fx.from(dockerContainerState, instance());

    expect(result.probes.map((probe) => probe.id)).toEqual(["docker-sandbox-container-present"]);
  });

  it("docker-sandbox-container-present fails when docker ps -a returns no labeled container", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "\n"));
    const fx = fixture(runner);

    await expect(fx.from(dockerContainerState, instance())).rejects.toThrow(
      /docker ps -a returned none/,
    );
  });

  it("docker-sandbox-container-present fails when docker ps -a exits non-zero", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(1, "Cannot connect to the Docker daemon"));
    const fx = fixture(runner);

    await expect(fx.from(dockerContainerState, instance())).rejects.toThrow(
      /could not query Docker for label.*exit 1/,
    );
  });

  it("writes, reads, and asserts sandbox marker files through OpenShell exec", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0));
    runner.enqueue(shellResult(0, "marker-value"));
    const fx = fixture(runner);

    await fx.writeMarkerFile(
      "e2e-marker",
      "/sandbox/.openclaw/workspace/rebuild-marker.txt",
      "marker-value",
    );
    await fx.expectMarkerFileContent(
      "e2e-marker",
      "/sandbox/.openclaw/workspace/rebuild-marker.txt",
      "marker-value",
    );

    expect(runner.calls.map((call) => call.args)).toEqual([
      [
        "sandbox",
        "exec",
        "-n",
        "e2e-marker",
        "--",
        "sh",
        "-c",
        'mkdir -p "$(dirname "$1")" && printf \'%s\' "$2" > "$1"',
        "sh",
        "/sandbox/.openclaw/workspace/rebuild-marker.txt",
        "marker-value",
      ],
      [
        "sandbox",
        "exec",
        "-n",
        "e2e-marker",
        "--",
        "cat",
        "/sandbox/.openclaw/workspace/rebuild-marker.txt",
      ],
    ]);
  });

  it("keeps marker content comparisons exact", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, " marker-value "));
    const fx = fixture(runner);

    await expect(
      fx.expectMarkerFileContent(
        "e2e-marker",
        "/sandbox/.openclaw/workspace/rebuild-marker.txt",
        "marker-value",
      ),
    ).rejects.toThrow(/did not match expected content/);
  });

  it("patches registry entries and validates refreshed agentVersion", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-registry-"));
    const registryPath = path.join(tmp, "sandboxes.json");
    fs.writeFileSync(
      registryPath,
      JSON.stringify({ sandboxes: { "e2e-rebuild": { agentVersion: "0.0.1" } } }),
    );
    try {
      patchRegistrySandboxEntry("e2e-rebuild", { agentVersion: "1.2.3" }, { registryPath });
      expect(readRegistrySandboxEntry("e2e-rebuild", { registryPath }).agentVersion).toBe("1.2.3");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("snapshots and restores registry/session files", () => {
    const oldHome = process.env.HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-home-"));
    process.env.HOME = home;
    try {
      const stateDir = path.join(home, ".nemoclaw");
      fs.mkdirSync(stateDir, { recursive: true });
      const registryPath = path.join(stateDir, "sandboxes.json");
      const sessionPath = path.join(stateDir, "onboard-session.json");
      fs.writeFileSync(registryPath, "registry-before");
      fs.writeFileSync(sessionPath, "session-before");

      const snapshot = snapshotRegistryAndSession();
      fs.writeFileSync(registryPath, "registry-after");
      fs.rmSync(sessionPath);
      restoreRegistryAndSession(snapshot);

      expect(fs.readFileSync(registryPath, "utf8")).toBe("registry-before");
      expect(fs.readFileSync(sessionPath, "utf8")).toBe("session-before");
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("discovers backup manifests and reports credential leak paths", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-backups-"));
    const backupRoot = path.join(home, "rebuild-backups");
    const backupDir = path.join(backupRoot, "e2e-rebuild", "2026-06-12T00-00-00Z");
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(
      path.join(backupDir, "rebuild-manifest.json"),
      JSON.stringify({ stateDirs: [] }),
    );
    fs.writeFileSync(path.join(backupDir, "safe.json"), JSON.stringify({ value: "ok" }));
    fs.writeFileSync(path.join(backupDir, "leak.json"), JSON.stringify({ key: "nvapi-secret" }));
    try {
      const latest = latestRebuildBackupDir("e2e-rebuild", { backupRoot });
      expect(latest).toBe(backupDir);
      expect(readRebuildBackupManifest(latest!)).toEqual({ stateDirs: [] });
      expect(listCredentialLeakPaths(latest)).toEqual([path.join(backupDir, "leak.json")]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
