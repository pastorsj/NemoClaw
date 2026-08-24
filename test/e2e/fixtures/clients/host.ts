// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import path from "node:path";

import { DEFAULT_GATEWAY_PORT, parsePort } from "../../../../src/lib/core/ports.ts";
import { nemoclawStateRoot } from "../../../../src/lib/state/state-root.ts";
import { buildAvailabilityProbeEnv } from "../availability-env.ts";
import type { ShellProbeResult, ShellProbeRunOptions } from "../shell-probe.ts";
import { trustedShellCommand } from "../shell-probe.ts";
import {
  artifactLabel,
  assertExitZero,
  type CommandRunner,
  outputContainsSandbox,
  resultText,
} from "./command.ts";

export interface HostClientOptions {
  cliPath?: string;
  cwd?: string;
  openshellPath?: string;
}

const GATEWAY_ALREADY_ABSENT =
  /gateway[^\n]*(?:does not exist|not found)|No (?:active )?gateway|No gateway metadata found/i;
const GATEWAY_REMOVE_UNSUPPORTED =
  /unrecognized subcommand ['"]remove['"]|unknown command ['"]remove['"]/i;
const FORWARD_ALREADY_ABSENT =
  /no (?:active )?forward|forward[^\n]*(?:not found|not running)|forward stop[^\n]*not running/i;
const HARNESS_AUTHORITY_PROBE = String.raw`
const fs = require("node:fs");
const harnessId = process.argv[1];
const sessionPath = process.argv[2];
const receiptPath = process.argv[3];
if (!/^[a-z][a-z0-9-]{0,62}$/.test(harnessId)) throw new Error("invalid harness id");
const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
process.stdout.write(JSON.stringify({
  agent: typeof session.agent === "string" ? session.agent : "openclaw",
  source: session.harnessPackage && session.harnessPackage.source,
  contentDigest: session.harnessPackage && session.harnessPackage.contentDigest,
  installedDigest: receipt.installedDigest,
}));
`.trim();

interface HarnessAuthorityProof {
  agent: string;
  source: "installed";
  contentDigest: string;
  installedDigest: string;
}

function parseHarnessAuthorityProof(result: ShellProbeResult): HarnessAuthorityProof {
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error(`installed harness authority proof is not valid JSON: ${resultText(result)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`installed harness authority proof is invalid: ${resultText(result)}`);
  }
  const proof = value as Record<string, unknown>;
  if (
    typeof proof.agent !== "string" ||
    proof.source !== "installed" ||
    typeof proof.contentDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(proof.contentDigest) ||
    typeof proof.installedDigest !== "string" ||
    proof.installedDigest !== proof.contentDigest
  ) {
    throw new Error(`installed harness authority proof is invalid: ${resultText(result)}`);
  }
  return proof as unknown as HarnessAuthorityProof;
}

export class HostCliClient {
  private readonly runner: CommandRunner;
  private readonly cliPath: string;
  private readonly cwd?: string;
  private readonly openshellPath: string;

  constructor(runner: CommandRunner, options: HostClientOptions = {}) {
    this.runner = runner;
    this.cliPath = options.cliPath ?? process.env.NEMOCLAW_CLI_BIN ?? "nemoclaw";
    this.cwd = options.cwd;
    this.openshellPath = options.openshellPath ?? process.env.OPENSHELL_BIN ?? "openshell";
  }

  get commandPath(): string {
    return this.cliPath;
  }

  get openshellCommandPath(): string {
    return this.openshellPath;
  }

  command(
    command: string,
    args: string[] = [],
    options: ShellProbeRunOptions = {},
  ): Promise<ShellProbeResult> {
    const merged: ShellProbeRunOptions = { ...options };
    if (this.cwd && !merged.cwd) {
      merged.cwd = this.cwd;
    }
    return this.runner.run(
      trustedShellCommand({
        command,
        args,
        reason: `run host command ${command}`,
      }),
      merged,
    );
  }

  async isCommandAvailable(command: string, options: ShellProbeRunOptions = {}): Promise<boolean> {
    const result = await this.command(
      "bash",
      ["-lc", 'command -v "$1" >/dev/null 2>&1', "command-availability-probe", command],
      {
        artifactName: `command-available-${artifactLabel(command)}`,
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
        ...options,
      },
    );
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    assertExitZero(result, `probe command availability for ${command}`);
    return false;
  }

  nemoclaw(args: string[] = [], options: ShellProbeRunOptions = {}): Promise<ShellProbeResult> {
    return this.command(this.cliPath, args, {
      artifactName: `nemoclaw-${artifactLabel(args.join("-") || "default")}`,
      ...options,
    });
  }

  async expectNemoclawAvailable(): Promise<ShellProbeResult> {
    const result = await this.nemoclaw(["--version"], {
      artifactName: "nemoclaw-version",
      env: buildAvailabilityProbeEnv(),
    });
    assertExitZero(result, "nemoclaw --version");
    return result;
  }

  async expectHarnessInstalled(
    harnessId: string,
    options: ShellProbeRunOptions = {},
  ): Promise<{
    list: ShellProbeResult;
    agents: ShellProbeResult;
    authority: ShellProbeResult;
  }> {
    const artifactPrefix =
      options.artifactName ?? `harness-${artifactLabel(harnessId)}`;
    const sharedOptions = {
      env: buildAvailabilityProbeEnv(),
      ...options,
    };
    const list = await this.nemoclaw(["harness", "list"], {
      ...sharedOptions,
      artifactName: `${artifactPrefix}-list`,
    });
    assertExitZero(list, "nemoclaw harness list");
    const listed = resultText(list)
      .split(/\r?\n/u)
      .map((line) => line.trim().split(/\s+/u))
      .some(
        (columns) =>
          columns.length >= 3 &&
          columns[0] === harnessId &&
          columns.at(-1) === "installed",
      );
    if (!listed) {
      throw new Error(
        `nemoclaw harness list did not report '${harnessId}' as installed: ${resultText(list)}`,
      );
    }

    const agents = await this.nemoclaw(["agents", "list"], {
      ...sharedOptions,
      artifactName: `${artifactPrefix}-agents`,
    });
    assertExitZero(agents, "nemoclaw agents list");
    const selectable = resultText(agents)
      .split(/\r?\n/u)
      .some((line) => line.trim().split(/\s+/u)[0] === harnessId);
    if (!selectable) {
      throw new Error(
        `nemoclaw agents list did not include '${harnessId}': ${resultText(agents)}`,
      );
    }

    const authorityEnv = sharedOptions.env ?? {};
    const authorityHome = authorityEnv.HOME || process.env.HOME || os.homedir();
    const gatewayPort = parsePort("NEMOCLAW_GATEWAY_PORT", DEFAULT_GATEWAY_PORT, authorityEnv);
    const sessionPath = path.join(
      nemoclawStateRoot(authorityHome, gatewayPort),
      "onboard-session.json",
    );
    const receiptPath = path.join(
      authorityHome,
      ".nemoclaw",
      "harnesses",
      `nemoclaw-${harnessId}`,
      ".nemoclaw-install.json",
    );
    const authority = await this.command(
      process.execPath,
      ["-e", HARNESS_AUTHORITY_PROBE, harnessId, sessionPath, receiptPath],
      {
        ...sharedOptions,
        artifactName: `${artifactPrefix}-authority`,
      },
    );
    assertExitZero(authority, `verify installed harness authority for ${harnessId}`);
    const proof = parseHarnessAuthorityProof(authority);
    if (proof.agent !== harnessId) {
      throw new Error(
        `onboarding selected '${proof.agent}' while '${harnessId}' authority was expected`,
      );
    }

    return { list, agents, authority };
  }

  async expectListed(
    sandboxName: string,
    options: ShellProbeRunOptions = {},
  ): Promise<ShellProbeResult> {
    const result = await this.nemoclaw(["list"], {
      artifactName: `nemoclaw-list-${artifactLabel(sandboxName)}`,
      env: buildAvailabilityProbeEnv(),
      ...options,
    });
    assertExitZero(result, "nemoclaw list");
    if (!outputContainsSandbox(result, sandboxName)) {
      throw new Error(`nemoclaw list did not include '${sandboxName}': ${resultText(result)}`);
    }
    return result;
  }

  async expectStatus(
    sandboxName: string,
    options: ShellProbeRunOptions = {},
  ): Promise<ShellProbeResult> {
    const result = await this.nemoclaw([sandboxName, "status"], {
      artifactName: `nemoclaw-status-${artifactLabel(sandboxName)}`,
      env: buildAvailabilityProbeEnv(),
      ...options,
    });
    assertExitZero(result, `nemoclaw ${sandboxName} status`);
    return result;
  }

  async destroySandbox(
    sandboxName: string,
    options: ShellProbeRunOptions = {},
  ): Promise<ShellProbeResult> {
    return await this.nemoclaw([sandboxName, "destroy", "--yes"], {
      artifactName: `destroy-sandbox-${artifactLabel(sandboxName)}`,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 15 * 60_000,
      ...options,
    });
  }

  async cleanupSandbox(sandboxName: string, options: ShellProbeRunOptions = {}): Promise<void> {
    const result = await this.destroySandbox(sandboxName, options);
    if (result.exitCode === 0) return;
    const text = resultText(result);
    if (
      /Sandbox '.+' does not exist|Run 'nemoclaw onboard' to create one|sandbox .* not found|no such sandbox/i.test(
        text,
      )
    ) {
      return;
    }
    assertExitZero(result, `cleanup destroy sandbox ${sandboxName}`);
  }

  async cleanupGatewayRegistration(
    gatewayName: string,
    options: ShellProbeRunOptions = {},
  ): Promise<void> {
    const artifactName = options.artifactName ?? `cleanup-gateway-${artifactLabel(gatewayName)}`;
    const remove = await this.command(this.openshellPath, ["gateway", "remove", gatewayName], {
      ...options,
      artifactName: `${artifactName}-remove`,
    });
    if (remove.exitCode === 0 || GATEWAY_ALREADY_ABSENT.test(resultText(remove))) return;
    if (!GATEWAY_REMOVE_UNSUPPORTED.test(resultText(remove))) {
      assertExitZero(remove, `cleanup gateway registration ${gatewayName}`);
    }

    // Remove this fallback once the supported OpenShell floor no longer
    // includes builds whose local-registration verb was `gateway destroy`.
    const destroy = await this.command(
      this.openshellPath,
      ["gateway", "destroy", "-g", gatewayName],
      {
        ...options,
        artifactName: `${artifactName}-legacy-destroy`,
      },
    );
    if (destroy.exitCode === 0 || GATEWAY_ALREADY_ABSENT.test(resultText(destroy))) return;
    assertExitZero(destroy, `cleanup gateway registration ${gatewayName}`);
  }

  async cleanupForward(port: number, options: ShellProbeRunOptions = {}): Promise<void> {
    const result = await this.command(this.openshellPath, ["forward", "stop", String(port)], {
      ...options,
      artifactName: options.artifactName ?? `cleanup-forward-${port}`,
    });
    if (result.exitCode === 0 || FORWARD_ALREADY_ABSENT.test(resultText(result))) return;
    assertExitZero(result, `cleanup forward ${port}`);
  }

  async bestEffortCleanupSandbox(
    sandboxName: string,
    options: ShellProbeRunOptions = {},
  ): Promise<void> {
    try {
      await this.cleanupSandbox(sandboxName, options);
    } catch {
      // Best-effort cleanup must not mask the primary setup or assertion failure.
    }
  }
}
