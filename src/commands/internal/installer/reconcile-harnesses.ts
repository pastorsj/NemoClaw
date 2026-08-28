// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { jsonFlag } from "../../../lib/cli/common-flags";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

import {
  InstallerHarnessReconciliationError,
  reconcileInstallerHarnesses,
} from "../../../lib/actions/installer/harness-reconcile";
import { getBundledHarnessPackageSourceIdentity } from "../../../lib/harness/package-receipt";

const BLOCKED_RESULT = Object.freeze({
  schemaVersion: 1,
  outcome: "blocked",
});

export default class InternalInstallerReconcileHarnessesCommand extends NemoClawCommand {
  static hidden = true;
  static strict = true;
  static summary = "Internal: reconcile installer harness package authority";
  static description =
    "Reconcile legacy installer state to exact reviewed harness package authority.";
  static usage = ["internal installer reconcile-harnesses --json"];
  static flags = {
    json: jsonFlag("Print the closed reconciliation outcome as JSON"),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(InternalInstallerReconcileHarnessesCommand);
    try {
      const result = reconcileInstallerHarnesses({
        sourceIdentity: getBundledHarnessPackageSourceIdentity({ rootDir: this.config.root }),
      });
      if (flags.json) this.logJson({ schemaVersion: 1, outcome: result.outcome });
      else this.log(`Harness package reconciliation: ${result.outcome}.`);
    } catch (error) {
      if (flags.json) {
        this.logJson(BLOCKED_RESULT);
        this.exit(1);
      }
      this.error(
        error instanceof InstallerHarnessReconciliationError
          ? error.message
          : "Harness package reconciliation failed. Repair NemoClaw state and retry.",
        { exit: 1 },
      );
    }
  }
}
