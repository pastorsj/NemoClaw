// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import type {
  HarnessManagedBaseImageDeclaration,
  HarnessManagedBaseImagePin,
  HarnessManagedImageDeclaration,
  HarnessManagedImagePlatform,
  HarnessManagedImagePublicationDeclaration,
  HarnessManagedImageRuntimeIdentity,
  HarnessManagedImageStateRoot,
  HarnessManagedImageWorkspace,
  HarnessStartupEnvironmentInputDeclaration,
} from "@nvidia/nemoclaw-harness-contract";

import type { ManifestRecord } from "./manifest-types";
import { readObject } from "./manifest-readers";

const MANAGED_IMAGE_FIELDS = new Set([
  "architectures",
  "base_image",
  "publication",
  "rebuild_base_image",
  "repository",
  "runtime_identity",
  "state_root",
  "startup_profile_environment",
  "workspace",
]);
const BASE_IMAGE_FIELDS = new Set([
  "corporate_ca",
  "package_probe",
  "pinned_remote",
  "security_inventory",
]);
const PINNED_REMOTE_FIELDS = new Set(["argument", "ref"]);
const RUNTIME_IDENTITY_FIELDS = new Set(["gid", "uid", "workdir"]);
const WORKSPACE_FIELDS = new Set(["mode", "owner"]);
const STATE_ROOT_FIELDS = new Set(["mode", "mount_target"]);
const STARTUP_ENVIRONMENT_INPUT_FIELDS = new Set(["max_bytes", "name", "value_type"]);
const PUBLICATION_FIELDS = new Set(["digests", "source"]);
const PUBLICATION_SOURCE_FIELDS = new Set(["cohort", "release", "repository", "revision"]);
const MANAGED_IMAGE_PLATFORMS = new Set<HarnessManagedImagePlatform>([
  "linux/amd64",
  "linux/arm64",
]);
const OCI_REPOSITORY_PATTERN =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[1-9][0-9]{0,4})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u;
const MAX_OCI_REPOSITORY_BYTES = 512;
const SOURCE_REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/u;
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const SOURCE_RELEASE_PATTERN = /^v[0-9]+(?:\.[0-9]+){1,3}(?:[-.][0-9A-Za-z][0-9A-Za-z.-]*)?$/u;
const SOURCE_COHORT_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,127})$/u;
const MANAGED_IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const PINNED_REMOTE_REF_PATTERN =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[1-9][0-9]{0,4})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[0-9a-f]{64}$/u;
const MAX_SOURCE_REPOSITORY_BYTES = 201;
const MAX_SOURCE_RELEASE_BYTES = 128;
const MAX_LINUX_ID = 2_147_483_647;
const MAX_STARTUP_ENVIRONMENT_INPUTS = 32;
const MAX_STARTUP_ENVIRONMENT_VALUE_BYTES = 64 * 1024;
const STARTUP_ENVIRONMENT_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;
const CREDENTIAL_ENVIRONMENT_NAME_PATTERN =
  /(?:^|_)(?:AUTH|AUTHORIZATION|COOKIE|CREDENTIAL|DSN|KEY|PASS|PASSPHRASE|PASSWORD|SECRET|TOKEN|WEBHOOK)(?:S|_.*)?$/u;
const MAX_TOKEN_QUANTITY_ENVIRONMENT_NAME_PATTERN = /(?:^|_)MAX_TOKENS$/u;
const CORE_STARTUP_ENVIRONMENT_NAMES = new Set([
  "CHAT_UI_URL",
  "NEMOCLAW_CORPORATE_CA_B64",
  "NEMOCLAW_DASHBOARD_BIND",
  "NEMOCLAW_DASHBOARD_PORT",
  "NEMOCLAW_INFERENCE_API",
  "NEMOCLAW_INFERENCE_BASE_URL",
  "NEMOCLAW_INFERENCE_COMPAT_B64",
  "NEMOCLAW_INFERENCE_PROVIDER_ID",
  "NEMOCLAW_MESSAGING_PLAN_B64",
  "NEMOCLAW_MODEL",
  "NEMOCLAW_PRIMARY_MODEL_REF",
  "NEMOCLAW_PROXY_HOST",
  "NEMOCLAW_PROXY_PORT",
  "NEMOCLAW_TOOL_DISCLOSURE",
  "NEMOCLAW_UPSTREAM_ENDPOINT_URL",
  "NEMOCLAW_UPSTREAM_PROVIDER",
  "NEMOCLAW_WEB_SEARCH_ENABLED",
  "NEMOCLAW_WEB_SEARCH_PROVIDER",
]);

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

function readBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`Agent manifest field '${field}' must be a boolean`);
  }
  return value;
}

function readPinnedRemote(value: unknown): HarnessManagedBaseImagePin | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "Agent manifest field 'managed_image.base_image.pinned_remote' must be an object",
    );
  }
  const pin = value as ManifestRecord;
  requireExactFields(pin, PINNED_REMOTE_FIELDS, "managed_image.base_image.pinned_remote");
  if (pin.argument !== "BASE_IMAGE") {
    throw new Error(
      "Agent manifest field 'managed_image.base_image.pinned_remote.argument' must be BASE_IMAGE",
    );
  }
  if (typeof pin.ref !== "string" || !PINNED_REMOTE_REF_PATTERN.test(pin.ref)) {
    throw new Error(
      "Agent manifest field 'managed_image.base_image.pinned_remote.ref' must be a canonical OCI SHA-256 digest reference",
    );
  }
  return Object.freeze({
    argument: pin.argument,
    ref: pin.ref as `${string}@sha256:${string}`,
  });
}

function readBaseImage(value: unknown): HarnessManagedBaseImageDeclaration | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent manifest field 'managed_image.base_image' must be an object");
  }
  const baseImage = value as ManifestRecord;
  requireKnownFields(baseImage, BASE_IMAGE_FIELDS, new Set(), "managed_image.base_image");
  const corporateCa = readBoolean(baseImage.corporate_ca, "managed_image.base_image.corporate_ca");
  const securityInventory = readBoolean(
    baseImage.security_inventory,
    "managed_image.base_image.security_inventory",
  );
  const packageProbe = readBoolean(
    baseImage.package_probe,
    "managed_image.base_image.package_probe",
  );
  const pinnedRemote = readPinnedRemote(baseImage.pinned_remote);
  return Object.freeze({
    ...(corporateCa === undefined ? {} : { corporate_ca: corporateCa }),
    ...(securityInventory === undefined ? {} : { security_inventory: securityInventory }),
    ...(packageProbe === undefined ? {} : { package_probe: packageProbe }),
    ...(pinnedRemote ? { pinned_remote: pinnedRemote } : {}),
  });
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

function readStartupProfileEnvironment(
  value: unknown,
): readonly HarnessStartupEnvironmentInputDeclaration[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_STARTUP_ENVIRONMENT_INPUTS) {
    throw new Error(
      "Agent manifest field 'managed_image.startup_profile_environment' must be an array with at most 32 entries",
    );
  }
  const seen = new Set<string>();
  const declarations = value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(
        `Agent manifest field 'managed_image.startup_profile_environment[${String(index)}]' must be an object`,
      );
    }
    const declaration = entry as ManifestRecord;
    requireExactFields(
      declaration,
      STARTUP_ENVIRONMENT_INPUT_FIELDS,
      `managed_image.startup_profile_environment[${String(index)}]`,
    );
    const name = declaration.name;
    const valueType = declaration.value_type;
    if (valueType !== "string" && valueType !== "positive-integer") {
      throw new Error(
        `Agent manifest field 'managed_image.startup_profile_environment[${String(index)}].value_type' must be string or positive-integer`,
      );
    }
    const permittedTokenQuantity =
      valueType === "positive-integer" &&
      typeof name === "string" &&
      MAX_TOKEN_QUANTITY_ENVIRONMENT_NAME_PATTERN.test(name);
    if (
      typeof name !== "string" ||
      !STARTUP_ENVIRONMENT_NAME_PATTERN.test(name) ||
      (CREDENTIAL_ENVIRONMENT_NAME_PATTERN.test(name) && !permittedTokenQuantity) ||
      CORE_STARTUP_ENVIRONMENT_NAMES.has(name) ||
      seen.has(name)
    ) {
      throw new Error(
        `Agent manifest field 'managed_image.startup_profile_environment[${String(index)}].name' must be a unique non-secret, non-authority environment name`,
      );
    }
    const maxBytes = declaration.max_bytes;
    if (
      !Number.isSafeInteger(maxBytes) ||
      (maxBytes as number) < 1 ||
      (maxBytes as number) > MAX_STARTUP_ENVIRONMENT_VALUE_BYTES
    ) {
      throw new Error(
        `Agent manifest field 'managed_image.startup_profile_environment[${String(index)}].max_bytes' must be an integer from 1 through ${String(MAX_STARTUP_ENVIRONMENT_VALUE_BYTES)}`,
      );
    }
    seen.add(name);
    return Object.freeze({
      name,
      value_type: valueType,
      max_bytes: maxBytes as number,
    });
  });
  return Object.freeze(declarations);
}

function readPublication(
  value: unknown,
  architectures: readonly HarnessManagedImagePlatform[],
): HarnessManagedImagePublicationDeclaration | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent manifest field 'managed_image.publication' must be an object");
  }
  const publication = value as ManifestRecord;
  requireExactFields(publication, PUBLICATION_FIELDS, "managed_image.publication");
  if (
    publication.source === null ||
    typeof publication.source !== "object" ||
    Array.isArray(publication.source)
  ) {
    throw new Error("Agent manifest field 'managed_image.publication.source' must be an object");
  }
  const source = publication.source as ManifestRecord;
  requireExactFields(source, PUBLICATION_SOURCE_FIELDS, "managed_image.publication.source");
  const sourceRepository = source.repository;
  if (
    typeof sourceRepository !== "string" ||
    Buffer.byteLength(sourceRepository, "utf8") > MAX_SOURCE_REPOSITORY_BYTES ||
    !SOURCE_REPOSITORY_PATTERN.test(sourceRepository)
  ) {
    throw new Error(
      "Agent manifest field 'managed_image.publication.source.repository' must be a bounded source repository in owner/name form",
    );
  }
  const sourceRevision = source.revision;
  if (typeof sourceRevision !== "string" || !SOURCE_REVISION_PATTERN.test(sourceRevision)) {
    throw new Error(
      "Agent manifest field 'managed_image.publication.source.revision' must be a lowercase 40-character source revision",
    );
  }
  const sourceRelease = source.release;
  if (
    typeof sourceRelease !== "string" ||
    Buffer.byteLength(sourceRelease, "utf8") > MAX_SOURCE_RELEASE_BYTES ||
    !SOURCE_RELEASE_PATTERN.test(sourceRelease)
  ) {
    throw new Error(
      "Agent manifest field 'managed_image.publication.source.release' must be a bounded v-prefixed release",
    );
  }
  const sourceCohort = source.cohort;
  if (typeof sourceCohort !== "string" || !SOURCE_COHORT_PATTERN.test(sourceCohort)) {
    throw new Error(
      "Agent manifest field 'managed_image.publication.source.cohort' must be a bounded lowercase publication identifier",
    );
  }
  if (
    publication.digests === null ||
    typeof publication.digests !== "object" ||
    Array.isArray(publication.digests)
  ) {
    throw new Error("Agent manifest field 'managed_image.publication.digests' must be an object");
  }
  const rawDigests = publication.digests as ManifestRecord;
  requireExactFields(rawDigests, new Set(architectures), "managed_image.publication.digests");
  const digests: Partial<Record<HarnessManagedImagePlatform, `sha256:${string}`>> = {};
  for (const platform of architectures) {
    const digest = rawDigests[platform];
    if (typeof digest !== "string" || !MANAGED_IMAGE_DIGEST_PATTERN.test(digest)) {
      throw new Error(
        `Agent manifest field 'managed_image.publication.digests.${platform}' must be an exact lowercase SHA-256 digest`,
      );
    }
    digests[platform] = digest as `sha256:${string}`;
  }
  return Object.freeze({
    source: Object.freeze({
      repository: sourceRepository,
      revision: sourceRevision,
      release: sourceRelease,
      cohort: sourceCohort,
    }),
    digests: Object.freeze(digests),
  });
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
    new Set(["architectures", "repository", "runtime_identity"]),
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
  const baseImage = readBaseImage(value.base_image);
  const stateRoot = readStateRoot(value.state_root);
  const startupProfileEnvironment = readStartupProfileEnvironment(
    value.startup_profile_environment,
  );
  const rebuildBaseImage = value.rebuild_base_image;
  if (
    rebuildBaseImage !== undefined &&
    rebuildBaseImage !== "not-required" &&
    rebuildBaseImage !== "resolve" &&
    rebuildBaseImage !== "pinned-remote"
  ) {
    throw new Error(
      "Agent manifest field 'managed_image.rebuild_base_image' must be not-required, resolve, or pinned-remote",
    );
  }
  const architectures = readArchitectures(value.architectures);
  const publication = readPublication(value.publication, architectures);
  return Object.freeze({
    repository,
    architectures,
    runtime_identity: readRuntimeIdentity(runtimeIdentity),
    ...(baseImage ? { base_image: baseImage } : {}),
    ...(workspace ? { workspace } : {}),
    ...(stateRoot ? { state_root: stateRoot } : {}),
    ...(startupProfileEnvironment
      ? { startup_profile_environment: startupProfileEnvironment }
      : {}),
    ...(rebuildBaseImage ? { rebuild_base_image: rebuildBaseImage } : {}),
    ...(publication ? { publication } : {}),
  });
}
