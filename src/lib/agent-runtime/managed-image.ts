// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import type {
  HarnessManagedImageDeclaration,
  HarnessManagedImagePlatform,
  HarnessManagedImageRuntimeIdentity,
  HarnessManagedImageStateRoot,
  HarnessManagedImageWorkspace,
} from "@nvidia/nemoclaw-harness-contract";

import type { ManifestRecord } from "./manifest-types";
import { readObject } from "./manifest-readers";

const MANAGED_IMAGE_FIELDS = new Set([
  "architectures",
  "capability_contract_version",
  "repository",
  "runtime_identity",
  "state_root",
  "startup_profile_contract_version",
  "workspace",
]);
const RUNTIME_IDENTITY_FIELDS = new Set(["gid", "uid", "workdir"]);
const WORKSPACE_FIELDS = new Set(["mode", "owner"]);
const STATE_ROOT_FIELDS = new Set(["mode", "mount_target"]);
const MANAGED_IMAGE_PLATFORMS = new Set<HarnessManagedImagePlatform>([
  "linux/amd64",
  "linux/arm64",
]);
const OCI_REPOSITORY_PATTERN =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[1-9][0-9]{0,4})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u;
const MAX_OCI_REPOSITORY_BYTES = 512;
const MAX_LINUX_ID = 2_147_483_647;

function requireExactFields(
  value: ManifestRecord,
  expected: ReadonlySet<string>,
  field: string,
): void {
  const unexpected = Object.keys(value).find((key) => !expected.has(key));
  if (unexpected !== undefined || Object.keys(value).length !== expected.size) {
    throw new Error(
      `Agent manifest field '${field}' must contain exactly: ${[...expected].join(", ")}`,
    );
  }
}

function requireKnownFields(
  value: ManifestRecord,
  allowed: ReadonlySet<string>,
  required: ReadonlySet<string>,
  field: string,
): void {
  const keys = Object.keys(value);
  const unexpected = keys.find((key) => !allowed.has(key));
  const missing = [...required].find((key) => !Object.hasOwn(value, key));
  if (unexpected !== undefined || missing !== undefined) {
    throw new Error(
      `Agent manifest field '${field}' must contain ${[...required].join(", ")} and only: ${[...allowed].join(", ")}`,
    );
  }
}

function requireLinuxId(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_LINUX_ID) {
    throw new Error(`Agent manifest field '${field}' must be a positive 32-bit integer`);
  }
  return value as number;
}

function readArchitectures(value: unknown): readonly HarnessManagedImagePlatform[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MANAGED_IMAGE_PLATFORMS.size) {
    throw new Error(
      "Agent manifest field 'managed_image.architectures' must contain one or two supported OCI platforms",
    );
  }
  const architectures = value.map((entry, index) => {
    if (
      typeof entry !== "string" ||
      !MANAGED_IMAGE_PLATFORMS.has(entry as HarnessManagedImagePlatform)
    ) {
      throw new Error(
        `Agent manifest field 'managed_image.architectures[${String(index)}]' must be linux/amd64 or linux/arm64`,
      );
    }
    return entry as HarnessManagedImagePlatform;
  });
  if (new Set(architectures).size !== architectures.length) {
    throw new Error(
      "Agent manifest field 'managed_image.architectures' must not contain duplicates",
    );
  }
  return Object.freeze(architectures);
}

function readRuntimeIdentity(value: ManifestRecord): HarnessManagedImageRuntimeIdentity {
  requireExactFields(value, RUNTIME_IDENTITY_FIELDS, "managed_image.runtime_identity");
  const workdir = value.workdir;
  if (
    workdir !== "/sandbox" ||
    !path.posix.isAbsolute(workdir) ||
    path.posix.normalize(workdir) !== workdir
  ) {
    throw new Error(
      "Agent manifest field 'managed_image.runtime_identity.workdir' must be /sandbox",
    );
  }
  return Object.freeze({
    uid: requireLinuxId(value.uid, "managed_image.runtime_identity.uid"),
    gid: requireLinuxId(value.gid, "managed_image.runtime_identity.gid"),
    workdir,
  });
}

function readWorkspace(value: unknown): HarnessManagedImageWorkspace | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent manifest field 'managed_image.workspace' must be an object");
  }
  const workspace = value as ManifestRecord;
  requireExactFields(workspace, WORKSPACE_FIELDS, "managed_image.workspace");
  if (workspace.owner !== "runtime" && workspace.owner !== "root") {
    throw new Error("Agent manifest field 'managed_image.workspace.owner' must be runtime or root");
  }
  if (workspace.mode !== "0755" && workspace.mode !== "1775") {
    throw new Error("Agent manifest field 'managed_image.workspace.mode' must be 0755 or 1775");
  }
  return Object.freeze({ owner: workspace.owner, mode: workspace.mode });
}

function readStateRoot(value: unknown): HarnessManagedImageStateRoot | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent manifest field 'managed_image.state_root' must be an object");
  }
  const stateRoot = value as ManifestRecord;
  requireExactFields(stateRoot, STATE_ROOT_FIELDS, "managed_image.state_root");
  const mountTarget = stateRoot.mount_target;
  if (
    typeof mountTarget !== "string" ||
    !/^\/sandbox\/[^/]+$/u.test(mountTarget) ||
    path.posix.normalize(mountTarget) !== mountTarget
  ) {
    throw new Error(
      "Agent manifest field 'managed_image.state_root.mount_target' must be one directory directly below /sandbox",
    );
  }
  if (stateRoot.mode !== "0770" && stateRoot.mode !== "2770" && stateRoot.mode !== "3770") {
    throw new Error(
      "Agent manifest field 'managed_image.state_root.mode' must be 0770, 2770, or 3770",
    );
  }
  return Object.freeze({
    mount_target: mountTarget as `/sandbox/${string}`,
    mode: stateRoot.mode,
  });
}

function readContractVersion(value: unknown, field: string): 1 {
  if (value !== 1) {
    throw new Error(`Agent manifest field '${field}' must be 1`);
  }
  return 1;
}

/** Parse the package-owned managed-image composition declaration, if present. */
export function readManagedImageDeclaration(
  manifest: ManifestRecord,
): HarnessManagedImageDeclaration | null {
  if (manifest.managed_image === undefined) return null;
  const value = readObject(manifest, "managed_image");
  if (!value) throw new Error("Agent manifest field 'managed_image' must be an object");
  requireKnownFields(
    value,
    MANAGED_IMAGE_FIELDS,
    new Set([
      "architectures",
      "capability_contract_version",
      "repository",
      "runtime_identity",
      "startup_profile_contract_version",
    ]),
    "managed_image",
  );

  const repository = value.repository;
  if (
    typeof repository !== "string" ||
    Buffer.byteLength(repository, "utf8") > MAX_OCI_REPOSITORY_BYTES ||
    !OCI_REPOSITORY_PATTERN.test(repository)
  ) {
    throw new Error(
      "Agent manifest field 'managed_image.repository' must be a canonical OCI repository without a tag or digest",
    );
  }
  const runtimeIdentity = readObject(value, "runtime_identity");
  if (!runtimeIdentity) {
    throw new Error("Agent manifest field 'managed_image.runtime_identity' must be an object");
  }

  const workspace = readWorkspace(value.workspace);
  const stateRoot = readStateRoot(value.state_root);
  return Object.freeze({
    repository,
    architectures: readArchitectures(value.architectures),
    runtime_identity: readRuntimeIdentity(runtimeIdentity),
    ...(workspace ? { workspace } : {}),
    ...(stateRoot ? { state_root: stateRoot } : {}),
    startup_profile_contract_version: readContractVersion(
      value.startup_profile_contract_version,
      "managed_image.startup_profile_contract_version",
    ),
    capability_contract_version: readContractVersion(
      value.capability_contract_version,
      "managed_image.capability_contract_version",
    ),
  });
}
