// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";

import { parseHarnessPackageId } from "../../lib/agent-runtime/package/receipt";
import {
  readHarnessPackageForRemoval as readInstalledHarnessPackage,
  removeHarnessPackage,
} from "../../lib/actions/harness/remove";
import { yesFlag } from "../../lib/cli/common-flags";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";
import { isStdinTty } from "../../lib/core/stdin";
import { prompt } from "../../lib/credentials/store";

export const harnessRemoveCommandDependencies = {
  isStdinTty,
  parseHarnessPackageId,
  prompt,
  readInstalledHarnessPackage,
  removeHarnessPackage,
};

export default class HarnessRemoveCommand extends NemoClawCommand {
  static id = "harness:remove";
  static strict = true;
  static enableJsonFlag = true;
  static summary = "Deactivate a harness package for new sandboxes";
  static description =
    "Stop selecting a harness package for new sandboxes while retaining immutable history for existing sandboxes and rollback.";
  static usage = ["harness remove <id> [--yes]"];
  static examples = ["<%= config.bin %> harness remove <id> --yes"];
  static args = {
    id: Args.string({
      description: "Canonical harness package ID",
      ignoreStdin: true,
      required: true,
    }),
  };
  static flags = {
    yes: yesFlag("Confirm removal without an interactive prompt"),
  };

  public async run(): Promise<unknown> {
    const { args, flags } = await this.parse(HarnessRemoveCommand);
    const id = harnessRemoveCommandDependencies.parseHarnessPackageId(args.id);
    const installed = harnessRemoveCommandDependencies.readInstalledHarnessPackage(id);
    if (installed !== null && !flags.yes) {
      if (this.jsonEnabled() || !harnessRemoveCommandDependencies.isStdinTty()) {
        this.error(
          "Removing an active harness package requires explicit confirmation. Rerun with '--yes'.",
          { exit: 2 },
        );
      }
      const answer = (
        await harnessRemoveCommandDependencies.prompt(
          `Deactivate harness package '${installed.identity.id}'? Immutable package history will be retained. [y/N]: `,
        )
      )
        .trim()
        .toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        this.log("Removal cancelled.");
        return;
      }
    }
    const result = harnessRemoveCommandDependencies.removeHarnessPackage(id, {
      ...(installed === null ? {} : { expectedIdentity: installed.identity }),
    });
    if (this.jsonEnabled()) return result;
    if (result.state === "deactivated") {
      this.log(
        `Deactivated harness package '${result.identity.id}'. Immutable package history was retained.`,
      );
    } else {
      this.log(
        `Harness package '${result.id}' is already inactive; no package history was deleted.`,
      );
    }
  }
}
