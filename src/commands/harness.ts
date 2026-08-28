// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../lib/cli/nemoclaw-oclif-command";

export default class HarnessCommand extends NemoClawCommand {
  static id = "harness";
  static strict = true;
  static summary = "Inspect harness packages";
  static description = "Inspect installed and reviewed available harness packages.";
  static usage = ["harness list"];
  static examples = ["<%= config.bin %> harness list"];
  static flags = {};

  public async run(): Promise<void> {
    await this.parse(HarnessCommand);
    this.log(`Usage: ${this.config.bin} harness list`);
  }
}
