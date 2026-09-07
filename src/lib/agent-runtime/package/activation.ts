// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { qualifyHarnessPackageAdapterInitialization } from "../adapter/qualification";
import {
  activateStoredHarnessPackage,
  type HarnessPackagePointerMutationOptions,
  type InstalledHarnessPackage,
} from "./store";

/**
 * Activate a retained package only after its fixed adapters initialize in the bounded VM.
 * The package store keeps the old pointer unchanged when qualification fails.
 */
export function activateHarnessPackage(
  id: unknown,
  digest: unknown,
  options: HarnessPackagePointerMutationOptions = {},
): InstalledHarnessPackage {
  return activateStoredHarnessPackage(
    id,
    digest,
    (installed) =>
      qualifyHarnessPackageAdapterInitialization(
        installed.identity,
        installed.packageManifest.manifest,
        options,
      ),
    options,
  );
}
