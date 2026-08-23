// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  loadHarnessCommonJsModule,
  resolveHarnessPackage,
} from "./harness/commonjs-runtime";

type HermesManagedProvider = {
  name: string;
  api_key: string;
  discover_models: true;
  api?: string;
  base_url?: string;
  default_model?: string;
  transport?: string;
  api_mode?: string;
};

export type HermesManagedRouting = {
  _nemoclaw_upstream: { provider: string; provider_key: string; model: string };
  model: {
    default: string;
    provider: "custom";
    base_url: string;
    api_key: string;
    api_mode?: string;
    context_length?: number;
  };
  providers: Record<string, HermesManagedProvider>;
  custom_providers: HermesManagedProvider[];
};

export type HermesManagedRoute = {
  model: string;
  baseUrl: string;
  upstreamProvider: string;
  inferenceApi: string;
  contextWindow?: number | null;
};

type RuntimeModule = {
  applyHermesManagedRoute(
    config: Record<string, unknown>,
    route: HermesManagedRoute,
  ): asserts config is Record<string, unknown> & HermesManagedRouting;
  buildHermesUpstreamHeader(config: Record<string, unknown>): string;
  hermesApiMode(inferenceApi: string): string | null;
  hermesProviderKey(provider: string): string;
};

let cachedRuntime: {
  selectionKey: string;
  packageRoot: string;
  module: RuntimeModule;
} | null = null;

function loadHermesManagedRouteModule(): RuntimeModule {
  const selectionKey = process.env.HOME?.trim() || "<default-home>";
  // A command captures verified helper bytes once. Harness installation takes effect in the next process.
  if (cachedRuntime?.selectionKey === selectionKey) return cachedRuntime.module;
  const harnessPackage = resolveHarnessPackage("hermes");
  if (!harnessPackage) throw new Error("Hermes harness package is unavailable.");
  const loaded = loadHarnessCommonJsModule(harnessPackage, "config/managed-route.cts", 64 * 1024);
  const runtime = loaded.exports as Partial<RuntimeModule>;
  if (
    typeof runtime.applyHermesManagedRoute !== "function" ||
    typeof runtime.buildHermesUpstreamHeader !== "function" ||
    typeof runtime.hermesApiMode !== "function" ||
    typeof runtime.hermesProviderKey !== "function"
  ) {
    throw new Error("Hermes harness managed-route module has an invalid contract.");
  }
  cachedRuntime = {
    selectionKey,
    packageRoot: harnessPackage.rootDir,
    module: runtime as RuntimeModule,
  };
  return cachedRuntime.module;
}

export function buildHermesUpstreamHeader(config: Record<string, unknown>): string {
  return loadHermesManagedRouteModule().buildHermesUpstreamHeader(config);
}

export function hermesApiMode(inferenceApi: string): string | null {
  return loadHermesManagedRouteModule().hermesApiMode(inferenceApi);
}

export function hermesProviderKey(provider: string): string {
  return loadHermesManagedRouteModule().hermesProviderKey(provider);
}

export function applyHermesManagedRoute(
  config: Record<string, unknown>,
  route: HermesManagedRoute,
): asserts config is Record<string, unknown> & HermesManagedRouting {
  const runtime: RuntimeModule = loadHermesManagedRouteModule();
  runtime.applyHermesManagedRoute(config, route);
}
