// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Receipt authority shared by sandbox subcommands. */
export {
  readPublishedSandboxAuthority,
  readRegisteredSandboxAuthority,
  resolveLifecycleEligibleSandboxAgent,
  resolvePackageBackedSandboxAgent,
  resolveRecordedSandboxAgentAuthority,
  type RegisteredSandboxAuthority,
} from "../../../onboard/package/package-authority";
