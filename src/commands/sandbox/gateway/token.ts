// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";
import type { AgentDefinition } from "../../../lib/agent/defs";
import { quietFlag } from "../../../lib/cli/common-flags";
import {
  assertHermesPortableCommandUnavailable,
  NemoClawCommand,
  withSandboxCommandLifecycleLock,
} from "../../../lib/cli/nemoclaw-oclif-command";

import {
  GatewayTokenCommandError,
  type GatewayTokenResolution,
  runGatewayTokenCommand,
} from "../../../lib/gateway-token-command";

type GatewayTokenRuntimeBridge = {
  /** Agent-appropriate token fetcher, resolved per sandbox. */
  fetchToken?: (sandboxName: string) => string | null;
  getSandboxAgent?: (sandboxName: string) => string | null;
  /** Whether the resolved agent exposes a retrievable auth token. */
  agentExposesToken?: (agentName: string | null) => boolean;
  resolveToken?: (sandboxName: string) => GatewayTokenResolution;
};

let runtimeBridgeFactory = (): GatewayTokenRuntimeBridge => {
  const commandAgent =
    require("../../../lib/sandbox/command-agent") as typeof import("../../../lib/sandbox/command-agent");
  const agentWebAuth =
    require("../../../lib/onboard/agent-web-auth-token") as typeof import("../../../lib/onboard/agent-web-auth-token");
  const sandboxConfig = require("../../../lib/sandbox/config") as Pick<
    typeof import("../../../lib/sandbox/config"),
    "readSandboxConfig"
  >;
  const openshellResolver =
    require("../../../lib/adapters/openshell/resolve") as typeof import("../../../lib/adapters/openshell/resolve");
  const runner = require("../../../lib/runner") as Pick<
    typeof import("../../../lib/runner"),
    "runCapture"
  >;
  const registry = require("../../../lib/state/registry") as {
    getSandbox: (name: string) => import("../../../lib/state/registry").SandboxEntry | null;
  };

  const runCaptureOpenshell = (args: string[], opts?: Record<string, unknown>): string | null => {
    const openshell = openshellResolver.resolveOpenshell();
    if (!openshell) return null;
    return runner.runCapture([openshell, ...args], opts);
  };

  const resolveAgent = (sandboxName: string): AgentDefinition | null => {
    const entry = registry.getSandbox(sandboxName);
    if (!entry) return null;
    return commandAgent.resolveSandboxCommandAgent(entry);
  };

  return {
    resolveToken: (sandboxName: string): GatewayTokenResolution => {
      const agent = resolveAgent(sandboxName);
      if (!agent) return { kind: "available", token: null };
      if (agent.webAuth.method === "bearer_token") {
        return {
          kind: "available",
          token: agentWebAuth.fetchAgentWebAuthTokenFromSandbox(
            runCaptureOpenshell,
            sandboxName,
            agent,
          ),
        };
      }
      if (agent.dashboard.auth === "url_token") {
        return {
          kind: "available",
          token: agentWebAuth.fetchAgentDashboardTokenFromSandbox(
            sandboxConfig.readSandboxConfig,
            sandboxName,
            agent,
          ),
        };
      }
      return {
        kind: "unavailable",
        displayName: agent.displayName,
        dashboard: agent.dashboard,
      };
    },
  };
};

export function setGatewayTokenRuntimeBridgeFactoryForTest(
  factory: () => GatewayTokenRuntimeBridge,
): void {
  runtimeBridgeFactory = factory;
}

function getRuntimeBridge(): GatewayTokenRuntimeBridge {
  return runtimeBridgeFactory();
}

export default class GatewayTokenCliCommand extends NemoClawCommand {
  static id = "sandbox:gateway:token";
  static strict = true;
  static summary = "Print the sandbox agent's auth token to stdout";
  static description =
    "Print the retrievable auth token declared by the running sandbox's installed harness package.";
  static usage = ["<name> [--quiet|-q]"];
  static examples = [
    "<%= config.bin %> sandbox gateway token alpha",
    "<%= config.bin %> sandbox gateway token alpha --quiet",
  ];
  static args = {
    sandboxName: Args.string({
      name: "sandbox",
      description: "Sandbox name",
      required: true,
    }),
  };
  static flags = {
    quiet: quietFlag("Suppress the stderr security warning"),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(GatewayTokenCliCommand);
    // Suppress EPIPE traces when the consumer closes the pipe early
    // (e.g. `... | head -c 0`). The token has already been written.
    process.stdout.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") {
        this.setExitCode(0);
        return;
      }
      throw err;
    });

    try {
      await withSandboxCommandLifecycleLock(args.sandboxName, () => {
        // Experimental portable lifecycle authority is separate from an agent-package receipt.
        assertHermesPortableCommandUnavailable(args.sandboxName, "sandbox:gateway:token");
        const runtime = getRuntimeBridge();
        runGatewayTokenCommand(
          args.sandboxName,
          { quiet: flags.quiet === true },
          {
            fetchToken: runtime.fetchToken,
            resolveToken: runtime.resolveToken,
            getSandboxAgent: runtime.getSandboxAgent,
            agentExposesToken: runtime.agentExposesToken,
          },
        );
      });
      // CodeRabbit #3182: if a prior run() left process.exitCode = 1, a later
      // successful invocation must still report success. Always overwrite.
      this.setExitCode(0);
    } catch (error) {
      if (error instanceof GatewayTokenCommandError) {
        this.failWithLines(error.lines, error.exitCode);
        return;
      }
      throw error;
    }
  }
}
