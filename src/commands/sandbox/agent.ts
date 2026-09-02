// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runAgentPassthrough } from "../../lib/actions/sandbox/agent/passthrough";
import { printAgentPassthroughHelp } from "../../lib/actions/sandbox/agent/passthrough-help";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

export default class SandboxAgentCommand extends NemoClawCommand {
  static id = "sandbox:agent";
  static customHelp = true;
  static strict = false;
  static summary = "Run one agent turn non-interactively in a sandbox";
  static description =
    "Run the registered package's headless command with a common prompt. Bare, help, and option-first package commands stay native. OpenClaw selector flags keep the native `openclaw agent` passthrough.";
  static usage = ["<name> [prompt-or-agent-flags...]"];
  static examples = [
    '<%= config.bin %> sandbox agent alpha "Summarise README.md"',
    '<%= config.bin %> sandbox agent alpha --agent main -m "Summarise README.md"',
    '<%= config.bin %> sandbox agent alpha --agent main -m "Status update?"',
    '<%= config.bin %> sandbox agent alpha --session-id review-42 -m "Any new findings?"',
    "<%= config.bin %> sandbox agent alpha --session-key intake-42 --json -m 'ping'",
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
      printAgentPassthroughHelp();
      return;
    }
    await runAgentPassthrough(sandboxName, { extraArgs });
  }
}
