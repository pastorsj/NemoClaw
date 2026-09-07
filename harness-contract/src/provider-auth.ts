// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** One API-key method whose secret is collected and held by NemoClaw core. */
export interface HarnessProviderApiKeyAuthMethod {
  readonly id: string;
  readonly label: string;
  readonly kind: "api-key";
  readonly credential_env: string;
  readonly source_env: string;
  readonly prompt_label: string;
}

/** Standard OAuth device-code settings consumed by NemoClaw's bounded core flow. */
export interface HarnessProviderDeviceCodeDeclaration {
  readonly portal_base_url: `https://${string}`;
  readonly client_id: string;
  readonly scope: string;
  readonly minimum_credential_ttl_seconds: number;
}

/** One OAuth method that mints an ephemeral inference credential. */
export interface HarnessProviderDeviceCodeAuthMethod {
  readonly id: string;
  readonly label: string;
  readonly kind: "oauth-device-code";
  readonly credential_env: string;
  readonly device_code: HarnessProviderDeviceCodeDeclaration;
}

export type HarnessProviderAuthMethod =
  | HarnessProviderApiKeyAuthMethod
  | HarnessProviderDeviceCodeAuthMethod;

/** The single package-owned provider entry added to NemoClaw's provider picker. */
export interface HarnessProviderSelectionDeclaration {
  readonly key: string;
  readonly aliases: readonly string[];
  readonly label: string;
  readonly provider_name: string;
  readonly provider_type: "openai";
  readonly endpoint_url: `https://${string}`;
  readonly help_url: `https://${string}`;
  readonly default_model: string;
  readonly models: readonly string[];
  readonly preferred_inference_api: "openai-completions";
}

/** A receipt-bound provider/authentication integration owned by one harness package. */
export type HarnessProviderAuthCapability =
  | {
      readonly support: "managed";
      readonly adapter: "provider-auth";
      readonly operation: "resolve-auth-method";
      readonly selection: HarnessProviderSelectionDeclaration;
      readonly request_environment: readonly string[];
      readonly default_method: string;
      readonly methods: readonly HarnessProviderAuthMethod[];
      readonly reason?: never;
    }
  | {
      readonly support: "disabled";
      readonly reason: string;
    };

/** Secret-free inputs available to a package's isolated auth-method resolver. */
export interface HarnessProviderAuthPlanRequest {
  readonly requestedMethod: string | null;
  readonly availableCredentialEnvs: readonly string[];
}

export type HarnessProviderAuthPlan =
  | { readonly kind: "unsupported"; readonly reason: string }
  | { readonly kind: "managed"; readonly methodId: string };

export interface HarnessProviderAuthAdapterModule {
  resolveProviderAuthMethod(request: HarnessProviderAuthPlanRequest): HarnessProviderAuthPlan;
}
