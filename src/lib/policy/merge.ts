// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  parseOpenShellPolicy as parseCanonicalOpenShellPolicy,
  stripProviderComposedPolicies as stripCanonicalProviderComposedPolicies,
  withoutProviderComposedPolicies as withoutCanonicalProviderComposedPolicies,
} from "../shared/openshell-policy-boundary.cts";

import type { JsonObject } from "../core/json-types";

// sourceOfTruth: src/lib/shared/openshell-policy-boundary.cts
// Keep this file implementation-free.
export const parseOpenShellPolicy = parseCanonicalOpenShellPolicy;
export const stripProviderComposedPolicies = stripCanonicalProviderComposedPolicies;

export function withoutProviderComposedPolicies(policies: JsonObject): JsonObject {
  return withoutCanonicalProviderComposedPolicies(policies) as JsonObject;
}
