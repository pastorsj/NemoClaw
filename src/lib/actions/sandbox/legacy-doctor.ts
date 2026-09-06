// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { executeSandboxCommandForVerification } from "../../onboard/sandbox-verification-exec";
import type { SandboxEntry } from "../../state/registry";
import { runSandboxAutoPairApprovalPass } from "./auto-pair-approval";
import type { DoctorCheck } from "./doctor-report";
import { buildToolScopeChecks } from "./doctor-tool-scope";

/**
 * Preserve OpenClaw tool-scope diagnostics only after the caller proves the
 * sandbox has no package receipt. Package-backed diagnostics belong to the
 * package's declared capabilities.
 */
export function collectLegacyOpenClawToolScopeChecks(
  sandboxName: string,
  sandbox: SandboxEntry,
  cliName: string,
  wantsFix: boolean,
): DoctorCheck[] {
  if ((sandbox.agent ?? "openclaw") !== "openclaw") return [];
  return buildToolScopeChecks(sandboxName, cliName, wantsFix, {
    exec: (name, script) => executeSandboxCommandForVerification(name, script),
    runApprovalPass: (name) => {
      const result = runSandboxAutoPairApprovalPass(name, { capture: true });
      return { reported: result.reported, approved: result.approved };
    },
  });
}

/** Preserve the missing-manifest default only for the historical default agent. */
export function legacyDoctorDefaultRuntimeIsGateway(agentName: string): boolean {
  return agentName === "openclaw";
}
