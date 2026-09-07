// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Pre-receipt env targets retained only so old persisted plans can remove stale secrets. */
const LEGACY_MESSAGING_ENV_TARGETS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  hermes: ["~/.hermes/.env"],
});

export function listLegacyMessagingEnvTargets(agent: string): readonly string[] {
  return LEGACY_MESSAGING_ENV_TARGETS[agent] ?? [];
}
