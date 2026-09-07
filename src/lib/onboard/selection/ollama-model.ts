// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { requireValue } from "../../core/require-value";
import { ollamaModelRefsMatch } from "../../inference/ollama/model-discovery";
import * as ollamaModelSize from "../../inference/ollama/model-size";
import { prepareOllamaModel, promptOllamaModel } from "../../inference/ollama/proxy";
import * as localInference from "../local-inference-topology";
import { OllamaProbeFailureTracker } from "../ollama-probe-failure-tracker";
import * as ollamaFlow from "../ollama-probe-failure";
import type { OllamaModelSelectionDefaults } from "../setup-nim-selection";

type OllamaGpu = ReturnType<typeof import("../../inference/nim").detectGpu>;
type ValidateOpenAiLikeSelection = ReturnType<
  typeof import("../inference-selection-validation").createInferenceSelectionValidationHelpers
>["validateOpenAiLikeSelection"];

export interface OllamaModelSelectionDependencies {
  readonly abortNonInteractive: (message: string) => never;
  readonly isAutoYes: () => boolean;
  readonly isBackToSelection: (value: unknown) => boolean;
  readonly isNonInteractive: () => boolean;
  readonly isSafeModelId: (model: string) => boolean;
  readonly note: (message: string) => void;
  readonly promptYesNoOrDefault: (
    question: string,
    envVar: string | null,
    defaultIsYes: boolean,
  ) => Promise<boolean>;
  readonly validateOpenAiLikeSelection: ValidateOpenAiLikeSelection;
}

/** Build the interactive Ollama model chooser used by the onboarding flow. */
export function createOllamaModelSelector(deps: OllamaModelSelectionDependencies) {
  return async function selectAndValidateOllamaModel(
    gpu: OllamaGpu,
    provider: string,
    defaults: OllamaModelSelectionDefaults,
    onModelSelected?: (model: string) => void,
  ): Promise<ollamaFlow.OllamaModelSelectionOutcome> {
    const { requestedModel, recoveredModel, lockedModel, promptDefaultModel } = defaults;
    const probeFailures = new OllamaProbeFailureTracker();
    const confirm = (question: string, defaultIsYes: boolean) =>
      deps.promptYesNoOrDefault(question, null, defaultIsYes);
    const interaction = {
      isNonInteractive: deps.isNonInteractive,
      isAutoYes: deps.isAutoYes,
      confirm,
    };

    while (true) {
      const installedModels = localInference.getOllamaModelOptions();
      let model: unknown;
      if (lockedModel) {
        model = lockedModel;
      } else if (deps.isNonInteractive()) {
        model = localInference.resolveNonInteractiveOllamaModel(
          requestedModel,
          recoveredModel,
          gpu,
          installedModels,
        );
      } else {
        model = await promptOllamaModel(gpu, {
          defaultModel: deps.isSafeModelId(promptDefaultModel ?? "") ? promptDefaultModel : null,
          excludeModels: probeFailures.excludedModels(),
          installedModels,
        });
      }
      if (deps.isBackToSelection(model)) {
        console.log("  Returning to provider selection.");
        console.log("");
        return { outcome: "back-to-selection" };
      }

      const selectedModel = requireValue(
        typeof model === "string" ? model : null,
        "Expected an Ollama model selection",
      );
      onModelSelected?.(selectedModel);
      if (
        !installedModels.some((listedModel) => ollamaModelRefsMatch(listedModel, selectedModel))
      ) {
        const sizeLabel = ollamaModelSize.formatModelSize(
          ollamaModelSize.getOllamaModelSize(selectedModel),
        );
        if (deps.isAutoYes()) {
          deps.note(`  Pulling Ollama model '${selectedModel}' (${sizeLabel}).`);
        } else if (deps.isNonInteractive()) {
          console.error(
            `  Ollama model '${selectedModel}' (${sizeLabel}) is not installed and ` +
              "non-interactive mode cannot prompt for confirmation. " +
              "Re-run with --yes / -y (or NEMOCLAW_YES=1) to authorise the download.",
          );
          process.exit(1);
        } else {
          const proceed = await deps.promptYesNoOrDefault(
            `  Download Ollama model '${selectedModel}' (${sizeLabel})?`,
            null,
            false,
          );
          if (!proceed) {
            console.error(
              `  Skipped pulling Ollama model '${selectedModel}'. Choose another model or re-run with --yes to confirm.`,
            );
            console.log("  Choose a different Ollama model or select Other.");
            console.log("");
            continue;
          }
        }
      }

      const probe = await prepareOllamaModel(selectedModel, installedModels, interaction);
      if (!probe.ok) {
        const probeFailureLimitReached = probeFailures.recordFailure(selectedModel);
        const action = ollamaFlow.handleOllamaProbeFailure(
          probe,
          selectedModel,
          deps.isNonInteractive,
        );
        if (action === "back-to-selection") return { outcome: "back-to-selection" };
        if (probeFailureLimitReached) {
          console.error(probeFailures.formatLimitMessage(selectedModel));
          return { outcome: "back-to-selection" };
        }
        continue;
      }

      const allowToolsIncompatible = probe.allowToolsIncompatible === true;
      const validationBaseUrl = localInference.getLocalProviderValidationBaseUrl(provider);
      if (!validationBaseUrl) {
        deps.abortNonInteractive("Local Ollama validation URL could not be determined.");
      }
      const validation = await deps.validateOpenAiLikeSelection(
        "Local Ollama",
        validationBaseUrl,
        selectedModel,
        null,
        "Choose a different Ollama model or select Other.",
        null,
        localInference.buildOllamaProbeOptions(allowToolsIncompatible),
      );
      if (validation.retry === "selection") return { outcome: "back-to-selection" };
      if (!validation.ok) {
        if (deps.isNonInteractive()) {
          deps.abortNonInteractive(`model '${selectedModel}' failed validation.`);
        }
        continue;
      }
      if (validation.api !== "openai-completions") {
        console.log(
          "  ℹ Using chat completions API (Ollama tool calls require /v1/chat/completions)",
        );
      }
      return ollamaFlow.completeOllamaRuntimeContextSelection(
        localInference.applyOllamaRuntimeContextWindow(selectedModel, defaults),
        { outcome: "selected", model: selectedModel, allowToolsIncompatible },
        deps.isNonInteractive,
      );
    }
  };
}
