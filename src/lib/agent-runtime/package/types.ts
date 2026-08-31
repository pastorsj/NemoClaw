// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface HarnessPackageEnvelope {
  readonly schemaVersion: 1;
  readonly kind: "agent-runtime";
  readonly id: string;
  readonly displayName: string;
  readonly packageVersion: string;
  readonly manifest: string;
}

export interface HarnessPackageIdentity {
  readonly kind: "agent-runtime";
  readonly id: string;
  readonly packageVersion: string;
  readonly contentDigest: string;
}

export interface HarnessPackageMigration {
  readonly schemaVersion: 1;
  readonly source: "legacy-current-bundle";
  readonly legacyAgent: string | null;
  readonly migratedAt: string;
}

/** Complete durable authority: exact package identity or explicit qualified-agent absence. */
export type HarnessPackageAuthority =
  | {
      readonly harnessPackage: HarnessPackageIdentity;
      readonly harnessPackageMigration: HarnessPackageMigration | null;
    }
  | {
      readonly harnessPackage: null;
      readonly harnessPackageMigration: null;
    };
