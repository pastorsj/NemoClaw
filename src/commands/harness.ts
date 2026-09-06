// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../lib/cli/nemoclaw-oclif-command";

export default class HarnessCommand extends NemoClawCommand {
  static id = "harness";
  static strict = true;
  static summary = "Manage and validate agent runtime packages";
  static description = "Install, inspect, activate, remove, or validate agent runtime packages.";
  static usage = ["harness <activate|install|list|remove|validate>"];
  static examples = [
    "<%= config.bin %> harness list",
    "<%= config.bin %> harness install <id>",
    "<%= config.bin %> harness activate <id> --digest <sha256>",
    "<%= config.bin %> harness remove <id> --yes",
    "<%= config.bin %> harness validate ./dist/nemoclaw-example",
  ];
  static flags = {};

  public async run(): Promise<void> {
    await this.parse(HarnessCommand);
    this.log(`Usage: ${this.config.bin} harness <activate|install|list|remove|validate>`);
  }
}
