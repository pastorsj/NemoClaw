// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Finite host-side provider-broker operations understood by NemoClaw core. */
export type HarnessProviderBrokerOperation =
  | "describe-provider"
  | "register-refresh-provider"
  | "ensure-broker";

export type HarnessProviderBrokerCapability =
  | {
      readonly support: "managed";
      readonly adapter: "provider-broker";
      readonly operations: readonly HarnessProviderBrokerOperation[];
    }
  | {
      readonly support: "disabled";
      readonly reason: string;
    };

export interface HarnessProviderBrokerPlanRequest {
  readonly operation: HarnessProviderBrokerOperation;
  readonly sandboxName: string;
}

export type HarnessProviderBrokerPlan =
  | { readonly kind: "unsupported"; readonly reason: string }
  | {
      readonly kind: "managed";
      readonly providerName: string;
    };

export interface HarnessProviderBrokerAdapterModule {
  buildProviderBrokerPlan(request: HarnessProviderBrokerPlanRequest): HarnessProviderBrokerPlan;
}

export type HarnessProviderBrokerControllerRequest =
  | {
      readonly operation: "register-refresh-provider";
      readonly sandboxName: string;
      readonly refreshToken: string;
    }
  | {
      readonly operation: "ensure-broker";
      readonly sandboxName: string;
      readonly refreshToken: string;
    };

export type HarnessProviderBrokerControllerResult =
  | {
      readonly ok: true;
      readonly providerName: string;
      readonly credentialEnv?: string;
      readonly credentialValue?: string;
    }
  | { readonly ok: false; readonly message: string };
