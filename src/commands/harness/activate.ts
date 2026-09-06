// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";

import {
  parseHarnessPackageContentDigest,
  parseHarnessPackageId,
} from "../../lib/agent-runtime/package/receipt";
import { activateHarnessPackage } from "../../lib/agent-runtime/package/store";
import type { HarnessPackageIdentity } from "../../lib/agent-runtime/package/types";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

export const harnessActivateCommandDependencies = {
  activateHarnessPackage,
  parseHarnessPackageContentDigest,
  parseHarnessPackageId,
};

export interface HarnessPackageActivationResult {
  readonly schemaVersion: 1;
  readonly state: "active";
  readonly identity: HarnessPackageIdentity;
}

function canonicalDigest(value: string): string {
  const digest = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
  return harnessActivateCommandDependencies.parseHarnessPackageContentDigest(digest);
}

export default class HarnessActivateCommand extends NemoClawCommand {
  static id = "harness:activate";
  static strict = true;
  static enableJsonFlag = true;
  static summary = "Activate an installed harness package revision";
  static description =
    "Move one harness's active pointer to an existing verified immutable package receipt.";
  static usage = ["harness activate <id> --digest <sha256>"];
  static examples = [
    "<%= config.bin %> harness activate <id> --digest sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  ];
  static args = {
    id: Args.string({
      description: "Canonical harness package ID",
      ignoreStdin: true,
      required: true,
    }),
  };
  static flags = {
    digest: Flags.string({
      description: "Existing package content digest, with an optional sha256: prefix",
      required: true,
    }),
  };

  public async run(): Promise<unknown> {
    const { args, flags } = await this.parse(HarnessActivateCommand);
    const id = harnessActivateCommandDependencies.parseHarnessPackageId(args.id);
    const digest = canonicalDigest(flags.digest);
    const activated = harnessActivateCommandDependencies.activateHarnessPackage(id, digest);
    const result: HarnessPackageActivationResult = Object.freeze({
      schemaVersion: 1,
      state: "active",
      identity: activated.identity,
    });
    if (this.jsonEnabled()) return result;
    this.log(
      `Activated harness package '${activated.identity.id}' (${activated.identity.packageVersion}, sha256:${activated.identity.contentDigest}).`,
    );
  }
}
