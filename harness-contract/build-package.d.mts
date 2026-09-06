// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type HarnessPackageBuildDiagnosticCode =
  | "output-exists"
  | "output-owner"
  | "output-path"
  | "source-changed"
  | "write-failed";

export interface HarnessPackageBuildDiagnostic {
  readonly code: HarnessPackageBuildDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface MaterializedHarnessPackage {
  readonly harnessId: string;
  readonly displayName: string;
  readonly packageVersion: string;
  readonly minimumNemoClawVersion: string;
  readonly maximumNemoClawVersionExclusive: string;
  readonly manifestPath: "manifest.yaml";
  readonly fileCount: number;
  readonly readOnly: true;
}

export declare class HarnessPackageBuildError extends Error {
  readonly diagnostic: HarnessPackageBuildDiagnostic;
  constructor(diagnostic: HarnessPackageBuildDiagnostic);
}

/** Materialize one validated npm publish set as a read-only NemoClaw package artifact. */
export declare function materializeHarnessPackageArtifact(
  packageRootInput: string,
  outputDirectoryInput: string,
): MaterializedHarnessPackage;
