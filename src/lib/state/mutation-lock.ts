// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Public core vocabulary for serializing mutations of one sandbox. The
// underlying lock predates the package contract and retains its historical MCP
// implementation name; new generic workflows should depend on this boundary.
export {
  isMcpLifecycleLockHeld as isSandboxMutationLockHeld,
  type McpLifecycleLockOptions as SandboxMutationLockOptions,
  withMcpLifecycleLock as withSandboxMutationLock,
  withMcpLifecycleLockSync as withSandboxMutationLockSync,
} from "./mcp-lifecycle-lock-acquisition";
