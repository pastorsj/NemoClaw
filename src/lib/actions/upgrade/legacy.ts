// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxEntry } from "../../state/registry/types";

/**
 * Admit the installer handoff for pre-package managed images only.
 *
 * The installer has separately confirmed the sandbox name. This predicate also
 * requires an absent harness-package receipt before decoding the two historical
 * repository agent identities; a receipt-backed package can never gain this
 * compatibility authority.
 */
export function isConfirmedLegacyManagedUpgradeSandbox(sandbox: SandboxEntry): boolean {
  return (
    sandbox.harnessPackage == null &&
    (sandbox.agent == null || sandbox.agent === "openclaw" || sandbox.agent === "hermes")
  );
}
