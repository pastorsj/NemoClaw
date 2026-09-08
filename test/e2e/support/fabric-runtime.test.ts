// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import {
  buildFabricOnboardingEnvironment,
  fabricPackageRunArtifactDirectory,
  requireTestedNemoClawCli,
} from "../../../tools/e2e/fabric-journey.mts";
import { LiveCommandRunner } from "../../../tools/e2e/live-client.mts";
import { createPrivateFabricRuntime } from "../../../tools/e2e/private-runtime.mts";

const temporaryDirectories: string[] = [];

function runGit(repositoryRoot: string, arguments_: readonly string[]): string {
  return execFileSync("git", arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function testedCheckout(buildRevision?: string): {
  readonly cliPath: string;
  readonly repositoryRoot: string;
  readonly revision: string;
} {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fabric-checkout-"));
  temporaryDirectories.push(repositoryRoot);
  const cliPath = path.join(repositoryRoot, "bin", "nemoclaw.js");
  fs.mkdirSync(path.dirname(cliPath), { recursive: true });
  fs.writeFileSync(cliPath, "#!/usr/bin/env node\n", { mode: 0o755 });
  runGit(repositoryRoot, ["init", "--quiet"]);
  runGit(repositoryRoot, ["add", "bin/nemoclaw.js"]);
  runGit(repositoryRoot, [
    "-c",
    "user.name=NemoClaw E2E",
    "-c",
    "user.email=nemoclaw-e2e@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "test: create exact checkout",
  ]);
  const revision = runGit(repositoryRoot, ["rev-parse", "HEAD"]);
  fs.mkdirSync(path.join(repositoryRoot, "dist"));
  fs.writeFileSync(
    path.join(repositoryRoot, "dist", "build-identity.json"),
    `${JSON.stringify({ nemoclawVersion: "0.0.0-test", sourceRevision: buildRevision ?? revision })}\n`,
    "utf8",
  );
  return { cliPath, repositoryRoot, revision };
}

function artifactSink(): { readonly directory: string; readonly sink: ArtifactSink } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-live-command-"));
  temporaryDirectories.push(directory);
  return { directory, sink: new ArtifactSink(directory) };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("standalone Fabric runtime support", () => {
  it("gives every invocation its own package-scoped evidence leaf", () => {
    const target = {
      contract: {
        packageId: "future-harness",
        adapterId: "example.future",
        artifactRoot: "/sandbox/fabric",
        configPath: "/sandbox/fabric.json",
        descriptorGlob: "/opt/future.fabric-adapter.json",
        descriptorPathPrefix: "/opt",
        descriptorRunnerModule: "future.adapter",
      },
      journey: "smoke" as const,
      packageArtifact: "/tmp/future-package",
      sandboxName: "e2e-future",
    };
    const first = fabricPackageRunArtifactDirectory(
      "/tmp/evidence",
      target,
      "123e4567-e89b-42d3-a456-426614174000",
    );
    const second = fabricPackageRunArtifactDirectory(
      "/tmp/evidence",
      target,
      "123e4567-e89b-42d3-a456-426614174001",
    );

    expect(first).not.toBe(second);
    expect(first).toContain("future-harness/smoke/e2e-future/");
  });

  it("binds CLI execution to the regular file in the tested checkout", () => {
    const checkout = testedCheckout();
    const identity = requireTestedNemoClawCli(checkout.repositoryRoot, {});

    expect(path.isAbsolute(identity.path)).toBe(true);
    expect(identity.path).toBe(fs.realpathSync(checkout.cliPath));
    expect(identity.contentSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(() =>
      requireTestedNemoClawCli(checkout.repositoryRoot, { NEMOCLAW_CLI_BIN: process.execPath }),
    ).toThrow("must resolve to the tested checkout's NemoClaw CLI");
  });

  it("rejects a generated CLI from another Git revision", () => {
    const checkout = testedCheckout("a".repeat(40));

    expect(() => requireTestedNemoClawCli(checkout.repositoryRoot, {})).toThrow(
      "generated CLI does not match the tested Git revision",
    );
  });

  it("rejects tracked checkout changes before live execution", () => {
    const checkout = testedCheckout();
    fs.appendFileSync(checkout.cliPath, "process.exitCode = 1;\n", "utf8");

    expect(() => requireTestedNemoClawCli(checkout.repositoryRoot, {})).toThrow(
      "requires a checkout without tracked changes",
    );
  });

  it("adds credentials to onboarding without mutating the secret-free control environment", () => {
    const control = { HOME: "/private/test-home", OPENSHELL_GATEWAY: "nemoclaw-28133" };
    const onboarding = buildFabricOnboardingEnvironment(control, {
      NVIDIA_INFERENCE_API_KEY: "fixture-secret",
      NEMOCLAW_ENDPOINT_URL: "https://example.test/v1",
    });

    expect(control).not.toHaveProperty("NVIDIA_INFERENCE_API_KEY");
    expect(onboarding).toMatchObject({
      ...control,
      NVIDIA_INFERENCE_API_KEY: "fixture-secret",
      NEMOCLAW_ENDPOINT_URL: "https://example.test/v1",
    });
  });

  it("bounds both command streams and records explicit truncation and exit evidence", async () => {
    const secret = "fixture-super-secret";
    const { sink } = artifactSink();
    const runner = new LiveCommandRunner(sink, [secret]);

    const result = await runner.run(
      process.execPath,
      [
        "-e",
        `process.stdout.write("x".repeat(128) + ${JSON.stringify(secret)}); process.stderr.write("y".repeat(128)); process.exit(7)`,
      ],
      { artifactName: "bounded-output", captureLimitBytes: 12 },
    );

    expect(result.exitCode).toBe(7);
    expect(result.failure).toEqual({ kind: "exit", message: "command exited 7" });
    expect(result.output.stdout).toMatchObject({
      limitBytes: 12,
      observedBytes: 128 + Buffer.byteLength(secret),
      truncated: true,
    });
    expect(result.output.stderr).toMatchObject({
      limitBytes: 12,
      observedBytes: 128,
      truncated: true,
    });
    expect(result.stdout).toContain("[REDACTED]");
    expect(result.stdout).not.toContain(secret.slice(-12));
    expect(fs.readFileSync(result.artifacts.stdout, "utf8")).toBe(result.stdout);
    expect(JSON.parse(fs.readFileSync(result.artifacts.result, "utf8"))).toMatchObject({
      failure: { kind: "exit" },
      output: { stderr: { truncated: true }, stdout: { truncated: true } },
    });
  });

  it("persists a bounded spawn failure instead of losing command evidence", async () => {
    const { sink } = artifactSink();
    const runner = new LiveCommandRunner(sink, []);

    const result = await runner.run("/definitely/not/a/nemoclaw-command", [], {
      artifactName: "spawn-failure",
      captureLimitBytes: 256,
    });

    expect(result.exitCode).toBeNull();
    expect(result.failure).toMatchObject({ kind: "spawn" });
    expect(fs.existsSync(result.artifacts.result)).toBe(true);
  });

  it("cancels only an active owned process so cleanup commands can still run", async () => {
    const { sink } = artifactSink();
    const runner = new LiveCommandRunner(sink, []);
    const pending = runner.run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      artifactName: "interrupted-command",
      timeoutMs: 5_000,
    });

    setTimeout(() => runner.cancelActive(), 50).unref();
    const interrupted = await pending;
    const cleanup = await runner.run(process.execPath, ["-e", "process.exit(0)"], {
      artifactName: "cleanup-after-interrupt",
    });

    expect(interrupted.failure).toMatchObject({ kind: "signal" });
    expect(cleanup.failure).toBeNull();
    expect(cleanup.exitCode).toBe(0);
  });

  it("preserves caller-supplied managed-image qualification for a generic package journey", () => {
    const runtime = createPrivateFabricRuntime(".nemoclaw-fabric-authority-home-", {
      DOCKER_HOST: "unix:///tmp/nemoclaw-fixture-docker.sock",
      NEMOCLAW_CANDIDATE_AGENTS: "1",
      NEMOCLAW_CANDIDATE_QUALIFICATION_RECEIPT: "/tmp/pi-qualification.json",
      NEMOCLAW_GATEWAY_PORT: "28133",
      OPENSHELL_BIN: process.execPath,
      OPENSHELL_GATEWAY: "nemoclaw-28133",
      PATH: path.dirname(process.execPath),
    });

    try {
      expect(runtime.environment()).toMatchObject({
        NEMOCLAW_CANDIDATE_AGENTS: "1",
        NEMOCLAW_CANDIDATE_QUALIFICATION_RECEIPT: "/tmp/pi-qualification.json",
      });
    } finally {
      runtime.removeHome();
    }
  });

  it("retains Docker CLI plugin discovery without copying host credentials", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fabric-docker-"));
    const hostDockerConfig = path.join(fixtureRoot, "host-docker");
    const pluginDirectory = path.join(fixtureRoot, "plugins");
    fs.mkdirSync(hostDockerConfig, { recursive: true });
    fs.mkdirSync(pluginDirectory);
    fs.writeFileSync(
      path.join(hostDockerConfig, "config.json"),
      JSON.stringify({
        auths: { "registry.example.test": { auth: "must-not-pass" } },
        cliPluginsExtraDirs: [pluginDirectory],
        credsStore: "must-not-pass",
      }),
    );
    const runtime = createPrivateFabricRuntime(".nemoclaw-fabric-docker-home-", {
      DOCKER_CONFIG: hostDockerConfig,
      DOCKER_HOST: "unix:///tmp/nemoclaw-fixture-docker.sock",
      HOME: fixtureRoot,
      NEMOCLAW_GATEWAY_PORT: "28133",
      OPENSHELL_BIN: process.execPath,
      OPENSHELL_GATEWAY: "nemoclaw-28133",
      PATH: path.dirname(process.execPath),
    });

    try {
      const privateDockerConfig = JSON.parse(
        fs.readFileSync(path.join(runtime.home, ".docker", "config.json"), "utf8"),
      );
      expect(privateDockerConfig).toEqual({
        cliPluginsExtraDirs: [fs.realpathSync(pluginDirectory)],
      });
    } finally {
      runtime.removeHome();
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("removes a private HOME when staging fails after directory creation", () => {
    const unique = `${process.pid.toString(36)}-${Date.now().toString(36)}`;
    const prefix = `.nemoclaw-${unique}-home-`;
    const parent = fs.realpathSync(os.homedir());
    const before = new Set(fs.readdirSync(parent).filter((name) => name.startsWith(prefix)));
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw new Error("fixture staging failure");
    });

    expect(() =>
      createPrivateFabricRuntime(prefix, {
        DOCKER_HOST: "unix:///tmp/nemoclaw-fixture-docker.sock",
        NEMOCLAW_GATEWAY_PORT: "28133",
        OPENSHELL_BIN: process.execPath,
        OPENSHELL_GATEWAY: "nemoclaw-28133",
        PATH: path.dirname(process.execPath),
      }),
    ).toThrow("fixture staging failure");

    const after = fs.readdirSync(parent).filter((name) => name.startsWith(prefix));
    expect(after.filter((name) => !before.has(name))).toEqual([]);
  });
});
