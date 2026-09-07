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
const SANDBOX_STARTUP_CONTROLS = new Set(["approval-mode", "observability"]);
const DOCKER_ULIMIT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;
const DOCKER_ULIMIT_MAX_VALUE = 1_000_000_000;

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

function validateStartupControls(value: unknown): void {
  const field = "sandbox_create.startup_controls";
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > SANDBOX_STARTUP_CONTROLS.size ||
    new Set(value).size !== value.length ||
    value.some((control) => !SANDBOX_STARTUP_CONTROLS.has(control as string))
  ) {
    fail(field, "must contain unique approval-mode or observability entries");
  }
}

function validateDockerUlimit(value: unknown, index: number): void {
  const field = `sandbox_create.docker_ulimits[${String(index)}]`;
  const limit = requireRecord(value, field);
  requireKnownFields(
    limit,
    new Set(["hard", "name", "soft"]),
    new Set(["hard", "name", "soft"]),
    field,
  );
  if (typeof limit.name !== "string" || !DOCKER_ULIMIT_NAME_PATTERN.test(limit.name)) {
    fail(`${field}.name`, "must be a bounded lowercase Docker ulimit name");
  }
  if (
    !Number.isSafeInteger(limit.soft) ||
    (limit.soft as number) < 0 ||
    (limit.soft as number) > DOCKER_ULIMIT_MAX_VALUE
  ) {
    fail(`${field}.soft`, "must be an integer from 0 through 1000000000");
  }
  if (
    !Number.isSafeInteger(limit.hard) ||
    (limit.hard as number) < (limit.soft as number) ||
    (limit.hard as number) > DOCKER_ULIMIT_MAX_VALUE
  ) {
    fail(`${field}.hard`, "must be an integer from soft through 1000000000");
  }
}

/** Validate finite package contributions to the sandbox-create operation. */
export function validateHarnessSandboxCreate(manifest: ManifestRecord): void {
  if (manifest.sandbox_create === undefined) return;
  const declaration = requireRecord(manifest.sandbox_create, "sandbox_create");
  requireKnownFields(
    declaration,
    new Set(["docker_ulimits", "driver_mounts", "generated_image_build", "startup_controls"]),
    new Set(),
    "sandbox_create",
  );
  if (
    declaration.generated_image_build !== undefined &&
    declaration.generated_image_build !== "local-buildkit-required"
  ) {
    fail("sandbox_create.generated_image_build", "must be local-buildkit-required when present");
  }
  if (declaration.startup_controls !== undefined) {
    validateStartupControls(declaration.startup_controls);
  }
  if (declaration.driver_mounts !== undefined) {
    if (
      !Array.isArray(declaration.driver_mounts) ||
      declaration.driver_mounts.length === 0 ||
      declaration.driver_mounts.length > 16
    ) {
      fail("sandbox_create.driver_mounts", "must contain 1 through 16 mounts");
    }
    declaration.driver_mounts.forEach(validateDriverMount);
  }
  if (declaration.docker_ulimits !== undefined) {
    if (
      !Array.isArray(declaration.docker_ulimits) ||
      declaration.docker_ulimits.length === 0 ||
      declaration.docker_ulimits.length > 16
    ) {
      fail("sandbox_create.docker_ulimits", "must contain 1 through 16 limits");
    }
    declaration.docker_ulimits.forEach(validateDockerUlimit);
    const names = declaration.docker_ulimits.map((entry) =>
      typeof entry === "object" && entry !== null ? (entry as { name?: unknown }).name : undefined,
    );
    if (new Set(names).size !== names.length) {
      fail("sandbox_create.docker_ulimits", "must not contain duplicate limit names");
    }
  }
}
