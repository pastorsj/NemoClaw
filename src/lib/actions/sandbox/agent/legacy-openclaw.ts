// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HarnessAgentCommandDeclaration } from "@nvidia/nemoclaw-harness-contract";

import {
  buildPackageAgentCommandPlan,
  packageRequestedTimeoutSeconds,
  type PackageAgentCommandPlan,
} from "./command-plan";

/**
 * Native grammar retained only for OpenClaw sandboxes that predate package receipts.
 * Receipt-backed OpenClaw reads the equivalent declaration from its installed manifest.
 */
export const LEGACY_OPENCLAW_AGENT_COMMAND: HarnessAgentCommandDeclaration = Object.freeze({
  argv: Object.freeze(["openclaw", "agent"]),
  output_mode: "bounded-text",
  selector_options: Object.freeze(["--agent", "--session-id", "--session-key", "--to"]),
  selector_required: true,
  value_options: Object.freeze([
    "-a",
    "-m",
    "--message",
    "--model",
    "--provider",
    "--reply-channel",
    "--thinking",
    "--timeout",
  ]),
  boolean_options: Object.freeze(["--deliver"]),
  json_output_option: "--json",
  timeout_option: "--timeout",
});

/** Read the legacy native timeout only from the exact historical command prefix. */
export function requestedLegacyOpenClawTimeoutSeconds(argv: readonly string[]): number | null {
  if (argv[0] !== "openclaw" || argv[1] !== "agent") return null;
  return packageRequestedTimeoutSeconds(argv.slice(2), LEGACY_OPENCLAW_AGENT_COMMAND);
}

function hasLegacySelector(args: readonly string[]): boolean {
  const selectors = LEGACY_OPENCLAW_AGENT_COMMAND.selector_options ?? [];
  for (const argument of args) {
    if (argument === "--") return false;
    if (
      selectors.some((selector) => argument === selector || argument.startsWith(`${selector}=`))
    ) {
      return true;
    }
  }
  return false;
}

/** Preserve the historical no-receipt selector scan while using the finite grammar. */
export function buildLegacyOpenClawCommandPlan(args: readonly string[]): PackageAgentCommandPlan {
  for (const argument of args) {
    if (argument === "--") break;
    if (argument === "-h" || argument === "--help") return { kind: "help" };
  }
  const plan = buildPackageAgentCommandPlan(LEGACY_OPENCLAW_AGENT_COMMAND, args);
  if (plan.kind !== "missing-selector" || !hasLegacySelector(args)) return plan;
  return buildPackageAgentCommandPlan(
    { ...LEGACY_OPENCLAW_AGENT_COMMAND, selector_required: false },
    args,
  );
}

/** Identify the historical default only when no installed package owns the sandbox. */
export function isLegacyOpenClawSandbox(entry: {
  readonly agent?: string | null;
  readonly harnessPackage?: unknown;
}): boolean {
  return (
    !entry.harnessPackage &&
    (entry.agent === null || entry.agent === undefined || entry.agent === "openclaw")
  );
}
