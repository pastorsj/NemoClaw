// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";

import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";
import { promptForRuntimePackage } from "../../lib/harness/install-command";
import {
  installBundledHarness,
  refreshInstalledBundledHarnesses,
} from "../../lib/harness/package-registry";

export default class HarnessInstallCommand extends NemoClawCommand {
  static id = "harness:install";
  static strict = true;
  static summary = "Install an agent runtime package";
  static description = "Choose, install, or confirm an agent runtime package for onboarding.";
  static usage = [
    "harness install",
    "harness install <harness>",
    "harness install --refresh-installed",
  ];
  static examples = [
    "<%= config.bin %> harness install",
    "<%= config.bin %> harness install openclaw",
    "<%= config.bin %> harness install --refresh-installed",
  ];
  static args = {
    harness: Args.string({
      name: "HARNESS",
      description: "Bundled agent runtime package ID",
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
    let selectedHarness = args.harness;
    if (selectedHarness === undefined) {
      if (flags["refresh-installed"] === true) {
        for (const harnessPackage of refreshInstalledBundledHarnesses(process.env)) {
          this.log(`Agent runtime package '${harnessPackage.id}' is installed.`);
        }
        return;
      }
      if (!process.stdin.isTTY) {
        this.error(
          "An agent runtime package ID is required when input is not a terminal. Run 'nemoclaw harness install <harness>'.",
        );
      }
      const promptedHarness = await promptForRuntimePackage(this.log.bind(this));
      if (promptedHarness === null) return;
      selectedHarness = promptedHarness;
    }
    const selected = installBundledHarness(selectedHarness);
    this.log(`Agent runtime package '${selected.id}' is installed.`);
    if (flags["refresh-installed"]) {
      for (const harnessPackage of refreshInstalledBundledHarnesses(process.env, selected.id)) {
        this.log(`Agent runtime package '${harnessPackage.id}' is installed.`);
      }
    }
  }
}
