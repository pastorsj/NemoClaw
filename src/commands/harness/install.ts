// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";

import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";
import {
  installBundledHarness,
  refreshInstalledBundledHarnesses,
} from "../../lib/harness/package-registry";

export default class HarnessInstallCommand extends NemoClawCommand {
  static id = "harness:install";
  static strict = true;
  static summary = "Install a bundled harness package";
  static description = "Install or confirm a bundled harness package for NemoClaw onboarding.";
  static usage = ["harness install <harness>", "harness install --refresh-installed"];
  static examples = [
    "<%= config.bin %> harness install openclaw",
    "<%= config.bin %> harness install --refresh-installed",
  ];
  static args = {
    harness: Args.string({
      name: "HARNESS",
      description: "Bundled harness package",
      ignoreStdin: true,
      required: false,
    }),
  };
  static flags = {
    "refresh-installed": Flags.boolean({
      description: "Refresh clean installed packages that are bundled by this NemoClaw build",
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(HarnessInstallCommand);
    switch (args.harness) {
      case undefined:
        switch (flags["refresh-installed"] === true) {
          case false:
            this.error("A harness id is required unless --refresh-installed is set.");
        }
        for (const harnessPackage of refreshInstalledBundledHarnesses(process.env)) {
          this.log(`Agent runtime package '${harnessPackage.id}' is installed.`);
        }
        return;
    }
    const selected = installBundledHarness(args.harness);
    this.log(`Agent runtime package '${selected.id}' is installed.`);
    if (flags["refresh-installed"]) {
      for (const harnessPackage of refreshInstalledBundledHarnesses(process.env, selected.id)) {
        this.log(`Agent runtime package '${harnessPackage.id}' is installed.`);
      }
    }
  }
}
