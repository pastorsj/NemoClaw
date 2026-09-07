// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  packageDevicePairingIncompleteMessage,
  settlePackageDevicePairing,
} from "../../../onboard/sandbox-create/device-pairing";
import {
  readRegisteredSandboxAuthority,
  resolvePackageBackedSandboxAgent,
} from "../../../onboard/package/package-authority";

export type ConnectPackagePairingResult =
  | { readonly kind: "not-package" }
  | { readonly kind: "not-required" }
  | { readonly kind: "settled" }
  | { readonly kind: "incomplete"; readonly message: string };

interface ConnectPackagePairingDependencies {
  readonly getSandbox: typeof readRegisteredSandboxAuthority;
  readonly resolveAgent: typeof resolvePackageBackedSandboxAgent;
  readonly settlePairing: typeof settlePackageDevicePairing;
}

const DEFAULT_DEPENDENCIES: ConnectPackagePairingDependencies = {
  getSandbox: readRegisteredSandboxAuthority,
  resolveAgent: resolvePackageBackedSandboxAgent,
  settlePairing: settlePackageDevicePairing,
};

/** Settle one receipt-declared pairing operation without selecting a harness in core. */
export async function settleConnectPackagePairing(
  sandboxName: string,
  dependencies: ConnectPackagePairingDependencies = DEFAULT_DEPENDENCIES,
): Promise<ConnectPackagePairingResult> {
  const entry = dependencies.getSandbox(sandboxName);
  if (!entry?.harnessPackage && !entry?.harnessPackageMigration) {
    return { kind: "not-package" };
  }

  let resolved: ReturnType<typeof resolvePackageBackedSandboxAgent>;
  try {
    resolved = dependencies.resolveAgent(entry);
  } catch {
    return {
      kind: "incomplete",
      message: `Package onboarding for '${sandboxName}' is incomplete because its installed package authority is invalid. Resume or rerun onboarding.`,
    };
  }
  const declaration = resolved.definition.runtime?.device_pairing_settlement;
  if (!declaration) return { kind: "not-required" };

  const runtimeIdentity = resolved.definition.managedImage?.runtime_identity;
  const packageId = resolved.harnessPackage?.id;
  if (!runtimeIdentity || !packageId) {
    return {
      kind: "incomplete",
      message: `${resolved.definition.displayName} onboarding for '${sandboxName}' is incomplete because its pairing declaration has no package runtime identity. Resume or rerun onboarding.`,
    };
  }

  const result = await dependencies.settlePairing(
    sandboxName,
    packageId,
    declaration,
    runtimeIdentity,
  );
  return result.kind === "settled"
    ? { kind: "settled" }
    : {
        kind: "incomplete",
        message: packageDevicePairingIncompleteMessage(
          resolved.definition.displayName,
          sandboxName,
          result.reason,
        ),
      };
}
