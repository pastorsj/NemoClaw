// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Product-qualified image repositories used only by the explicit stock-image compatibility lane. */
export const MANAGED_IMAGE_REPOSITORIES = Object.freeze({
  openclaw: "ghcr.io/nvidia/nemoclaw/openclaw-sandbox",
  hermes: "ghcr.io/nvidia/nemoclaw/hermes-sandbox",
  "langchain-deepagents-code": "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox",
  pi: "ghcr.io/nvidia/nemoclaw/pi-sandbox",
} as const);
