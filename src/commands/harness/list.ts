// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";
import { printHarnessPackageList } from "../../lib/harness/list-command";

export default class HarnessListCommand extends NemoClawCommand {
  static id = "harness:list";
  static strict = true;
  static summary = "List available harness packages";
  static description = "List bundled and installed harness packages.";
  static usage = ["harness list"];
  static examples = ["<%= config.bin %> harness list"];
  static flags = {};

  public async run(): Promise<void> {
    await this.parse(HarnessListCommand);
    printHarnessPackageList(this.log.bind(this));
  }
}
