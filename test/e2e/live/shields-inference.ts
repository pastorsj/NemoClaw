// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ArtifactSink } from "../fixtures/artifacts.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import {
  requireHostedInferenceConfig,
  type HostedInferenceSecrets,
} from "../fixtures/hosted-inference.ts";
import type { TestProgress } from "../fixtures/progress.ts";

const LOCAL_INFERENCE_API_KEY = "openclaw-shields-e2e-key";
const LOCAL_INFERENCE_MODEL = "openclaw-shields-e2e-model";

export interface ShieldsInference {
  readonly apiKey: string;
  readonly env: NodeJS.ProcessEnv;
}

interface ShieldsInferenceOptions {
  readonly artifacts: ArtifactSink;
  readonly cleanup: CleanupRegistry;
  readonly progress: TestProgress;
  readonly secrets: HostedInferenceSecrets;
}

/**
 * Keep the Shields lifecycle runnable without an external inference service.
 * CI and Brev retain their hosted route when they select it explicitly.
 */
export async function prepareShieldsInference({
  artifacts,
  cleanup,
  progress,
  secrets,
}: ShieldsInferenceOptions): Promise<ShieldsInference> {
  if (process.env.NEMOCLAW_E2E_USE_HOSTED_INFERENCE === "1") {
    return requireHostedInferenceConfig(secrets);
  }

  const fakeInference = await startFakeOpenAiCompatibleServer({
    apiKey: LOCAL_INFERENCE_API_KEY,
    chatContent: "PONG",
    host: "0.0.0.0",
    model: LOCAL_INFERENCE_MODEL,
    progress,
    publicHost: "host.openshell.internal",
    requireAuth: true,
    requireAuthModels: true,
  });
  cleanup.trackDisposable("close OpenClaw Shields inference fixture", async () => {
    try {
      await artifacts.writeJson(
        "openclaw-shields-inference-requests.json",
        fakeInference.requests(),
      );
    } finally {
      await fakeInference.close();
    }
  });

  return {
    apiKey: LOCAL_INFERENCE_API_KEY,
    env: {
      COMPATIBLE_API_KEY: LOCAL_INFERENCE_API_KEY,
      NVIDIA_INFERENCE_API_KEY: LOCAL_INFERENCE_API_KEY,
      NEMOCLAW_COMPAT_MODEL: LOCAL_INFERENCE_MODEL,
      NEMOCLAW_ENDPOINT_URL: fakeInference.baseUrl,
      NEMOCLAW_MODEL: LOCAL_INFERENCE_MODEL,
      NEMOCLAW_PREFERRED_API: "openai-completions",
      NEMOCLAW_PROVIDER: "custom",
      NEMOCLAW_SANDBOX_GPU: "0",
    },
  };
}
