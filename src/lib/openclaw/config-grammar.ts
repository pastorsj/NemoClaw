// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadHarnessCommonJsModule, resolveHarnessPackage } from "../harness/commonjs-runtime";
import type { SandboxInferenceConfig } from "../inference/config";
import type { ReasoningEffortRequest } from "../inference/selection";
import type { ConfigObject } from "../security/credential-filter";

type ReplyBudgetRuntime = {
  readonly DEFAULT_OPENCLAW_MAX_TOKENS: number;
  readOpenClawPrimaryReplyBudget(config: ConfigObject): number | undefined;
  applyOpenClawAnthropicReplyBudget(modelConfig: ConfigObject, inheritedReplyBudget?: number): void;
};

type ConfigGrammarRuntime = ReplyBudgetRuntime & {
  patchOpenClawInferenceConfig(
    config: ConfigObject,
    provider: string,
    model: string,
    route: SandboxInferenceConfig,
    contextWindow?: number,
    upstreamProviderMarker?: string,
    reasoningEffort?: ReasoningEffortRequest,
  ): boolean;
  readOpenClawPrimaryModelRef(config: unknown): unknown;
  readOpenClawPrimaryProviderKey(config: unknown): unknown;
  readOpenClawProviderApi(config: unknown, providerKey: string): unknown;
};

let cachedRuntime: {
  selectionKey: string;
  packageRoot: string;
  module: ReplyBudgetRuntime;
} | null = null;

function loadOpenClawReplyBudgetRuntime(): ReplyBudgetRuntime {
  const selectionKey = process.env.HOME?.trim() || "<default-home>";
  // A command captures verified helper bytes once. Harness installation takes effect in the next process.
  if (cachedRuntime?.selectionKey === selectionKey) return cachedRuntime.module;
  const harnessPackage = resolveHarnessPackage("openclaw");
  if (!harnessPackage) throw new Error("OpenClaw harness package is unavailable.");
  const loaded = loadHarnessCommonJsModule(harnessPackage, "host/config-runtime.cts", 128 * 1024);
  const runtime = loaded.exports as Partial<ReplyBudgetRuntime>;
  if (
    typeof runtime.DEFAULT_OPENCLAW_MAX_TOKENS !== "number" ||
    !Number.isSafeInteger(runtime.DEFAULT_OPENCLAW_MAX_TOKENS) ||
    runtime.DEFAULT_OPENCLAW_MAX_TOKENS <= 0 ||
    typeof runtime.readOpenClawPrimaryReplyBudget !== "function" ||
    typeof runtime.applyOpenClawAnthropicReplyBudget !== "function"
  ) {
    throw new Error("OpenClaw harness reply-budget module has an invalid contract.");
  }
  cachedRuntime = {
    selectionKey,
    packageRoot: harnessPackage.rootDir,
    module: runtime as ReplyBudgetRuntime,
  };
  return cachedRuntime.module;
}

function loadOpenClawConfigGrammarRuntime(): ConfigGrammarRuntime {
  const runtime = loadOpenClawReplyBudgetRuntime() as Partial<ConfigGrammarRuntime>;
  if (
    typeof runtime.patchOpenClawInferenceConfig !== "function" ||
    typeof runtime.readOpenClawPrimaryModelRef !== "function" ||
    typeof runtime.readOpenClawPrimaryProviderKey !== "function" ||
    typeof runtime.readOpenClawProviderApi !== "function"
  ) {
    throw new Error("OpenClaw harness config-grammar module has an invalid contract.");
  }
  return runtime as ConfigGrammarRuntime;
}

export function openClawDefaultReplyBudget(): number {
  return loadOpenClawReplyBudgetRuntime().DEFAULT_OPENCLAW_MAX_TOKENS;
}

export function readOpenClawPrimaryReplyBudget(config: ConfigObject): number | undefined {
  return loadOpenClawReplyBudgetRuntime().readOpenClawPrimaryReplyBudget(config);
}

export function applyOpenClawAnthropicReplyBudget(
  modelConfig: ConfigObject,
  inheritedReplyBudget?: number,
): void {
  loadOpenClawReplyBudgetRuntime().applyOpenClawAnthropicReplyBudget(
    modelConfig,
    inheritedReplyBudget,
  );
}

export function patchOpenClawInferenceConfigGrammar(
  config: ConfigObject,
  provider: string,
  model: string,
  route: SandboxInferenceConfig,
  contextWindow?: number,
  upstreamProviderMarker?: string,
  reasoningEffort?: ReasoningEffortRequest,
): boolean {
  return loadOpenClawConfigGrammarRuntime().patchOpenClawInferenceConfig(
    config,
    provider,
    model,
    route,
    contextWindow,
    upstreamProviderMarker,
    reasoningEffort,
  );
}

function optionalPackageString(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 4096 || value.includes("\0")) {
    throw new Error(`OpenClaw harness config-grammar module returned an invalid ${label}.`);
  }
  return value;
}

export function readOpenClawPrimaryModelRefGrammar(config: unknown): string | null {
  return optionalPackageString(
    loadOpenClawConfigGrammarRuntime().readOpenClawPrimaryModelRef(config),
    "primary model reference",
  );
}

export function readOpenClawPrimaryProviderKeyGrammar(config: unknown): string | null {
  return optionalPackageString(
    loadOpenClawConfigGrammarRuntime().readOpenClawPrimaryProviderKey(config),
    "primary provider key",
  );
}

export function readOpenClawProviderApiGrammar(
  config: unknown,
  providerKey: string,
): string | null {
  return optionalPackageString(
    loadOpenClawConfigGrammarRuntime().readOpenClawProviderApi(config, providerKey),
    "provider API",
  );
}
