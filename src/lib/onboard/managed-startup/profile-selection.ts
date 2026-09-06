// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The managed-workload workflow selects one of two startup-profile authorities:
 * an installed package adapter or the bounded pre-package compatibility path.
 * This module keeps that choice explicit without exposing either implementation
 * as another orchestration dependency.
 */
export {
  type BuiltManagedStartupOnboardProfile,
  type ManagedStartupOnboardProfileInput,
} from "./onboard-profile";
export { buildManagedStartupInferenceCandidates } from "./package-input";
export {
  type BuiltManagedStartupPackageProfile,
  type LoadHarnessStartupProfileAdapter,
  prepareInitialManagedStartupPackageProfile,
} from "./package-profile";
export { buildLegacyManagedStartupProfile } from "./legacy-profile";
