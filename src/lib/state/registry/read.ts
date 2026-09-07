// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { load } from "./persistence";
import type { SandboxEntry } from "./types";

/** Read one sandbox without exposing the registry mutation surface. */
export function getSandbox(name: string): SandboxEntry | null {
  return load().sandboxes[name] || null;
}
