// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { BuildIdentity } from "../../core/build-identity";
import type { HarnessPackageEnvelope } from "./types";

type HarnessPackageCompatibilityWindow = Pick<
  HarnessPackageEnvelope,
  "minimumNemoClawVersion" | "maximumNemoClawVersionExclusive"
>;

function coreVersionParts(version: string): readonly [bigint, bigint, bigint] {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  if (!match) {
    throw new Error("Running NemoClaw build identity does not start with an x.y.z version");
  }
  return [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])];
}

function compareCoreVersions(left: string, right: string): number {
  const leftParts = coreVersionParts(left);
  const rightParts = coreVersionParts(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] === rightParts[index]) continue;
    return leftParts[index] < rightParts[index] ? -1 : 1;
  }
  return 0;
}

export class HarnessPackageCompatibilityError extends Error {
  override readonly name = "HarnessPackageCompatibilityError";
}

/** Require the running core to fall within the package's half-open compatibility window. */
export function assertHarnessPackageSupportsNemoClaw(
  compatibility: HarnessPackageCompatibilityWindow,
  buildIdentity: BuildIdentity,
): void {
  const running = buildIdentity.nemoclawVersion;
  if (compareCoreVersions(running, compatibility.minimumNemoClawVersion) < 0) {
    throw new HarnessPackageCompatibilityError(
      `Harness package requires NemoClaw ${compatibility.minimumNemoClawVersion} or newer; running build is ${running}`,
    );
  }
  if (compareCoreVersions(running, compatibility.maximumNemoClawVersionExclusive) >= 0) {
    throw new HarnessPackageCompatibilityError(
      `Harness package requires NemoClaw older than ${compatibility.maximumNemoClawVersionExclusive}; running build is ${running}`,
    );
  }
}
