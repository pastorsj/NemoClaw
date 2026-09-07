// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Messaging-specific compatibility decisions consumed by policy orchestration. */
import { createBuiltInChannelManifestRegistry } from "../messaging/channels/built-ins";
import { listMessagingChannelsForSandboxAuthority } from "../messaging/profile-authority";
import type { SandboxEntry } from "../state/registry/types";

export function listSandboxPolicyMessagingManifests(entry: SandboxEntry) {
  return listMessagingChannelsForSandboxAuthority(entry, createBuiltInChannelManifestRegistry());
}

export {
  legacyUsesNpmPolicyCompatibility,
  legacyUsesTeamsOutlookSharedLogin,
} from "../messaging/legacy-package";
export { reconcileTeamsOutlookLoginCredentialBinding } from "./microsoft-login-credential-binding";
