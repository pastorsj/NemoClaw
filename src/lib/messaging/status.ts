// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Messaging services needed to compose the package-agnostic status command. */
export { findAllOverlaps } from "./applier";
export { createBuiltInChannelManifestRegistry } from "./channels/built-ins";
export { createBuiltInMessagingHookRegistry } from "./hooks";
export { runMessagingStatusHooks, type MessagingStatusHookRunResult } from "./hooks/status-runner";
export { listLegacyMessagingChannels } from "./legacy-profile";
export type { ChannelManifest, MessagingAgentId } from "./manifest";
export {
  listMessagingChannelsForProfile,
  resolveSandboxMessagingProfileAuthority,
} from "./profile-authority";
export { hydrateMessagingRegistryEntriesForAuthority } from "../state/registry/messaging-authority";
