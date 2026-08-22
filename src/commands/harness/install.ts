// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";

import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";
import { installBundledHarness } from "../../lib/harness/package-registry";

const BUNDLED_HARNESS_IDS = ["openclaw", "hermes", "langchain-deepagents-code"] as const;

export default class HarnessInstallCommand extends NemoClawCommand {
  static id = "harness:install";
  static strict = true;
  static summary = "Install a bundled harness package";
  static description = "Install or confirm a bundled harness package for NemoClaw onboarding.";
  static usage = ["harness install <openclaw|hermes|langchain-deepagents-code>"];
  static examples = BUNDLED_HARNESS_IDS.map((id) => `<%= config.bin %> harness install ${id}`);
  static args = {
    harness: Args.string({
      name: "HARNESS",
      description: "Bundled harness package",
      ignoreStdin: true,
      options: [...BUNDLED_HARNESS_IDS],
      required: true,
    }),
  };
  static flags = {};

  public async run(): Promise<void> {
    const { args } = await this.parse(HarnessInstallCommand);
    const harnessPackage = installBundledHarness(args.harness);
    this.log(`Harness ${harnessPackage.id} is ready.`);
  }
}
