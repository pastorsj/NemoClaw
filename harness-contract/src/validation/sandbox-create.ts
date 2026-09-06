// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  fail,
  isCanonicalAbsolutePath,
  type ManifestRecord,
  requireKnownFields,
  requireRecord,
  SAFE_PATH_SEGMENT_PATTERN,
} from "./shared.js";

const SANDBOX_DRIVERS = new Set(["docker", "podman"]);

function validateDriverMount(value: unknown, index: number): void {
  const field = `sandbox_create.driver_mounts[${String(index)}]`;
  const mount = requireRecord(value, field);
  requireKnownFields(
    mount,
    new Set(["drivers", "mode", "options", "size_bytes", "target", "type"]),
    new Set(["drivers", "mode", "size_bytes", "target", "type"]),
    field,
  );
  if (mount.type !== "tmpfs") fail(`${field}.type`, "must be tmpfs");
  if (
    !Array.isArray(mount.drivers) ||
    mount.drivers.length === 0 ||
    mount.drivers.length > SANDBOX_DRIVERS.size ||
    new Set(mount.drivers).size !== mount.drivers.length ||
    mount.drivers.some((driver) => !SANDBOX_DRIVERS.has(driver as string))
  ) {
    fail(`${field}.drivers`, "must contain unique docker or podman entries");
  }
  if (
    typeof mount.target !== "string" ||
    !mount.target.startsWith("/run/") ||
    !isCanonicalAbsolutePath(mount.target) ||
    !mount.target
      .slice("/run/".length)
      .split("/")
      .every((part) => SAFE_PATH_SEGMENT_PATTERN.test(part))
  ) {
    fail(`${field}.target`, "must be a canonical path below /run");
  }
  if (
    !Array.isArray(mount.options) ||
    mount.options.length > 1 ||
    new Set(mount.options).size !== mount.options.length ||
    mount.options.some((option) => option !== "noexec")
  ) {
    fail(`${field}.options`, "must contain only the optional noexec entry");
  }
  if (
    !Number.isInteger(mount.size_bytes) ||
    (mount.size_bytes as number) < 4096 ||
    (mount.size_bytes as number) > 1024 * 1024 * 1024
  ) {
    fail(`${field}.size_bytes`, "must be an integer from 4096 through 1073741824");
  }
  if (
    !Number.isInteger(mount.mode) ||
    (mount.mode as number) < 0 ||
    (mount.mode as number) > 0o1777
  ) {
    fail(`${field}.mode`, "must be an integer from 0 through 1023");
  }
}

/** Validate finite package contributions to the sandbox-create operation. */
export function validateHarnessSandboxCreate(manifest: ManifestRecord): void {
  if (manifest.sandbox_create === undefined) return;
  const declaration = requireRecord(manifest.sandbox_create, "sandbox_create");
  requireKnownFields(
    declaration,
    new Set(["driver_mounts", "generated_image_build"]),
    new Set(),
    "sandbox_create",
  );
  if (
    declaration.generated_image_build !== undefined &&
    declaration.generated_image_build !== "local-buildkit-required"
  ) {
    fail("sandbox_create.generated_image_build", "must be local-buildkit-required when present");
  }
  if (declaration.driver_mounts === undefined) return;
  if (
    !Array.isArray(declaration.driver_mounts) ||
    declaration.driver_mounts.length === 0 ||
    declaration.driver_mounts.length > 16
  ) {
    fail("sandbox_create.driver_mounts", "must contain 1 through 16 mounts");
  }
  declaration.driver_mounts.forEach(validateDriverMount);
}
