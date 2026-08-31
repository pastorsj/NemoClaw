// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";

import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";
import { getBuildIdentity } from "../../lib/core/version";
import { isStdinTty } from "../../lib/core/stdin";
import { prompt } from "../../lib/credentials/store";
import {
  listHarnessPackageInventory,
  resolveHarnessPackageInstallSelection,
} from "../../lib/agent-runtime/package/catalog";
import { installHarnessPackage } from "../../lib/agent-runtime/package/install";
import { promptForHarnessPackage } from "../../lib/agent-runtime/package/prompt";

export const harnessInstallCommandDependencies = {
  getBuildIdentity,
  installHarnessPackage,
  isStdinTty,
  listHarnessPackageInventory,
  prompt,
  promptForHarnessPackage,
  resolveHarnessPackageInstallSelection,
};

export default class HarnessInstallCommand extends NemoClawCommand {
  static id = "harness:install";
  static strict = true;
  static summary = "Install a reviewed harness package";
  static description = "Install one reviewed harness package bundled with this NemoClaw build.";
  static usage = ["harness install [id]"];
  static examples = [
    "<%= config.bin %> harness install",
    "<%= config.bin %> harness install openclaw",
  ];
  static args = {
    id: Args.string({
      description: "Exact reviewed harness package ID or current public alias",
      ignoreStdin: true,
      required: false,
    }),
  };
  static flags = {};

  public async run(): Promise<void> {
    const { args } = await this.parse(HarnessInstallCommand);
    let selector = args.id;

    if (selector === undefined) {
      if (!harnessInstallCommandDependencies.isStdinTty()) {
        this.error(
          "A harness package ID is required without an interactive terminal. Run 'nemoclaw harness install <id>'.",
          { exit: 2 },
        );
      }
      const selection = await harnessInstallCommandDependencies.promptForHarnessPackage({
        inventory: harnessInstallCommandDependencies.listHarnessPackageInventory(),
        log: (message = "") => this.log(message),
        prompt: harnessInstallCommandDependencies.prompt,
      });
      if (selection.kind === "exit") {
        if (selection.reason === "all-installed") {
          this.log("All reviewed harness packages are already installed.");
        } else if (selection.reason === "eof") {
          this.log("Harness installation cancelled because input closed.");
        } else {
          this.log("Harness installation cancelled.");
        }
        return;
      }
      selector = selection.id;
    }

    const available =
      harnessInstallCommandDependencies.resolveHarnessPackageInstallSelection(selector);
    const installed = harnessInstallCommandDependencies.installHarnessPackage({
      packageRoot: available.packageRoot,
      sourceIdentity: {
        kind: "bundled",
        nemoclawBuildIdentity: harnessInstallCommandDependencies.getBuildIdentity({
          rootDir: this.config.root,
        }),
      },
    });
    this.log(
      `Installed harness package '${installed.identity.id}' (${installed.identity.packageVersion}, sha256:${installed.identity.contentDigest}).`,
    );
  }
}
