// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";

import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";
import { getBuildIdentity } from "../../lib/core/build-identity";
import { isStdinTty } from "../../lib/core/stdin";
import { prompt } from "../../lib/credentials/store";
import {
  isCandidateAgent,
  isCandidateAgentSelectable,
  requireCandidateAgentSelectable,
} from "../../lib/agent/candidate";
import {
  listHarnessPackageInventory,
  planHarnessPackageInstall,
  type HarnessPackageInventory,
} from "../../lib/agent-runtime/package/catalog";
import { installHarnessPackage } from "../../lib/agent-runtime/package/install";
import { promptForHarnessPackage } from "../../lib/agent-runtime/package/prompt";
import { parseHarnessPackageId } from "../../lib/agent-runtime/package/receipt";

export const harnessInstallCommandDependencies = {
  getBuildIdentity,
  installHarnessPackage,
  isCandidateAgent,
  isCandidateAgentSelectable,
  isStdinTty,
  listHarnessPackageInventory,
  planHarnessPackageInstall,
  prompt,
  promptForHarnessPackage,
  parseHarnessPackageId,
  requireCandidateAgentSelectable,
};

function selectableHarnessInventory(inventory: HarnessPackageInventory): HarnessPackageInventory {
  return Object.freeze({
    ...inventory,
    available: Object.freeze(
      inventory.available.filter(
        ({ id }) =>
          !harnessInstallCommandDependencies.isCandidateAgent(id) ||
          harnessInstallCommandDependencies.isCandidateAgentSelectable(id),
      ),
    ),
  });
}

export default class HarnessInstallCommand extends NemoClawCommand {
  static id = "harness:install";
  static strict = true;
  static summary = "Install a harness package";
  static description =
    "Install one reviewed bundled package, or one explicitly trusted local built package.";
  static usage = [
    "harness install [id]",
    "harness install <id> --from <built-directory> --yes-i-trust-local-package",
  ];
  static examples = [
    "<%= config.bin %> harness install",
    "<%= config.bin %> harness install <id>",
    "<%= config.bin %> harness install example --from ./dist/nemoclaw-example --yes-i-trust-local-package",
  ];
  static args = {
    id: Args.string({
      description: "Bundled package ID or alias; use a canonical package ID with --from",
      ignoreStdin: true,
      required: false,
    }),
  };
  static flags = {
    from: Flags.string({
      description: "Path to one local built harness package",
    }),
    "yes-i-trust-local-package": Flags.boolean({
      description: "Acknowledge that the local package is trusted code",
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(HarnessInstallCommand);
    let selector = args.id;

    if (flags.from !== undefined) {
      if (selector === undefined) {
        this.error(
          "A canonical harness package ID is required with '--from'. Run 'nemoclaw harness install <id> --from <built-directory> --yes-i-trust-local-package'.",
          { exit: 2 },
        );
      }
      if (!flags["yes-i-trust-local-package"]) {
        this.error(
          "Local harness packages are trusted code. Pass '--yes-i-trust-local-package' only after reviewing the package.",
          { exit: 2 },
        );
      }
      if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(flags.from)) {
        this.error("'--from' accepts a local filesystem directory, not a URL.", { exit: 2 });
      }
      const requestedId = harnessInstallCommandDependencies.parseHarnessPackageId(selector);
      harnessInstallCommandDependencies.requireCandidateAgentSelectable(requestedId);
      const installed = harnessInstallCommandDependencies.installHarnessPackage({
        packageRoot: flags.from,
        expectedId: requestedId,
        sourceIdentity: { kind: "local" },
      });
      this.log(
        `Installed trusted local harness package '${installed.identity.id}' (${installed.identity.packageVersion}, sha256:${installed.identity.contentDigest}).`,
      );
      return;
    }
    if (flags["yes-i-trust-local-package"]) {
      this.error("'--yes-i-trust-local-package' may be used only with '--from'.", { exit: 2 });
    }

    if (selector === undefined) {
      if (!harnessInstallCommandDependencies.isStdinTty()) {
        this.error(
          "A harness package ID is required without an interactive terminal. Run 'nemoclaw harness install <id>'.",
          { exit: 2 },
        );
      }
      const selection = await harnessInstallCommandDependencies.promptForHarnessPackage({
        inventory: selectableHarnessInventory(
          harnessInstallCommandDependencies.listHarnessPackageInventory(),
        ),
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

    const plan = harnessInstallCommandDependencies.planHarnessPackageInstall(selector);
    harnessInstallCommandDependencies.requireCandidateAgentSelectable(plan.packageRecord.id);
    if (plan.kind === "keep-installed") {
      this.log(
        `Harness package '${plan.packageRecord.identity.id}' is already active (${plan.packageRecord.identity.packageVersion}, sha256:${plan.packageRecord.identity.contentDigest}).`,
      );
      return;
    }
    const available = plan.packageRecord;
    const installed = harnessInstallCommandDependencies.installHarnessPackage({
      packageRoot: available.packageRoot,
      expectedId: available.id,
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
