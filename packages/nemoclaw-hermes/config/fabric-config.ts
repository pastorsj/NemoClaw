// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HermesBuildSettings } from "./build-env.ts";

const FABRIC_ARTIFACTS_PATH = "/sandbox/.hermes/fabric-artifacts";
const FABRIC_ADAPTER_PATH = "/usr/local/share/nemoclaw/hermes.fabric-adapter.json";

export type HermesFabricConfig = {
  schema_version: "fabric.agent/v1alpha1";
  metadata: {
    name: "nemoclaw-hermes";
    description: string;
  };
  harness: {
    adapter_id: "nvidia.nemoclaw.hermes";
    resolution: "preinstalled";
  };
  discovery: {
    local_paths: [typeof FABRIC_ADAPTER_PATH];
  };
  runtime: {
    input_schema: "chat";
    output_schema: "message";
    artifacts: typeof FABRIC_ARTIFACTS_PATH;
    timeout_seconds: 90;
  };
  environment: {
    provider: "local";
    workspace: "/sandbox";
    artifacts: typeof FABRIC_ARTIFACTS_PATH;
    ownership: "caller_owned";
    control_location: "in_env_control";
  };
  models: {
    default: {
      provider: "custom";
      model: string;
      api_key_env: "HERMES_FABRIC_API_KEY";
      base_url: string;
    };
  };
};

/** Project the managed inference route onto NemoClaw's released-adapter boundary. */
export function buildHermesFabricConfig(settings: HermesBuildSettings): HermesFabricConfig {
  return {
    schema_version: "fabric.agent/v1alpha1",
    metadata: {
      name: "nemoclaw-hermes",
      description: "NemoClaw-managed Hermes headless runtime",
    },
    harness: {
      adapter_id: "nvidia.nemoclaw.hermes",
      resolution: "preinstalled",
    },
    discovery: {
      local_paths: [FABRIC_ADAPTER_PATH],
    },
    runtime: {
      input_schema: "chat",
      output_schema: "message",
      artifacts: FABRIC_ARTIFACTS_PATH,
      timeout_seconds: 90,
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
        provider: "custom",
        model: settings.model,
        api_key_env: "HERMES_FABRIC_API_KEY",
        base_url: settings.baseUrl,
      },
    },
  };
}
