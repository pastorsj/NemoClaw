// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Messaging capability declarations and their host-side description boundary. */
export type HarnessMessagingCapability =
  | { readonly support: "channels"; readonly channels: readonly string[] }
  | { readonly support: "disabled"; readonly channels?: never };

export interface HarnessMessagingIntegrationRequest {
  readonly packageId: string;
}

export interface HarnessMessagingSupportedIntegration {
  readonly kind: "channels";
  readonly packageId: string;
  readonly channelIds: readonly string[];
}

export interface HarnessMessagingDisabledIntegration {
  readonly kind: "disabled";
  readonly packageId: string;
  readonly reason: string;
}

export type HarnessMessagingIntegration =
  | HarnessMessagingSupportedIntegration
  | HarnessMessagingDisabledIntegration;

export interface HarnessMessagingAdapterModule {
  readonly describeMessagingIntegration: (
    request: HarnessMessagingIntegrationRequest,
  ) => HarnessMessagingIntegration;
}
