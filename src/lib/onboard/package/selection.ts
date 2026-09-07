// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Package-owned selections consumed by the top-level onboarding workflow. */
export { resolveHarnessProviderAuthCapability } from "../../agent-runtime/provider-auth";
export { createPackageSelectionQualificationReader } from "../selection/qualification";
export {
  requirePackageRemoteProviderConfig,
  resolvePackageRemoteProviderSelection,
  selectPackageProviderAuth,
  selectPackageProviderRuntime,
} from "./provider-auth-selection";
export { selectPackageToolGateways } from "./tool-gateway-selection";
