// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  hasAgentsPassthroughHelpToken,
  printAgentsPassthroughHelp,
  runAgentsPassthrough,
} from "../../../lib/actions/sandbox/agents/passthrough";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

export default class SandboxAgentsDeleteCommand extends NemoClawCommand {
  static id = "sandbox:agents:delete";
  static customHelp = true;
  static strict = false;
  static summary = "Delete an agent through the installed harness";
  static description =
    "Ask the installed harness package for its native agent-delete command, then run that command through OpenShell. Additional arguments are forwarded verbatim through the typed adapter.";
  static usage = ["<name> <agent-id> [harness-agents-delete-flags...]"];
  static examples = [
    "<%= config.bin %> sandbox agents delete alpha work",
    "<%= config.bin %> sandbox agents delete alpha work --force --json",
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
      printAgentsPassthroughHelp("delete");
      return;
    }
    if (hasAgentsPassthroughHelpToken(extraArgs)) {
      printAgentsPassthroughHelp("delete");
      return;
    }
    await runAgentsPassthrough(sandboxName, { verb: "delete", extraArgs });
  }
}
