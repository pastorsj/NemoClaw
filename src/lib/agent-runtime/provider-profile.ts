// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { HarnessWebSearchProviderBinding } from "@nvidia/nemoclaw-harness-contract";
import { assertHarnessWebSearchProviderProfile } from "@nvidia/nemoclaw-harness-contract/provider-profile";

import { REPOSITORY_ROOT } from "../core/repository-root";
import {
  listActiveHarnessPackageIds,
  readInstalledHarnessPackage,
  type HarnessPackageStoreOptions,
} from "./package/store";

const PROVIDER_PROFILE_TYPE_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;
const PROVIDER_PROFILE_MAX_BYTES = 256 * 1024;

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
  if (stat.size > PROVIDER_PROFILE_MAX_BYTES) {
    throw new Error("Credential provider profile exceeds its size boundary");
  }
  return candidate;
}

/** Prove the package's verification request and credential are contained by its provider profile. */
export function assertWebSearchVerificationMatchesProviderProfile(
  binding: HarnessWebSearchProviderBinding,
  profile: CredentialProviderProfile,
): void {
  let document: unknown;
  try {
    const parsed = YAML.parseDocument(fs.readFileSync(profile.profilePath, "utf8"), {
      prettyErrors: false,
      schema: "core",
      strict: true,
      uniqueKeys: true,
    });
    if (parsed.errors.length > 0 || parsed.warnings.length > 0) throw new Error("ambiguous YAML");
    document = parsed.toJS({ maxAliasCount: 0 }) as unknown;
  } catch (error) {
    throw new Error("Credential provider profile could not be parsed", { cause: error });
  }
  assertHarnessWebSearchProviderProfile(binding, profile.profileType, document);
}

function storeOptions(options: CredentialProviderProfileOptions): HarnessPackageStoreOptions {
  return options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot };
}

/** Resolve one profile from the exact package root selected by a receipt. */
export function resolvePackageCredentialProviderProfile(
  type: string,
  packageRoot: string,
): CredentialProviderProfile | null {
  const profileType = type.toLowerCase();
  if (profileType.length > 64 || !PROVIDER_PROFILE_TYPE_PATTERN.test(profileType)) {
    throw new Error("Credential provider profile type is invalid");
  }
  const resolvedPackageRoot = path.resolve(packageRoot);
  const profileDirectory = path.resolve(resolvedPackageRoot, "provider-profiles");
  let directoryStat: fs.Stats;
  try {
    directoryStat = fs.lstatSync(profileDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Credential provider profile directory could not be inspected", {
      cause: error,
    });
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error("Credential provider profile directory must be one ordinary directory");
  }
  const candidate = path.resolve(profileDirectory, `${profileType}.yaml`);
  const relative = path.relative(resolvedPackageRoot, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Credential provider profile escaped its package root");
  }
  const profilePath = regularProfilePath(candidate);
  return profilePath ? Object.freeze({ profileType, profilePath }) : null;
}

/** Resolve an installed package profile before falling back to a core profile. */
export function resolveCredentialProviderProfile(
  type: string,
  options: CredentialProviderProfileOptions = {},
): CredentialProviderProfile | null {
  const profileType = type.toLowerCase();
  if (profileType.length > 64 || !PROVIDER_PROFILE_TYPE_PATTERN.test(profileType)) {
    throw new Error("Credential provider profile type is invalid");
  }

  const selectedStore = storeOptions(options);
  const packageProfiles: string[] = [];
  for (const id of listActiveHarnessPackageIds(selectedStore)) {
    const installed = readInstalledHarnessPackage(id, selectedStore);
    if (installed === null) {
      throw new Error("Installed harness package index changed during profile resolution");
    }
    const profile = resolvePackageCredentialProviderProfile(
      profileType,
      path.dirname(installed.packageManifest.manifestPath),
    );
    if (profile) packageProfiles.push(profile.profilePath);
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
