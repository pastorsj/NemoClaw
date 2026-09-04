// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { type CommandRunner, HostCliClient } from "../fixtures/clients/index.ts";
import {
  type HarnessPackageIdentity,
  installHarnessPackage,
  readInstalledHarnessPackage,
} from "../fixtures/harness-package.ts";
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

const DIGESTS: Record<string, string> = {
  openclaw: "a".repeat(64),
  hermes: "b".repeat(64),
  "langchain-deepagents-code": "c".repeat(64),
  pi: "d".repeat(64),
  "future-harness": "e".repeat(64),
};

function packageIdentity(
  id: string,
  overrides: Partial<HarnessPackageIdentity> = {},
): HarnessPackageIdentity {
  return {
    kind: "agent-runtime",
    id,
    packageVersion: "1.2.3",
    contentDigest: DIGESTS[id] ?? "f".repeat(64),
    ...overrides,
  };
}

function inventoryJson(
  selectedId: string,
  identities: HarnessPackageIdentity[] = [packageIdentity(selectedId)],
): string {
  return JSON.stringify({
    schemaVersion: 1,
    installed: identities.map((identity) => ({
      id: identity.id,
      displayName: `Display ${identity.id}`,
      health: "healthy",
      identity,
    })),
    available: identities.map((identity) => ({
      displayName: `Display ${identity.id}`,
      identity,
      installationState: "active",
    })),
  });
}

function shellResult(exitCode: number, stdout = "", stderr = ""): ShellProbeResult {
  return {
    command: [],
    exitCode,
    signal: null,
    timedOut: false,
    stdout,
    stderr,
    artifacts: {
      stdout: "/tmp/stdout.txt",
      stderr: "/tmp/stderr.txt",
      result: "/tmp/result.json",
    },
  };
}

class FakeRunner implements CommandRunner {
  readonly calls: RunnerCall[] = [];

  constructor(private readonly responses: ShellProbeResult[]) {}

  async run(
    command: TrustedShellCommand,
    options?: ShellProbeRunOptions,
  ): Promise<ShellProbeResult> {
    this.calls.push({ command: command.command, args: [...command.args], options });
    const response = this.responses.shift();
    return (
      response ??
      (() => {
        throw new Error("FakeRunner has no response for the public CLI command");
      })()
    );
  }
}

function createHost(...responses: ShellProbeResult[]): {
  host: HostCliClient;
  runner: FakeRunner;
} {
  const runner = new FakeRunner(responses);
  return { host: new HostCliClient(runner), runner };
}

describe("harness package E2E evidence", () => {
  it("installs before listing and returns the full selected package identity", async () => {
    const secret = `nvapi-${"s".repeat(24)}`;
    const previousSecret = process.env.NVIDIA_INFERENCE_API_KEY;
    process.env.NVIDIA_INFERENCE_API_KEY = secret;
    const identity = packageIdentity("pi");
    const { host, runner } = createHost(
      shellResult(0, "Installed harness package 'pi'.\n"),
      shellResult(0, inventoryJson("pi")),
    );
    try {
      const evidence = await installHarnessPackage(host, "pi");

      expect(evidence.identity).toEqual(identity);
      expect(evidence.identity.contentDigest).toHaveLength(64);
      expect(evidence.installResult.stdout).toContain("Installed harness package");
      expect(evidence.inventoryResult.stdout).toContain('"schemaVersion":1');
      expect(runner.calls.map(({ args }) => args)).toEqual([
        ["harness", "install", "pi"],
        ["harness", "list", "--json"],
      ]);
      expect(
        runner.calls.map(({ options }) => ({
          pathType: typeof options?.env?.PATH,
          inheritedSecret: options?.env?.NVIDIA_INFERENCE_API_KEY,
        })),
      ).toEqual([
        { pathType: "string", inheritedSecret: undefined },
        { pathType: "string", inheritedSecret: undefined },
      ]);
    } finally {
      previousSecret === undefined
        ? Reflect.deleteProperty(process.env, "NVIDIA_INFERENCE_API_KEY")
        : Reflect.set(process.env, "NVIDIA_INFERENCE_API_KEY", previousSecret);
    }
  });

  it("selects the exact requested id when more than one package is installed", async () => {
    const openclaw = packageIdentity("openclaw");
    const hermes = packageIdentity("hermes");
    const { host } = createHost(shellResult(0, inventoryJson("hermes", [openclaw, hermes])));

    const evidence = await readInstalledHarnessPackage(host, "hermes");

    expect(evidence.identity).toEqual(hermes);
  });

  it("forwards qualified candidate selection through installation and inventory", async () => {
    const qualification = {
      PATH: "/usr/bin:/bin",
      NEMOCLAW_CANDIDATE_AGENTS: "1",
      NEMOCLAW_CANDIDATE_QUALIFICATION_RECEIPT: "/tmp/pi-qualification.json",
      NVIDIA_INFERENCE_API_KEY: `nvapi-${"q".repeat(24)}`,
    };
    const { host, runner } = createHost(
      shellResult(0, "Installed.\n"),
      shellResult(0, inventoryJson("pi")),
    );

    await installHarnessPackage(host, "pi", qualification);

    expect(
      runner.calls.map(({ options }) => ({
        candidateAgents: options?.env?.NEMOCLAW_CANDIDATE_AGENTS,
        receipt: options?.env?.NEMOCLAW_CANDIDATE_QUALIFICATION_RECEIPT,
        secret: options?.env?.NVIDIA_INFERENCE_API_KEY,
      })),
    ).toEqual([
      { candidateAgents: "1", receipt: "/tmp/pi-qualification.json", secret: undefined },
      { candidateAgents: "1", receipt: "/tmp/pi-qualification.json", secret: undefined },
    ]);
  });

  it("keeps repeated public installation idempotent and identity-stable", async () => {
    const inventory = inventoryJson("langchain-deepagents-code");
    const { host, runner } = createHost(
      shellResult(0, "Installed.\n"),
      shellResult(0, inventory),
      shellResult(0, "Already installed.\n"),
      shellResult(0, inventory),
    );

    const first = await installHarnessPackage(host, "langchain-deepagents-code");
    const second = await installHarnessPackage(host, "langchain-deepagents-code");

    expect(second.identity).toEqual(first.identity);
    expect(runner.calls.map(({ args }) => args)).toEqual([
      ["harness", "install", "langchain-deepagents-code"],
      ["harness", "list", "--json"],
      ["harness", "install", "langchain-deepagents-code"],
      ["harness", "list", "--json"],
    ]);
  });

  it("installs a future canonical package without adding it to a fixture registry", async () => {
    const identity = packageIdentity("future-harness");
    const { host, runner } = createHost(
      shellResult(0, "Installed.\n"),
      shellResult(0, inventoryJson("future-harness")),
    );

    const evidence = await installHarnessPackage(host, "future-harness");

    expect(evidence.identity).toEqual(identity);
    expect(runner.calls.map(({ args }) => args)).toEqual([
      ["harness", "install", "future-harness"],
      ["harness", "list", "--json"],
    ]);
  });

  it("stops before inventory when public installation fails", async () => {
    const secret = "installation-secret-value";
    const { host, runner } = createHost(shellResult(1, "", `failed at /private/store/${secret}`));

    let thrown: unknown;
    try {
      await installHarnessPackage(host, "openclaw");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain("public NemoClaw CLI");
    expect(message).not.toContain("/private/store");
    expect(message).not.toContain(secret);
    expect(runner.calls.map(({ args }) => args)).toEqual([["harness", "install", "openclaw"]]);
  });

  it.each([
    ["human output", "Installed: openclaw"],
    [
      "an extra top-level field",
      JSON.stringify({
        ...JSON.parse(inventoryJson("openclaw")),
        packageRoot: "/private/package/root",
      }),
    ],
    [
      "an extra installed-row field",
      JSON.stringify({
        ...JSON.parse(inventoryJson("openclaw")),
        installed: [
          {
            ...JSON.parse(inventoryJson("openclaw")).installed[0],
            receiptPath: "/private/receipt.json",
          },
        ],
      }),
    ],
    [
      "an extra available-row field",
      JSON.stringify({
        ...JSON.parse(inventoryJson("openclaw")),
        available: [
          {
            ...JSON.parse(inventoryJson("openclaw")).available[0],
            packagePath: "/private/package",
          },
        ],
      }),
    ],
    [
      "a partial identity",
      JSON.stringify({
        ...JSON.parse(inventoryJson("openclaw")),
        installed: [
          {
            ...JSON.parse(inventoryJson("openclaw")).installed[0],
            identity: { kind: "agent-runtime", id: "openclaw" },
          },
        ],
      }),
    ],
    [
      "a damaged selected row",
      JSON.stringify({
        ...JSON.parse(inventoryJson("openclaw")),
        installed: [
          {
            id: "openclaw",
            displayName: "OpenClaw",
            health: "damaged",
            identity: null,
          },
        ],
        available: [
          {
            displayName: "OpenClaw",
            identity: packageIdentity("openclaw"),
            installationState: "damaged",
          },
        ],
      }),
    ],
    [
      "duplicate installed rows",
      JSON.stringify({
        ...JSON.parse(inventoryJson("openclaw")),
        installed: [
          JSON.parse(inventoryJson("openclaw")).installed[0],
          JSON.parse(inventoryJson("openclaw")).installed[0],
        ],
      }),
    ],
    ["an alias id", inventoryJson("openclaw").replaceAll("openclaw", "dcode")],
    ["a path id", inventoryJson("openclaw").replaceAll("openclaw", "../openclaw")],
    [
      "a control-bearing display name",
      inventoryJson("openclaw").replaceAll("Display openclaw", "OpenClaw\\nRuntime"),
    ],
    ["a noncanonical digest", inventoryJson("openclaw").replaceAll("a".repeat(64), "A".repeat(64))],
  ])("rejects machine inventory containing %s", async (_label, source) => {
    const { host } = createHost(shellResult(0, source));

    await expect(readInstalledHarnessPackage(host, "openclaw")).rejects.toThrow();
  });

  it("rejects a noncanonical selection before running the CLI", async () => {
    const { host, runner } = createHost();

    await expect(installHarnessPackage(host, "../future-harness")).rejects.toThrow(
      /canonical identifier/,
    );
    expect(runner.calls).toEqual([]);
  });

  it("keeps malformed-inventory diagnostics free of paths and secret values", async () => {
    const secret = `nvapi-${"z".repeat(24)}`;
    const source = JSON.stringify({
      ...JSON.parse(inventoryJson("openclaw")),
      packageRoot: `/private/store/${secret}`,
    });
    const { host } = createHost(shellResult(0, source));

    let thrown: unknown;
    try {
      await readInstalledHarnessPackage(host, "openclaw");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).not.toContain("/private/store");
    expect(message).not.toContain(secret);
  });
});
