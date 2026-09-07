// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** One package-owned managed tool exposed through the package's provider broker. */
export interface HarnessToolGatewayDeclaration {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly label: string;
  readonly description: string;
  readonly default_selected: boolean;
  /** Provider-auth method IDs that can authorize this gateway. */
  readonly authentication_methods: readonly string[];
  /** Package-owned policy presets core must add when this gateway is selected. */
  readonly policy_presets: readonly string[];
}

/** Finite package data used by NemoClaw's generic managed-tool selection workflow. */
export type HarnessToolGatewayCapability =
  | {
      readonly support: "managed";
      readonly selection_label: string;
      readonly selection_prompt: string;
      readonly request_environment: readonly string[];
      readonly incompatible_auth_message: string;
      readonly gateways: readonly HarnessToolGatewayDeclaration[];
      readonly reason?: never;
    }
  | {
      readonly support: "disabled";
      readonly reason: string;
    };
