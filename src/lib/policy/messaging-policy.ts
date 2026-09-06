// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Messaging-specific compatibility decisions consumed by policy orchestration. */
export {
  legacyUsesNpmPolicyCompatibility,
  legacyUsesTeamsOutlookSharedLogin,
} from "../messaging/legacy-package";
export { reconcileTeamsOutlookLoginCredentialBinding } from "./microsoft-login-credential-binding";
