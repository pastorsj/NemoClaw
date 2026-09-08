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
  "add_command",
  "collision",
  "install_root",
  "list_command",
  "mirror_root",
  "removal",
  "remove_command",
  "support",
]);
const ACTIVATION_FIELDS = new Set(["kind"]);
const RESET_SESSION_FIELDS = new Set(["kind", "path"]);
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/u;
const UNSAFE_DISPLAY_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const MAX_PATH_BYTES = 1_024;
const MAX_REASON_BYTES = 512;
const MAX_COMMAND_ARGUMENTS = 32;
const MAX_COMMAND_ARGUMENT_BYTES = 4_096;
const SKILL_NAME_TOKEN = "{name}";
const SKILL_SOURCE_TOKEN = "{source}";

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

function readSkillCommand(
  value: unknown,
  field: string,
  requiredToken: typeof SKILL_NAME_TOKEN | typeof SKILL_SOURCE_TOKEN | null,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_COMMAND_ARGUMENTS ||
    value.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.length === 0 ||
        Buffer.byteLength(argument, "utf8") > MAX_COMMAND_ARGUMENT_BYTES ||
        /[\u0000\r\n]/u.test(argument),
    )
  ) {
    throw new Error(
      `Agent manifest field '${field}' must be an argv array of 1 through 32 bounded strings`,
    );
  }
  const command = value as string[];
  for (const token of [SKILL_NAME_TOKEN, SKILL_SOURCE_TOKEN]) {
    const count = command.filter((argument) => argument === token).length;
    if (count !== Number(requiredToken === token)) {
      throw new Error(
        `Agent manifest field '${field}' must contain ${requiredToken === token ? "exactly one" : "no"} ${token} token`,
      );
    }
  }
  return Object.freeze([...command]);
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
    new Set(["activation", "collision", "install_root", "list_command", "removal", "support"]),
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
  if (
    value.collision === "refuse" &&
    value.removal !== "refuse" &&
    value.remove_command === undefined
  ) {
    throw new Error(
      "Agent manifest field 'skills.removal' must be refuse when collision is refuse without a native remove command",
    );
  }
  if (value.remove_command !== undefined && value.removal !== "remove") {
    throw new Error("Agent manifest field 'skills.remove_command' requires removal: remove");
  }

  return Object.freeze({
    support: "managed",
    install_root: readSandboxPath(value.install_root, "skills.install_root"),
    ...(mirrorRoot ? { mirror_root: mirrorRoot } : {}),
    collision: value.collision,
    removal: value.removal,
    activation: readActivation(value.activation),
    list_command: readSkillCommand(value.list_command, "skills.list_command", null),
    ...(value.add_command === undefined
      ? {}
      : {
          add_command: readSkillCommand(
            value.add_command,
            "skills.add_command",
            SKILL_SOURCE_TOKEN,
          ),
        }),
    ...(value.remove_command === undefined
      ? {}
      : {
          remove_command: readSkillCommand(
            value.remove_command,
            "skills.remove_command",
            SKILL_NAME_TOKEN,
          ),
        }),
  });
}
