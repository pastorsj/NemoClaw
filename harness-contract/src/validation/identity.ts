// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  DISPLAY_CONTROL_PATTERN,
  fail,
  type ManifestRecord,
  requireCanonicalId,
  requireKnownFields,
  requireRecord,
  requireString,
  utf8ByteLength,
} from "./shared.js";

const OPTIONAL_STRING_FIELDS = [
  "alias_summary",
  "binary_path",
  "expected_version",
  "gateway_command",
  "homepage",
  "install_method",
  "language",
  "license",
  "version_command",
  "version_constraint",
] as const;

function validateRootMetadata(manifest: ManifestRecord): void {
  for (const field of OPTIONAL_STRING_FIELDS) {
    if (manifest[field] !== undefined && typeof manifest[field] !== "string") {
      fail(field, "must be a string");
    }
  }
  if (
    manifest.version_scheme !== undefined &&
    manifest.version_scheme !== "semver" &&
    manifest.version_scheme !== "calendar"
  ) {
    fail("version_scheme", "must be semver or calendar");
  }
  if (manifest.device_pairing !== undefined && typeof manifest.device_pairing !== "boolean") {
    fail("device_pairing", "must be a boolean");
  }
  if (
    manifest.web_auth_method !== undefined &&
    manifest.web_auth_method !== "device_pairing" &&
    manifest.web_auth_method !== "bearer_token" &&
    manifest.web_auth_method !== "none"
  ) {
    fail("web_auth_method", "must be device_pairing, bearer_token, or none");
  }
  if (manifest.phone_home_hosts !== undefined) {
    if (
      !Array.isArray(manifest.phone_home_hosts) ||
      manifest.phone_home_hosts.some((host) => typeof host !== "string")
    ) {
      fail("phone_home_hosts", "must be an array of strings");
    }
  }
}

function validateOnboarding(manifest: ManifestRecord): void {
  if (manifest.onboarding === undefined) return;
  const onboarding = requireRecord(manifest.onboarding, "onboarding");
  requireKnownFields(onboarding, new Set(["default", "sandbox_name"]), new Set(), "onboarding");
  if (onboarding.default !== undefined && typeof onboarding.default !== "boolean") {
    fail("onboarding.default", "must be a boolean");
  }
  if (onboarding.sandbox_name !== undefined) {
    requireCanonicalId(onboarding.sandbox_name, "onboarding.sandbox_name");
  }
}

function validatePackageRegistry(manifest: ManifestRecord): void {
  if (manifest.package_registry === undefined) return;
  const registry = requireRecord(manifest.package_registry, "package_registry");
  requireKnownFields(
    registry,
    new Set(["binary", "hosts"]),
    new Set(["binary", "hosts"]),
    "package_registry",
  );
  requireString(registry.binary, "package_registry.binary");
  if (!Array.isArray(registry.hosts) || registry.hosts.some((host) => typeof host !== "string")) {
    fail("package_registry.hosts", "must be an array of strings");
  }
}

function validateDisplayText(
  manifest: ManifestRecord,
  field: "description" | "display_name",
  maximumCharacters: number,
  maximumBytes: number,
): void {
  const value = manifest[field];
  if (value === undefined) return;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Array.from(value).length > maximumCharacters ||
    utf8ByteLength(value) > maximumBytes ||
    DISPLAY_CONTROL_PATTERN.test(value)
  ) {
    fail(field, "must be bounded terminal-safe text");
  }
}

/** Validate package identity, aliases, and onboarding defaults. */
export function validateHarnessIdentity(
  manifest: ManifestRecord,
  expectedHarnessId?: string,
): void {
  const name = requireCanonicalId(manifest.name, "name");
  if (expectedHarnessId !== undefined && name !== expectedHarnessId) {
    fail("name", "must match the package harness id");
  }
  validateDisplayText(manifest, "display_name", 128, 512);
  validateDisplayText(manifest, "description", 2048, 8192);

  const aliases = manifest.aliases;
  if (aliases !== undefined) {
    if (!Array.isArray(aliases) || aliases.length > 64) {
      fail("aliases", "must contain at most 64 canonical identifiers");
    }
    const seen = new Set<string>();
    aliases.forEach((entry, index) => {
      const alias = requireCanonicalId(entry, `aliases[${String(index)}]`);
      if (alias === name || seen.has(alias)) {
        fail(`aliases[${String(index)}]`, "must be unique and differ from name");
      }
      seen.add(alias);
    });
  }
  validateRootMetadata(manifest);
  validateOnboarding(manifest);
  validatePackageRegistry(manifest);
}
