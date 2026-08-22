// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

export const MCP_DEV_WORKFLOW_EXECUTION_CONTEXT_SHA256 =
  "052c49d5e8688266dbf38fa911733132d33e4470a29a61deb6e7a11067737559";
export const MCP_DEV_JOB_EXECUTION_CONTEXT_SHA256 =
  "b9219b0f29da3834499a7c9dcb0acc8287cb3441d01a51bed615d7b2ea4383f9";
export const MCP_DEV_TRUSTED_NODE_SETUP_CONTENT_SHA256 =
  "504821ad93c57971d0281ef1130ed6008fadd331bd56acb1a6b5e6a3358f3e49";
export const MCP_DEV_TRUSTED_PREFIX_CONTENT_SHA256 =
  "067df18297c3b5e5175dc11de071a0f3c261aa894db6141b8b789d67f5e9c0d1";
export const MCP_DEV_POST_INSTALL_TRANSITION_CONTENT_SHA256 =
  "51605b2b2ca63e59d4d21698b2aff2241af7ecc5a2bf5ed384853eef76cb1d55";

export function contentSha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "")
    .digest("hex");
}
