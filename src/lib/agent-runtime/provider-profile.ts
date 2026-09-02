// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { REPOSITORY_ROOT } from "../core/repository-root";
import {
  listActiveHarnessPackageIds,
  readInstalledHarnessPackage,
  type HarnessPackageStoreOptions,
} from "./package/store";

const PROVIDER_PROFILE_TYPE_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;

export interface CredentialProviderProfile {
  readonly profileType: string;
  readonly profilePath: string;
}

export interface CredentialProviderProfileOptions extends HarnessPackageStoreOptions {
  readonly coreRoot?: string;
}

function regularProfilePath(candidate: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Credential provider profile could not be inspected", { cause: error });
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Credential provider profile must be one regular file");
  }
  return candidate;
}

function storeOptions(options: CredentialProviderProfileOptions): HarnessPackageStoreOptions {
  return options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot };
}

/** Resolve an installed package profile before falling back to a core profile. */
export function resolveCredentialProviderProfile(
  type: string,
  options: CredentialProviderProfileOptions = {},
): CredentialProviderProfile | null {
  const profileType = type.toLowerCase();
  if (!PROVIDER_PROFILE_TYPE_PATTERN.test(profileType)) {
    throw new Error("Credential provider profile type is invalid");
  }

  const selectedStore = storeOptions(options);
  const packageProfiles: string[] = [];
  for (const id of listActiveHarnessPackageIds(selectedStore)) {
    const installed = readInstalledHarnessPackage(id, selectedStore);
    if (installed === null) {
      throw new Error("Installed harness package index changed during profile resolution");
    }
    const profilePath = regularProfilePath(
      path.join(
        path.dirname(installed.packageManifest.manifestPath),
        "provider-profiles",
        `${profileType}.yaml`,
      ),
    );
    if (profilePath) packageProfiles.push(profilePath);
  }

  if (packageProfiles.length > 1) {
    throw new Error(
      `Credential provider profile '${profileType}' is declared by multiple installed harness packages`,
    );
  }
  const packageProfile = packageProfiles[0];
  if (packageProfile) return Object.freeze({ profileType, profilePath: packageProfile });

  const coreProfile = regularProfilePath(
    path.join(
      path.resolve(options.coreRoot ?? REPOSITORY_ROOT),
      "nemoclaw-blueprint",
      "provider-profiles",
      `${profileType}.yaml`,
    ),
  );
  return coreProfile ? Object.freeze({ profileType, profilePath: coreProfile }) : null;
}
