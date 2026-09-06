// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxEntry } from "../../state/registry";

/** Decode the historical DCode probe override only after package authority is absent. */
export function resolveLegacyInferenceProbeAgent(sandbox: SandboxEntry): string | null {
  return sandbox.agent === "langchain-deepagents-code" ? sandbox.agent : null;
}
