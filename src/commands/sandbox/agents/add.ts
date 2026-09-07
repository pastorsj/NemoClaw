// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  hasAgentsPassthroughHelpToken,
  printAgentsPassthroughHelp,
  runAgentsPassthrough,
} from "../../../lib/actions/sandbox/agents/passthrough";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

export default class SandboxAgentsAddCommand extends NemoClawCommand {
  static id = "sandbox:agents:add";
  static customHelp = true;
  static strict = false;
  static summary = "Add an agent through the installed harness";
  static description =
    "Ask the installed harness package for its native agent-add command, then run that command through OpenShell. Additional arguments are forwarded verbatim through the typed adapter.";
  static usage = ["<name> [harness-agents-add-flags...]"];
  static examples = [
    "<%= config.bin %> sandbox agents add alpha",
    "<%= config.bin %> sandbox agents add alpha work --model gpt-4o",
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
      printAgentsPassthroughHelp("add");
      return;
    }
    if (hasAgentsPassthroughHelpToken(extraArgs)) {
      printAgentsPassthroughHelp("add");
      return;
    }
    await runAgentsPassthrough(sandboxName, { verb: "add", extraArgs });
  }
}
