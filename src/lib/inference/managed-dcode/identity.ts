// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadHarnessCommonJsModule } from "../../harness/commonjs-runtime";
import { resolveHarnessPackage } from "../../harness/package-registry";

export type ManagedDcodeProvider = "openai" | "openrouter";

export type ManagedDcodeIdentity = {
  provider: ManagedDcodeProvider;
  model: string;
  defaultModel: string;
};

type RuntimeModule = {
  normalizeManagedDcodeEndpointUrl(value: string | null | undefined, name: string): string | null;
  normalizeManagedDcodeModelName(model: string): string;
  resolveManagedDcodeIdentity(
    upstreamProvider: string | null | undefined,
    model: string,
    upstreamEndpointUrl: string | null | undefined,
  ): ManagedDcodeIdentity;
};

let cachedRuntime: { packageRoot: string; module: RuntimeModule } | null = null;

function loadManagedDcodeIdentityModule(): RuntimeModule {
  const harnessPackage = resolveHarnessPackage("langchain-deepagents-code");
  if (!harnessPackage)
    throw new Error("LangChain Deep Agents Code harness package is unavailable.");
  if (cachedRuntime?.packageRoot === harnessPackage.rootDir) return cachedRuntime.module;
  const loaded = loadHarnessCommonJsModule(harnessPackage, "managed-identity.cts", 64 * 1024);
  const runtime = loaded.exports as Partial<RuntimeModule>;
  if (
    typeof runtime.normalizeManagedDcodeEndpointUrl !== "function" ||
    typeof runtime.normalizeManagedDcodeModelName !== "function" ||
    typeof runtime.resolveManagedDcodeIdentity !== "function"
  ) {
    throw new Error("LangChain Deep Agents Code managed-identity module has an invalid contract.");
  }
  cachedRuntime = { packageRoot: harnessPackage.rootDir, module: runtime as RuntimeModule };
  return cachedRuntime.module;
}

export function normalizeManagedDcodeEndpointUrl(
  value: string | null | undefined,
  name: string,
): string | null {
  return loadManagedDcodeIdentityModule().normalizeManagedDcodeEndpointUrl(value, name);
}

export function normalizeManagedDcodeModelName(model: string): string {
  return loadManagedDcodeIdentityModule().normalizeManagedDcodeModelName(model);
}

export function resolveManagedDcodeIdentity(
  upstreamProvider: string | null | undefined,
  model: string,
  upstreamEndpointUrl: string | null | undefined,
): ManagedDcodeIdentity {
  return loadManagedDcodeIdentityModule().resolveManagedDcodeIdentity(
    upstreamProvider,
    model,
    upstreamEndpointUrl,
  );
}
