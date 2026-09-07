// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";

import { readToolDisclosureEnv } from "./tool-disclosure.ts";

export type HermesWebSearchProvider = "tavily";

/** Minimum context window Hermes accepts for generated configuration. */
export const MIN_HERMES_CONTEXT_WINDOW = 64_000;

export type HermesBuildSettings = {
  model: string;
  baseUrl: string;
  providerKey: string;
  upstreamProvider: string;
  inferenceApi: string;
  /** Total context window (tokens); null lets Hermes auto-detect from /v1/models. */
  contextWindow: number | null;
  toolDisclosure: "progressive" | "direct";
  webSearchProvider: HermesWebSearchProvider | null;
  managedImageCapabilityUnion: boolean;
  managedToolGateways: {
    brokerEnabled: boolean;
    presets: string[];
  };
};

/** Read and validate the environment consumed by the Hermes config generator. */
export function readHermesBuildSettings(env: NodeJS.ProcessEnv): HermesBuildSettings {
  const model = readRequiredEnv(env, "NEMOCLAW_MODEL");
  const baseUrl = readRequiredEnv(env, "NEMOCLAW_INFERENCE_BASE_URL");

  return {
    model,
    baseUrl,
    providerKey: env.NEMOCLAW_INFERENCE_PROVIDER_ID || env.NEMOCLAW_PROVIDER_KEY || "custom",
    upstreamProvider:
      env.NEMOCLAW_UPSTREAM_PROVIDER ||
      env.NEMOCLAW_INFERENCE_PROVIDER_ID ||
      env.NEMOCLAW_PROVIDER_KEY ||
      "custom",
    inferenceApi: env.NEMOCLAW_INFERENCE_API || "",
    contextWindow: readContextWindow(env),
    toolDisclosure: readToolDisclosureEnv(env),
    webSearchProvider: readWebSearchProvider(env),
    managedImageCapabilityUnion: readBooleanBuildFlag(
      env,
      "NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION",
    ),
    managedToolGateways: {
      brokerEnabled: env.NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER === "1",
      presets: readBase64Json<string[]>(env, "NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64", "W10="),
    },
  };
}

function readBooleanBuildFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name] ?? "0";
  if (value !== "0" && value !== "1") {
    throw new Error(`${name} must be "0" or "1"`);
  }
  return value === "1";
}

/**
 * Parse `NEMOCLAW_CONTEXT_WINDOW` for Hermes config generation.
 *
 * Empty, absent, or malformed values return null so Hermes keeps auto-detecting
 * from the endpoint's `/v1/models`; explicit values below the Hermes floor fail
 * before writing an unusable config. See #6177.
 */
function readContextWindow(env: NodeJS.ProcessEnv): number | null {
  const raw = (env.NEMOCLAW_CONTEXT_WINDOW || "").trim();
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  if (parsed < MIN_HERMES_CONTEXT_WINDOW) {
    throw new Error(
      `Hermes NEMOCLAW_CONTEXT_WINDOW must be at least ${MIN_HERMES_CONTEXT_WINDOW} tokens, got ${parsed}`,
    );
  }
  return parsed;
}

function readWebSearchProvider(env: NodeJS.ProcessEnv): HermesWebSearchProvider | null {
  if (env.NEMOCLAW_WEB_SEARCH_ENABLED !== "1") return null;

  const provider = (env.NEMOCLAW_WEB_SEARCH_PROVIDER || "tavily").trim();
  if (provider === "tavily") return provider;
  throw new Error(
    `Hermes NEMOCLAW_WEB_SEARCH_PROVIDER must be "tavily", got ${JSON.stringify(provider)}`,
  );
}

function readRequiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readBase64Json<T>(env: NodeJS.ProcessEnv, name: string, defaultValue: string): T {
  const encoded = env[name] || defaultValue;
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf-8")) as T;
}
