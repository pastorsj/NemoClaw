// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type HarnessPolicyPresetActivation =
  | {
      /** Apply whenever the harness is selected. */
      readonly kind: "always";
    }
  | {
      /** Apply when NemoClaw's generic observability option is enabled. */
      readonly kind: "observability-enabled";
    }
  | {
      /** Apply when a package-defined environment flag enables one exact local endpoint. */
      readonly kind: "local-endpoint-enabled";
      readonly enabled_environment: string;
      readonly endpoint_environment: string;
      readonly default_endpoint: string;
      readonly local_origin: string;
    };

export interface HarnessAutomaticPolicyPreset {
  /** Package-owned preset selected by this rule. */
  readonly name: string;
  readonly activation: HarnessPolicyPresetActivation;
  /** Include the preset in the initial sandbox policy when the tier is already known. */
  readonly apply_during_create: boolean;
  /** Core policy tiers where the automatic addition is unsafe or redundant. */
  readonly suppress_in_tiers: readonly string[];
}

/** Package-owned policy assets and finite activation metadata consumed through an exact receipt. */
export interface HarnessPolicyCapability {
  /** Presets stored by convention at policies/presets/<name>.yaml in this package. */
  readonly owned_presets: readonly string[];
  /** Automatic package presets evaluated by core without a harness-name branch. */
  readonly automatic_presets: readonly HarnessAutomaticPolicyPreset[];
  /** Operator-facing impact of removing each excludable baseline policy entry. */
  readonly baseline_exclusion_impacts: Readonly<Record<string, string>>;
  /** Optional in-sandbox file that receives NemoClaw's rendered policy context. */
  readonly context_target?: `/sandbox/${string}`;
}
