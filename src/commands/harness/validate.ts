// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";

import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";
import { validateHarnessPackage } from "../../lib/harness/package-validation";

export const harnessValidateCommandDependencies = {
  validateHarnessPackage,
};

export default class HarnessValidateCommand extends NemoClawCommand {
  static id = "harness:validate";
  static strict = true;
  static enableJsonFlag = true;
  static summary = "Validate one built agent runtime package without changing it";
  static description =
    "Validate one built agent runtime package without installing it or running package code.";
  static usage = ["harness validate <artifact-directory> [--json]"];
  static examples = [
    "<%= config.bin %> harness validate ./dist/nemoclaw-example",
    "<%= config.bin %> harness validate ./dist/nemoclaw-example --json",
  ];
  static args = {
    artifactDirectory: Args.string({
      name: "artifact-directory",
      description: "Path to one built agent runtime package",
      ignoreStdin: true,
      required: true,
    }),
  };
  static flags = {};

  public async run(): Promise<unknown> {
    const { args } = await this.parse(HarnessValidateCommand);
    const report = harnessValidateCommandDependencies.validateHarnessPackage(
      args.artifactDirectory,
    );
    if (this.jsonEnabled()) return report;
    this.log(
      `Validated built agent runtime package '${report.identity.id}' (${report.identity.packageVersion}, contract ${String(report.identity.contractVersion)}, sha256:${report.identity.contentDigest}) without installing it.`,
    );
  }
}
