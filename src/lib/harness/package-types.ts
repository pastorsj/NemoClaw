// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface HarnessPackageEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly kind: "agent-runtime";
  readonly id: string;
  readonly displayName: string;
  readonly packageVersion: string;
  readonly contractVersion: 1;
  readonly manifest: string;
}

export interface HarnessPackageIdentity {
  readonly kind: "agent-runtime";
  readonly id: string;
  readonly packageVersion: string;
  readonly contractVersion: 1;
  readonly contentDigest: string;
}
