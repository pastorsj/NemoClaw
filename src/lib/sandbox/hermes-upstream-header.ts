// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { buildHermesUpstreamHeader as buildPackageHermesUpstreamHeader } from "../hermes-managed-route";

export function buildHermesUpstreamHeader(config: Record<string, unknown>): string {
  return buildPackageHermesUpstreamHeader(config);
}
