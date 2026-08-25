// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../lib/cli/nemoclaw-oclif-command";

export default class HarnessCommand extends NemoClawCommand {
  static id = "harness";
  static strict = true;
  static summary = "Manage agent runtime packages";
  static description = "List and install agent runtime packages for NemoClaw onboarding.";
  static usage = ["harness list", "harness install [harness]"];
  static examples = [
    "<%= config.bin %> harness list",
    "<%= config.bin %> harness install openclaw",
  ];
  static flags = {};

  public async run(): Promise<void> {
    await this.parse(HarnessCommand);
    this.log(`Usage: ${this.config.bin} harness list`);
    this.log(`       ${this.config.bin} harness install [harness]`);
  }
}
