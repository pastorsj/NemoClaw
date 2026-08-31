// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";
import {
  createHarnessInventoryView,
  renderHarnessInventoryText,
} from "../../lib/agent-runtime/package/inventory";

export const harnessListCommandDependencies = {
  createHarnessInventoryView,
  renderHarnessInventoryText,
};

export default class HarnessListCommand extends NemoClawCommand {
  static id = "harness:list";
  static strict = true;
  static enableJsonFlag = true;
  static summary = "List installed and reviewed available harness packages";
  static description =
    "List installed harness packages and reviewed packages available to install.";
  static usage = ["harness list [--json]"];
  static examples = ["<%= config.bin %> harness list"];
  static flags = {};

  public async run(): Promise<unknown> {
    await this.parse(HarnessListCommand);
    const view = harnessListCommandDependencies.createHarnessInventoryView();
    if (this.jsonEnabled()) return view;
    this.log(harnessListCommandDependencies.renderHarnessInventoryText(view));
  }
}
