// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessSandboxCreateDeclaration,
  HarnessSandboxDockerUlimitDeclaration,
  HarnessSandboxDriver,
  HarnessSandboxStartupControl,
  HarnessSandboxTmpfsMountDeclaration,
} from "@nvidia/nemoclaw-harness-contract";

import { isObjectRecord } from "../core/json-types";
import type { ManifestRecord } from "./manifest-types";

const SANDBOX_DRIVERS = new Set<HarnessSandboxDriver>(["docker", "podman"]);
const SANDBOX_STARTUP_CONTROLS = new Set<HarnessSandboxStartupControl>([
  "approval-mode",
  "observability",
]);
const DOCKER_ULIMIT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/u;
const DOCKER_ULIMIT_MAX_VALUE = 1_000_000_000;

function readSandboxDriverMount(
  value: unknown,
  index: number,
): HarnessSandboxTmpfsMountDeclaration {
  const field = `sandbox_create.driver_mounts[${String(index)}]`;
  if (!isObjectRecord(value) || value.type !== "tmpfs") {
    throw new Error(`Agent manifest field '${field}.type' must be tmpfs`);
  }
  if (
    !Array.isArray(value.drivers) ||
    value.drivers.length === 0 ||
    value.drivers.length > SANDBOX_DRIVERS.size ||
    new Set(value.drivers).size !== value.drivers.length ||
    value.drivers.some((driver) => !SANDBOX_DRIVERS.has(driver as HarnessSandboxDriver))
  ) {
    throw new Error(`Agent manifest field '${field}.drivers' must contain docker or podman`);
  }
  if (
    typeof value.target !== "string" ||
    !/^\/run\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(value.target)
  ) {
    throw new Error(`Agent manifest field '${field}.target' must be a canonical path below /run`);
  }
  if (
    !Array.isArray(value.options) ||
    value.options.length > 1 ||
    new Set(value.options).size !== value.options.length ||
    value.options.some((option) => option !== "noexec")
  ) {
    throw new Error(`Agent manifest field '${field}.options' may contain only noexec`);
  }
  if (
    !Number.isInteger(value.size_bytes) ||
    (value.size_bytes as number) < 4096 ||
    (value.size_bytes as number) > 1024 * 1024 * 1024
  ) {
    throw new Error(`Agent manifest field '${field}.size_bytes' is outside its allowed range`);
  }
  if (
    !Number.isInteger(value.mode) ||
    (value.mode as number) < 0 ||
    (value.mode as number) > 0o1777
  ) {
    throw new Error(`Agent manifest field '${field}.mode' is outside its allowed range`);
  }
  return Object.freeze({
    type: "tmpfs",
    drivers: Object.freeze([...(value.drivers as HarnessSandboxDriver[])]),
    target: value.target as `/run/${string}`,
    options: Object.freeze([...(value.options as "noexec"[])]),
    size_bytes: value.size_bytes as number,
    mode: value.mode as number,
  });
}

function readSandboxStartupControls(
  value: unknown,
): readonly HarnessSandboxStartupControl[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > SANDBOX_STARTUP_CONTROLS.size ||
    new Set(value).size !== value.length ||
    value.some((control) => !SANDBOX_STARTUP_CONTROLS.has(control as HarnessSandboxStartupControl))
  ) {
    throw new Error(
      "Agent manifest field 'sandbox_create.startup_controls' must contain unique approval-mode or observability entries",
    );
  }
  return Object.freeze([...(value as HarnessSandboxStartupControl[])]);
}

function readSandboxDockerUlimit(
  value: unknown,
  index: number,
): HarnessSandboxDockerUlimitDeclaration {
  const field = `sandbox_create.docker_ulimits[${String(index)}]`;
  if (!isObjectRecord(value)) {
    throw new Error(`Agent manifest field '${field}' must be an object`);
  }
  const knownFields = new Set(["hard", "name", "soft"]);
  const unknownField = Object.keys(value).find((key) => !knownFields.has(key));
  if (unknownField || Object.keys(value).length !== knownFields.size) {
    throw new Error(`Agent manifest field '${field}' must contain only name, soft, and hard`);
  }
  if (typeof value.name !== "string" || !DOCKER_ULIMIT_NAME_RE.test(value.name)) {
    throw new Error(`Agent manifest field '${field}.name' is invalid`);
  }
  if (
    !Number.isSafeInteger(value.soft) ||
    (value.soft as number) < 0 ||
    (value.soft as number) > DOCKER_ULIMIT_MAX_VALUE
  ) {
    throw new Error(`Agent manifest field '${field}.soft' is outside its allowed range`);
  }
  if (
    !Number.isSafeInteger(value.hard) ||
    (value.hard as number) < (value.soft as number) ||
    (value.hard as number) > DOCKER_ULIMIT_MAX_VALUE
  ) {
    throw new Error(`Agent manifest field '${field}.hard' is outside its allowed range`);
  }
  return Object.freeze({
    name: value.name,
    soft: value.soft as number,
    hard: value.hard as number,
  });
}

/** Read package-declared contributions to the sandbox-create operation. */
export function readSandboxCreateDeclaration(
  manifest: ManifestRecord,
): HarnessSandboxCreateDeclaration | undefined {
  const value = manifest.sandbox_create;
  if (value === undefined) return undefined;
  if (!isObjectRecord(value)) {
    throw new Error("Agent manifest field 'sandbox_create' must be an object");
  }
  const knownFields = new Set([
    "docker_ulimits",
    "driver_mounts",
    "generated_image_build",
    "startup_controls",
  ]);
  const unknownField = Object.keys(value).find((key) => !knownFields.has(key));
  if (unknownField) {
    throw new Error(`Agent manifest field 'sandbox_create.${unknownField}' is not supported`);
  }
  if (
    value.generated_image_build !== undefined &&
    value.generated_image_build !== "local-buildkit-required"
  ) {
    throw new Error(
      "Agent manifest field 'sandbox_create.generated_image_build' must be local-buildkit-required",
    );
  }
  let driverMounts: readonly HarnessSandboxTmpfsMountDeclaration[] | undefined;
  if (value.driver_mounts !== undefined) {
    if (
      !Array.isArray(value.driver_mounts) ||
      value.driver_mounts.length === 0 ||
      value.driver_mounts.length > 16
    ) {
      throw new Error(
        "Agent manifest field 'sandbox_create.driver_mounts' must contain 1 through 16 mounts",
      );
    }
    driverMounts = Object.freeze(value.driver_mounts.map(readSandboxDriverMount));
  }
  const startupControls = readSandboxStartupControls(value.startup_controls);
  let dockerUlimits: readonly HarnessSandboxDockerUlimitDeclaration[] | undefined;
  if (value.docker_ulimits !== undefined) {
    if (
      !Array.isArray(value.docker_ulimits) ||
      value.docker_ulimits.length === 0 ||
      value.docker_ulimits.length > 16
    ) {
      throw new Error(
        "Agent manifest field 'sandbox_create.docker_ulimits' must contain 1 through 16 limits",
      );
    }
    dockerUlimits = Object.freeze(value.docker_ulimits.map(readSandboxDockerUlimit));
    if (new Set(dockerUlimits.map(({ name }) => name)).size !== dockerUlimits.length) {
      throw new Error(
        "Agent manifest field 'sandbox_create.docker_ulimits' must not contain duplicate limit names",
      );
    }
  }
  return Object.freeze({
    ...(value.generated_image_build === "local-buildkit-required"
      ? { generated_image_build: value.generated_image_build }
      : {}),
    ...(driverMounts ? { driver_mounts: driverMounts } : {}),
    ...(startupControls ? { startup_controls: startupControls } : {}),
    ...(dockerUlimits ? { docker_ulimits: dockerUlimits } : {}),
  });
}

/** Return whether one package requires local BuildKit for its generated image. */
export function requiresGeneratedImageLocalBuildKit(
  agent: { sandbox_create?: HarnessSandboxCreateDeclaration } | null | undefined,
): boolean {
  return agent?.sandbox_create?.generated_image_build === "local-buildkit-required";
}

/** Return detached driver mounts for one package's sandbox-create intent. */
export function sandboxCreateDriverMounts(
  agent: { sandbox_create?: HarnessSandboxCreateDeclaration } | null | undefined,
): HarnessSandboxTmpfsMountDeclaration[] {
  return (agent?.sandbox_create?.driver_mounts ?? []).map((mount) => ({
    ...mount,
    drivers: [...mount.drivers],
    ...(mount.options ? { options: [...mount.options] } : {}),
  }));
}

/** Return whether one package declares an operator control for managed startup. */
export function supportsSandboxStartupControl(
  agent: { sandbox_create?: HarnessSandboxCreateDeclaration } | null | undefined,
  control: HarnessSandboxStartupControl,
): boolean {
  return agent?.sandbox_create?.startup_controls?.includes(control) === true;
}

/** Return detached Docker limits declared by one package's managed image. */
export function sandboxCreateDockerUlimits(
  agent: { sandbox_create?: HarnessSandboxCreateDeclaration } | null | undefined,
): HarnessSandboxDockerUlimitDeclaration[] {
  return (agent?.sandbox_create?.docker_ulimits ?? []).map((limit) => ({ ...limit }));
}
