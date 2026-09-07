// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  hasAgentsPassthroughHelpToken,
  printAgentsPassthroughHelp,
  runAgentsPassthrough,
} from "../../../lib/actions/sandbox/agents/passthrough";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

export default class SandboxAgentsListCommand extends NemoClawCommand {
  static id = "sandbox:agents:list";
  static customHelp = true;
  static strict = false;
  static summary = "List agents configured by the installed harness";
  static description =
    "Ask the installed harness package for its native agent-list command, then run that command through OpenShell. Additional arguments are forwarded verbatim through the typed adapter.";
  static usage = ["<name> [harness-agents-list-flags...]"];
  static examples = [
    "<%= config.bin %> sandbox agents list alpha",
    "<%= config.bin %> sandbox agents list alpha --json",
    "<%= config.bin %> sandbox agents list alpha --bindings",
  ];

  public async run(): Promise<void> {
    this.parsed = true;
    const [sandboxName, ...extraArgs] = this.argv;
    if (
      !sandboxName ||
      sandboxName.trim() === "" ||
      sandboxName === "--help" ||
      sandboxName === "-h"
    ) {
      printAgentsPassthroughHelp("list");
      return;
    }
    if (hasAgentsPassthroughHelpToken(extraArgs)) {
      printAgentsPassthroughHelp("list");
      return;
    }
    await runAgentsPassthrough(sandboxName, { verb: "list", extraArgs });
  }
}
