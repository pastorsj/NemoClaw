// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type McpBridgeErrorReasonCode = "rejected" | "unresolved";

export class McpBridgeError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
    readonly reasonCode?: McpBridgeErrorReasonCode,
  ) {
    super(message);
    this.name = "McpBridgeError";
  }
}
