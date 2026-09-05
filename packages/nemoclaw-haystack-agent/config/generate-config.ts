// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Generate the credential-free Fabric projection for the local Haystack POC.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SUPPORTED_INFERENCE_API = "openai-completions";
const MANAGED_BASE_URL = "https://inference.local/v1";
const FABRIC_ADAPTER_PATH = "/usr/local/share/nemoclaw/haystack-agent.fabric-adapter.json";
const FABRIC_ARTIFACTS_PATH = "/sandbox/.haystack-agent/fabric-artifacts";
const FABRIC_API_KEY_ENV = "HAYSTACK_FABRIC_API_KEY";
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_MAX_AGENT_STEPS = 8;
const MAX_AGENT_STEPS = 32;

function normalizeText(value: string | undefined, name: string): string {
  const text = (value ?? "").trim();
  if (!text) throw new Error(`${name} is required.`);
  if (/[\p{Cc}\p{Cf}]/u.test(text)) {
    throw new Error(`${name} must not contain control characters.`);
  }
  return text;
}

function normalizeInferenceApi(value: string | undefined): string {
  const api = normalizeText(value ?? SUPPORTED_INFERENCE_API, "NEMOCLAW_INFERENCE_API");
  if (api !== SUPPORTED_INFERENCE_API) {
    throw new Error(
      `NEMOCLAW_INFERENCE_API must be ${SUPPORTED_INFERENCE_API} for Haystack Agent.`,
    );
  }
  return api;
}

function normalizeBaseUrl(value: string | undefined): string {
  const baseUrl = normalizeText(value ?? MANAGED_BASE_URL, "NEMOCLAW_INFERENCE_BASE_URL");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("NEMOCLAW_INFERENCE_BASE_URL must be a valid URL.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("NEMOCLAW_INFERENCE_BASE_URL must not include credentials.");
  }
  if (baseUrl !== MANAGED_BASE_URL) {
    throw new Error(`NEMOCLAW_INFERENCE_BASE_URL must be ${MANAGED_BASE_URL}.`);
  }
  return baseUrl;
}

function normalizeTemperature(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_TEMPERATURE;
  const temperature = Number(value);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new Error("NEMOCLAW_TEMPERATURE must be a number between 0 and 2.");
  }
  return temperature;
}

function normalizeMaxSteps(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_MAX_AGENT_STEPS;
  if (!/^\d+$/u.test(value.trim())) {
    throw new Error(`NEMOCLAW_MAX_TURNS must be an integer between 1 and ${MAX_AGENT_STEPS}.`);
  }
  const maxSteps = Number(value);
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > MAX_AGENT_STEPS) {
    throw new Error(`NEMOCLAW_MAX_TURNS must be an integer between 1 and ${MAX_AGENT_STEPS}.`);
  }
  return maxSteps;
}

function buildFabricConfig(env: NodeJS.ProcessEnv): Readonly<Record<string, unknown>> {
  const model = normalizeText(env.NEMOCLAW_MODEL, "NEMOCLAW_MODEL");
  const baseUrl = normalizeBaseUrl(env.NEMOCLAW_INFERENCE_BASE_URL);
  normalizeInferenceApi(env.NEMOCLAW_INFERENCE_API);
  const systemInstruction = normalizeText(
    env.NEMOCLAW_SYSTEM_INSTRUCTION ??
      "Answer the user's request directly. Do not claim tools or durable memory.",
    "NEMOCLAW_SYSTEM_INSTRUCTION",
  );
  return {
    schema_version: "fabric.agent/v1alpha1",
    metadata: {
      name: "nemoclaw-haystack-agent",
      description: "NemoClaw local Haystack Agent POC",
    },
    harness: {
      adapter_id: "nvidia.nemoclaw.haystack-agent",
      resolution: "preinstalled",
    },
    discovery: {
      local_paths: [FABRIC_ADAPTER_PATH],
    },
    instructions: {
      system: { content: systemInstruction, mode: "replace" },
    },
    runtime: {
      input_schema: "text",
      output_schema: "message",
      artifacts: FABRIC_ARTIFACTS_PATH,
      timeout_seconds: 90,
      max_turns: normalizeMaxSteps(env.NEMOCLAW_MAX_TURNS),
    },
    environment: {
      provider: "local",
      workspace: "/sandbox",
      artifacts: FABRIC_ARTIFACTS_PATH,
      ownership: "caller_owned",
      control_location: "in_env_control",
    },
    models: {
      default: {
        provider: "openshell",
        model,
        api_key_env: FABRIC_API_KEY_ENV,
        temperature: normalizeTemperature(env.NEMOCLAW_TEMPERATURE),
        base_url: baseUrl,
      },
    },
  };
}

function main(): void {
  const configDirectory = join(homedir(), ".haystack-agent");
  const configPath = join(configDirectory, "fabric.json");
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(configPath, `${JSON.stringify(buildFabricConfig(process.env), null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(configPath, 0o600);
  console.log(`[config] Wrote ${configPath}.`);
}

main();
