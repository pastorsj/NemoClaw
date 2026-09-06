// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Compile every typed host adapter source into its checked-in runtime artifact. */
export declare function buildHarnessAdapterArtifacts(
  packageRootInput: string,
  check?: boolean,
): void;

/** Fail when any generated host adapter differs from its typed authoring source. */
export declare function assertHarnessAdapterArtifactsCurrent(packageRoot: string): void;
