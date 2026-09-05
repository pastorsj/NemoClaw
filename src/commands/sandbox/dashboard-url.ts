// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";
import { quietFlag } from "../../lib/cli/common-flags";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";
import { DashboardUrlCommandError, runDashboardUrlCommand } from "../../lib/dashboard-url-command";
import type { SandboxDashboardPresentation } from "../../lib/dashboard-url-command";
import type { SandboxEntry } from "../../lib/state/registry";

type DashboardUrlRuntimeBridge = {
  fetchDashboardToken?: (sandboxName: string) => string | null;
  /** Legacy test/caller bridge retained for no-receipt OpenClaw rows. */
  fetchGatewayAuthTokenFromSandbox?: (sandboxName: string) => string | null;
  getSandbox: (sandboxName: string) => Pick<SandboxEntry, "agent" | "dashboardPort"> | null;
  getSandboxPresentation?: (sandboxName: string) => SandboxDashboardPresentation | null;
  getAccessUrl?: (port: number) => string | null;
};

let runtimeBridgeFactory = (): DashboardUrlRuntimeBridge => {
  const agentDefs = require("../../lib/agent/defs") as typeof import("../../lib/agent/defs");
  const commandAgent =
    require("../../lib/sandbox/command-agent") as typeof import("../../lib/sandbox/command-agent");
  const agentToken =
    require("../../lib/onboard/agent-web-auth-token") as typeof import("../../lib/onboard/agent-web-auth-token");
  const sandboxConfig = require("../../lib/sandbox/config") as Pick<
    typeof import("../../lib/sandbox/config"),
    "readSandboxConfig"
  >;
  const registry = require("../../lib/state/registry") as {
    getSandbox: (name: string) => SandboxEntry | null;
  };
  const dashboardAccess =
    require("../../lib/onboard/dashboard-access") as typeof import("../../lib/onboard/dashboard-access");
  const runner = require("../../lib/runner") as Pick<
    typeof import("../../lib/runner"),
    "runCapture"
  >;
  const getEntry = (sandboxName: string): SandboxEntry | null => {
    try {
      return registry.getSandbox(sandboxName);
    } catch {
      return null;
    }
  };
  const resolveDefinition = (entry: SandboxEntry) => commandAgent.resolveSandboxCommandAgent(entry);
  return {
    fetchDashboardToken: (sandboxName: string) => {
      const entry = getEntry(sandboxName);
      return entry
        ? agentToken.fetchAgentDashboardTokenFromSandbox(
            sandboxConfig.readSandboxConfig,
            sandboxName,
            resolveDefinition(entry),
          )
        : null;
    },
    getSandbox: getEntry,
    getSandboxPresentation: (sandboxName: string) => {
      const entry = getEntry(sandboxName);
      if (!entry) return null;
      const definition = resolveDefinition(entry);
      return {
        dashboardPort: entry.dashboardPort,
        dashboard: { auth: definition.dashboard.auth, label: definition.dashboard.label },
        runtime: {
          kind: agentDefs.getAgentRuntimeKind(definition),
          displayName: definition.displayName,
        },
      };
    },
    getAccessUrl: (port: number) =>
      dashboardAccess.buildDashboardChain(`http://127.0.0.1:${port}`, {
        runCapture: runner.runCapture,
      }).accessUrl,
  };
};

export function setDashboardUrlRuntimeBridgeFactoryForTest(
  factory: () => DashboardUrlRuntimeBridge,
): void {
  runtimeBridgeFactory = factory;
}

function getRuntimeBridge(): DashboardUrlRuntimeBridge {
  return runtimeBridgeFactory();
}

export default class DashboardUrlCliCommand extends NemoClawCommand {
  static id = "sandbox:dashboard-url";
  static strict = true;
  static summary = "Print the dashboard URL";
  static description = "Print the browser-facing dashboard URL for a running sandbox.";
  static usage = ["<name> [--quiet|-q]"];
  static examples = [
    "<%= config.bin %> sandbox dashboard-url alpha",
    "<%= config.bin %> sandbox dashboard-url alpha --quiet",
  ];
  static args = {
    sandboxName: Args.string({
      name: "sandbox",
      description: "Sandbox name",
      required: true,
    }),
  };
  static flags = {
    quiet: quietFlag("Print only the URL"),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(DashboardUrlCliCommand);
    process.stdout.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") {
        this.setExitCode(0);
        return;
      }
      throw err;
    });

    const runtime = getRuntimeBridge();
    try {
      runDashboardUrlCommand(
        args.sandboxName,
        { quiet: flags.quiet === true },
        {
          fetchToken:
            runtime.fetchDashboardToken ?? runtime.fetchGatewayAuthTokenFromSandbox ?? (() => null),
          getSandbox: runtime.getSandbox,
          getSandboxPresentation: runtime.getSandboxPresentation,
          getAccessUrl: runtime.getAccessUrl,
        },
      );
      this.setExitCode(0);
    } catch (error) {
      if (error instanceof DashboardUrlCommandError) {
        this.failWithLines(error.lines, error.exitCode);
        return;
      }
      throw error;
    }
  }
}
