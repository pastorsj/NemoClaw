// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import type {
  HarnessSkillActivation,
  HarnessSkillCapability,
} from "@nvidia/nemoclaw-harness-contract";

import type { ManifestRecord } from "./manifest-types";
import { readObject } from "./manifest-readers";

const DISABLED_FIELDS = new Set(["reason", "support"]);
const MANAGED_FIELDS = new Set([
  "activation",
  "collision",
  "install_root",
  "mirror_root",
  "removal",
  "support",
]);
const ACTIVATION_FIELDS = new Set(["kind"]);
const RESET_SESSION_FIELDS = new Set(["kind", "path"]);
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/u;
const UNSAFE_DISPLAY_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const MAX_PATH_BYTES = 1_024;
const MAX_REASON_BYTES = 512;

function requireExactFields(
  value: ManifestRecord,
  expected: ReadonlySet<string>,
  field: string,
): void {
  const keys = Object.keys(value);
  const unexpected = keys.find((key) => !expected.has(key));
  const missing = [...expected].find((key) => !Object.hasOwn(value, key));
  if (unexpected !== undefined || missing !== undefined) {
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

function hasCanonicalSegments(value: string): boolean {
  return value
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        SAFE_PATH_SEGMENT.test(segment),
    );
}

function readSandboxPath(value: unknown, field: string): `/sandbox/${string}` {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES ||
    !value.startsWith("/sandbox/") ||
    path.posix.normalize(value) !== value ||
    !hasCanonicalSegments(value.slice("/sandbox/".length))
  ) {
    throw new Error(`Agent manifest field '${field}' must be a canonical path below /sandbox`);
  }
  return value as `/sandbox/${string}`;
}

function readMirrorRoot(value: unknown): `$HOME/${string}` | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES ||
    !value.startsWith("$HOME/") ||
    path.posix.normalize(value.slice("$HOME/".length)) !== value.slice("$HOME/".length) ||
    !hasCanonicalSegments(value.slice("$HOME/".length))
  ) {
    throw new Error(
      "Agent manifest field 'skills.mirror_root' must be a canonical path below $HOME",
    );
  }
  return value as `$HOME/${string}`;
}

function readActivation(value: unknown): HarnessSkillActivation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent manifest field 'skills.activation' must be an object");
  }
  const activation = value as ManifestRecord;
  if (activation.kind === "reset-session-index") {
    requireExactFields(activation, RESET_SESSION_FIELDS, "skills.activation");
    return Object.freeze({
      kind: "reset-session-index",
      path: readSandboxPath(activation.path, "skills.activation.path"),
    });
  }
  requireExactFields(activation, ACTIVATION_FIELDS, "skills.activation");
  if (activation.kind !== "new-session" && activation.kind !== "gateway-restart-required") {
    throw new Error(
      "Agent manifest field 'skills.activation.kind' must be new-session, gateway-restart-required, or reset-session-index",
    );
  }
  return Object.freeze({ kind: activation.kind });
}

const UNDECLARED_SKILL_CAPABILITY: HarnessSkillCapability = Object.freeze({
  support: "disabled",
  reason: "This harness package does not declare skill installation support.",
});

/** Parse the finite package-owned skill layout and lifecycle declaration. */
export function readSkillCapability(manifest: ManifestRecord): HarnessSkillCapability {
  if (manifest.skills === undefined) return UNDECLARED_SKILL_CAPABILITY;
  const value = readObject(manifest, "skills");
  if (!value) throw new Error("Agent manifest field 'skills' must be an object");

  if (value.support === "disabled") {
    requireExactFields(value, DISABLED_FIELDS, "skills");
    if (
      typeof value.reason !== "string" ||
      value.reason.trim().length === 0 ||
      UNSAFE_DISPLAY_CHARACTER.test(value.reason) ||
      Buffer.byteLength(value.reason, "utf8") > MAX_REASON_BYTES
    ) {
      throw new Error(
        "Agent manifest field 'skills.reason' must be a non-empty single-line string of at most 512 bytes",
      );
    }
    return Object.freeze({ support: "disabled", reason: value.reason.trim() });
  }

  if (value.support !== "managed") {
    throw new Error("Agent manifest field 'skills.support' must be managed or disabled");
  }
  requireKnownFields(
    value,
    MANAGED_FIELDS,
    new Set(["activation", "collision", "install_root", "removal", "support"]),
    "skills",
  );
  if (value.collision !== "replace" && value.collision !== "refuse") {
    throw new Error("Agent manifest field 'skills.collision' must be replace or refuse");
  }
  if (value.removal !== "remove" && value.removal !== "refuse") {
    throw new Error("Agent manifest field 'skills.removal' must be remove or refuse");
  }
  const mirrorRoot = readMirrorRoot(value.mirror_root);
  if (value.collision === "refuse" && mirrorRoot) {
    throw new Error("Agent manifest field 'skills.mirror_root' requires collision: replace");
  }
  if (value.collision === "refuse" && value.removal !== "refuse") {
    throw new Error(
      "Agent manifest field 'skills.removal' must be refuse when collision is refuse",
    );
  }

  return Object.freeze({
    support: "managed",
    install_root: readSandboxPath(value.install_root, "skills.install_root"),
    ...(mirrorRoot ? { mirror_root: mirrorRoot } : {}),
    collision: value.collision,
    removal: value.removal,
    activation: readActivation(value.activation),
  });
}
