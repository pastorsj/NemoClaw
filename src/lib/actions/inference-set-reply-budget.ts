// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadHarnessCommonJsModule } from "../harness/commonjs-runtime";
import { resolveHarnessPackage } from "../harness/package-registry";
import type { ConfigObject } from "../security/credential-filter";

type RuntimeModule = {
  readonly DEFAULT_OPENCLAW_MAX_TOKENS: number;
  readOpenClawPrimaryReplyBudget(config: ConfigObject): number | undefined;
  applyOpenClawAnthropicReplyBudget(modelConfig: ConfigObject, inheritedReplyBudget?: number): void;
};

function loadOpenClawReplyBudgetModule(): RuntimeModule {
  const harnessPackage = resolveHarnessPackage("openclaw");
  if (!harnessPackage) throw new Error("OpenClaw harness package is unavailable.");
  const loaded = loadHarnessCommonJsModule(harnessPackage, "scripts/reply-budget.cts", 64 * 1024);
  const runtime = loaded.exports as Partial<RuntimeModule>;
  if (
    typeof runtime.DEFAULT_OPENCLAW_MAX_TOKENS !== "number" ||
    !Number.isSafeInteger(runtime.DEFAULT_OPENCLAW_MAX_TOKENS) ||
    runtime.DEFAULT_OPENCLAW_MAX_TOKENS <= 0 ||
    typeof runtime.readOpenClawPrimaryReplyBudget !== "function" ||
    typeof runtime.applyOpenClawAnthropicReplyBudget !== "function"
  ) {
    throw new Error("OpenClaw harness reply-budget module has an invalid contract.");
  }
  return runtime as RuntimeModule;
}

export function readOpenClawPrimaryReplyBudget(config: ConfigObject): number | undefined {
  return loadOpenClawReplyBudgetModule().readOpenClawPrimaryReplyBudget(config);
}

export function applyOpenClawAnthropicReplyBudget(
  modelConfig: ConfigObject,
  inheritedReplyBudget?: number,
): void {
  loadOpenClawReplyBudgetModule().applyOpenClawAnthropicReplyBudget(
    modelConfig,
    inheritedReplyBudget,
  );
}
