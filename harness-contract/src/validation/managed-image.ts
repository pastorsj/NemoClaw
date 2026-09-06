// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  fail,
  isCanonicalAbsolutePath,
  type ManifestRecord,
  requireExactFields,
  requireKnownFields,
  requireRecord,
  requireString,
  utf8ByteLength,
} from "./shared.js";

function validateStartupEnvironment(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 32) {
    fail("managed_image.startup_profile_environment", "must be an array with at most 32 entries");
  }
  const fields = new Set(["name", "value_type", "max_bytes"]);
  const coreNames = new Set([
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
  const secretPattern =
    /(?:^|_)(?:AUTH|AUTHORIZATION|COOKIE|CREDENTIAL|DSN|KEY|PASS|PASSPHRASE|PASSWORD|SECRET|TOKEN|WEBHOOK)(?:S|_.*)?$/u;
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const field = `managed_image.startup_profile_environment[${String(index)}]`;
    const declaration = requireRecord(entry, field);
    requireExactFields(declaration, fields, field);
    const name = requireString(declaration.name, `${field}.name`);
    const positiveTokenCount =
      declaration.value_type === "positive-integer" && /(?:^|_)MAX_TOKENS$/u.test(name);
    if (
      !/^[A-Z][A-Z0-9_]{0,127}$/u.test(name) ||
      (secretPattern.test(name) && !positiveTokenCount) ||
      coreNames.has(name) ||
      seen.has(name)
    ) {
      fail(`${field}.name`, "must be a unique non-secret, non-authority environment name");
    }
    if (declaration.value_type !== "string" && declaration.value_type !== "positive-integer") {
      fail(`${field}.value_type`, "must be string or positive-integer");
    }
    if (
      !Number.isSafeInteger(declaration.max_bytes) ||
      (declaration.max_bytes as number) < 1 ||
      (declaration.max_bytes as number) > 65_536
    ) {
      fail(`${field}.max_bytes`, "must be an integer from 1 through 65536");
    }
    seen.add(name);
  });
}

function validatePublication(value: unknown, architectures: readonly unknown[]): void {
  if (value === undefined) return;
  const publication = requireRecord(value, "managed_image.publication");
  requireExactFields(publication, new Set(["source", "digests"]), "managed_image.publication");
  const source = requireRecord(publication.source, "managed_image.publication.source");
  requireExactFields(
    source,
    new Set(["repository", "revision", "release", "cohort"]),
    "managed_image.publication.source",
  );
  if (
    typeof source.repository !== "string" ||
    utf8ByteLength(source.repository) > 201 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/u.test(
      source.repository,
    )
  ) {
    fail(
      "managed_image.publication.source.repository",
      "must be a bounded source repository in owner/name form",
    );
  }
  if (typeof source.revision !== "string" || !/^[0-9a-f]{40}$/u.test(source.revision)) {
    fail(
      "managed_image.publication.source.revision",
      "must be a lowercase 40-character source revision",
    );
  }
  if (
    typeof source.release !== "string" ||
    utf8ByteLength(source.release) > 128 ||
    !/^v[0-9]+(?:\.[0-9]+){1,3}(?:[-.][0-9A-Za-z][0-9A-Za-z.-]*)?$/u.test(source.release)
  ) {
    fail("managed_image.publication.source.release", "must be a bounded v-prefixed release");
  }
  if (
    typeof source.cohort !== "string" ||
    !/^[a-z0-9](?:[a-z0-9.-]{0,127})$/u.test(source.cohort)
  ) {
    fail(
      "managed_image.publication.source.cohort",
      "must be a bounded lowercase publication identifier",
    );
  }

  const digests = requireRecord(publication.digests, "managed_image.publication.digests");
  const expectedPlatforms = new Set(architectures as readonly string[]);
  requireExactFields(digests, expectedPlatforms, "managed_image.publication.digests");
  for (const platform of expectedPlatforms) {
    if (
      typeof digests[platform] !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(digests[platform])
    ) {
      fail(
        `managed_image.publication.digests.${platform}`,
        "must be an exact lowercase SHA-256 digest",
      );
    }
  }
}

function validateBaseImage(value: unknown): void {
  if (value === undefined) return;
  const baseImage = requireRecord(value, "managed_image.base_image");
  requireKnownFields(
    baseImage,
    new Set(["corporate_ca", "package_probe", "pinned_remote", "security_inventory"]),
    new Set(),
    "managed_image.base_image",
  );
  for (const key of ["corporate_ca", "package_probe", "security_inventory"] as const) {
    if (baseImage[key] !== undefined && typeof baseImage[key] !== "boolean") {
      fail(`managed_image.base_image.${key}`, "must be a boolean");
    }
  }
  if (baseImage.pinned_remote === undefined) return;
  const pin = requireRecord(baseImage.pinned_remote, "managed_image.base_image.pinned_remote");
  requireExactFields(pin, new Set(["argument", "ref"]), "managed_image.base_image.pinned_remote");
  if (pin.argument !== "BASE_IMAGE") {
    fail("managed_image.base_image.pinned_remote.argument", "must be BASE_IMAGE");
  }
  if (
    typeof pin.ref !== "string" ||
    !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[1-9][0-9]{0,4})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[0-9a-f]{64}$/u.test(
      pin.ref,
    )
  ) {
    fail(
      "managed_image.base_image.pinned_remote.ref",
      "must be a canonical OCI SHA-256 digest reference",
    );
  }
}

/** Validate the finite composition declaration for a managed harness image. */
export function validateManagedImage(manifest: ManifestRecord): void {
  if (manifest.managed_image === undefined) return;
  const image = requireRecord(manifest.managed_image, "managed_image");
  requireKnownFields(
    image,
    new Set([
      "architectures",
      "base_image",
      "publication",
      "repository",
      "rebuild_base_image",
      "runtime_identity",
      "state_root",
      "startup_profile_environment",
      "workspace",
    ]),
    new Set(["architectures", "repository", "runtime_identity"]),
    "managed_image",
  );
  if (
    typeof image.repository !== "string" ||
    utf8ByteLength(image.repository) > 512 ||
    !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[1-9][0-9]{0,4})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u.test(
      image.repository,
    )
  ) {
    fail("managed_image.repository", "must be a canonical OCI repository without a tag or digest");
  }
  if (
    image.rebuild_base_image !== undefined &&
    image.rebuild_base_image !== "not-required" &&
    image.rebuild_base_image !== "resolve" &&
    image.rebuild_base_image !== "pinned-remote"
  ) {
    fail("managed_image.rebuild_base_image", "must be not-required, resolve, or pinned-remote");
  }
  if (
    !Array.isArray(image.architectures) ||
    image.architectures.length === 0 ||
    image.architectures.length > 2 ||
    new Set(image.architectures).size !== image.architectures.length ||
    image.architectures.some((entry) => entry !== "linux/amd64" && entry !== "linux/arm64")
  ) {
    fail("managed_image.architectures", "must contain unique linux/amd64 or linux/arm64 platforms");
  }
  validatePublication(image.publication, image.architectures);
  validateBaseImage(image.base_image);
  const identity = requireRecord(image.runtime_identity, "managed_image.runtime_identity");
  requireExactFields(
    identity,
    new Set(["uid", "gid", "workdir"]),
    "managed_image.runtime_identity",
  );
  for (const key of ["uid", "gid"] as const) {
    if (
      !Number.isInteger(identity[key]) ||
      (identity[key] as number) < 1 ||
      (identity[key] as number) > 2_147_483_647
    ) {
      fail(`managed_image.runtime_identity.${key}`, "must be a positive 32-bit integer");
    }
  }
  if (identity.workdir !== "/sandbox") {
    fail("managed_image.runtime_identity.workdir", "must be /sandbox");
  }
  if (image.workspace !== undefined) {
    const workspace = requireRecord(image.workspace, "managed_image.workspace");
    requireExactFields(workspace, new Set(["owner", "mode"]), "managed_image.workspace");
    if (workspace.owner !== "runtime" && workspace.owner !== "root") {
      fail("managed_image.workspace.owner", "must be runtime or root");
    }
    if (workspace.mode !== "0755" && workspace.mode !== "1775") {
      fail("managed_image.workspace.mode", "must be 0755 or 1775");
    }
  }
  if (image.state_root !== undefined) {
    const stateRoot = requireRecord(image.state_root, "managed_image.state_root");
    requireExactFields(stateRoot, new Set(["mount_target", "mode"]), "managed_image.state_root");
    if (
      typeof stateRoot.mount_target !== "string" ||
      !/^\/sandbox\/[^/]+$/u.test(stateRoot.mount_target) ||
      !isCanonicalAbsolutePath(stateRoot.mount_target)
    ) {
      fail(
        "managed_image.state_root.mount_target",
        "must be one directory directly below /sandbox",
      );
    }
    if (stateRoot.mode !== "0770" && stateRoot.mode !== "2770" && stateRoot.mode !== "3770") {
      fail("managed_image.state_root.mode", "must be 0770, 2770, or 3770");
    }
  }
  validateStartupEnvironment(image.startup_profile_environment);
}
