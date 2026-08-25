// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";

import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";
import { buildHarnessPackageList, printHarnessPackageList } from "../../lib/harness/list-command";

export default class HarnessListCommand extends NemoClawCommand {
  static id = "harness:list";
  static strict = true;
  static enableJsonFlag = true;
  static summary = "List installed and available agent runtime packages";
  static description = "List installed agent runtime packages and packages available to install.";
  static usage = ["harness list [--json]"];
  static examples = ["<%= config.bin %> harness list", "<%= config.bin %> harness list --json"];
  static flags = {
    json: Flags.boolean({
      description: "Print package inventory as JSON",
      hidden: true,
    }),
  };

  public async run(): Promise<unknown> {
    await this.parse(HarnessListCommand);
    const packageList = buildHarnessPackageList();
    if (this.jsonEnabled()) return packageList;
    printHarnessPackageList(this.log.bind(this), packageList);
  }
}
