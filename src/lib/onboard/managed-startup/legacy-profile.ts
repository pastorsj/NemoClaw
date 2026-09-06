// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxInferenceConfig } from "../../inference/config";
import { resolveCorporateCa } from "../corporate-ca";
import {
  buildManagedStartupOnboardProfile,
  type BuiltManagedStartupOnboardProfile,
  type ManagedStartupOnboardProfileInput,
} from "./onboard-profile";

type LegacyStartupProfileInput = Omit<
  ManagedStartupOnboardProfileInput,
  "agentName" | "corporateCa" | "inference"
>;

export interface BuildLegacyManagedStartupProfileInput {
  readonly agentName: string;
  readonly selectedModel: string;
  readonly selectedProvider: string | null;
  readonly preferredInferenceApi: string | null;
  readonly endpointUrl: string | null;
  readonly startupProfile: LegacyStartupProfileInput;
  readonly resolveAgentInferenceApi: typeof import("../../inference/config").resolveAgentInferenceApi;
  readonly getSandboxInferenceConfig: typeof import("../../inference/config").getSandboxInferenceConfig;
}

/**
 * Decode the pre-package managed-image startup shapes.
 *
 * The caller must prove that no harness-package receipt exists before entering
 * this compatibility boundary. Receipt-backed packages prepare the same public
 * startup state through their typed startup adapter instead.
 */
export function buildLegacyManagedStartupProfile(
  input: BuildLegacyManagedStartupProfileInput,
): BuiltManagedStartupOnboardProfile {
  const inferenceApi =
    input.agentName === "langchain-deepagents-code"
      ? "openai-completions"
      : input.resolveAgentInferenceApi(
          input.agentName,
          input.selectedProvider,
          input.preferredInferenceApi,
        );
  const inference: SandboxInferenceConfig = input.getSandboxInferenceConfig(
    input.selectedModel,
    input.selectedProvider,
    inferenceApi,
  );

  return buildManagedStartupOnboardProfile({
    agentName: input.agentName,
    inference: {
      routeProvider: inference.providerKey,
      upstreamProvider: input.selectedProvider ?? inference.providerKey,
      model: input.selectedModel,
      routedBaseUrl: inference.inferenceBaseUrl,
      upstreamEndpointUrl:
        input.agentName === "langchain-deepagents-code" ? input.endpointUrl : null,
      api: inference.inferenceApi as
        | "openai-completions"
        | "openai-responses"
        | "anthropic-messages",
      primaryModelRef: input.agentName === "openclaw" ? inference.primaryModelRef : null,
      compatibility: input.agentName === "openclaw" ? (inference.inferenceCompat ?? {}) : null,
    },
    ...input.startupProfile,
    corporateCa: resolveCorporateCa(input.startupProfile.environment),
  });
}
