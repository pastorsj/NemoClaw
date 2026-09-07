// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type ManifestRecord = Readonly<Record<string, unknown>>;

export const HARNESS_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
export const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
export const DISPLAY_CONTROL_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
export const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/u;

const IMMUTABLE_SANDBOX_COMMAND_ROOTS = [
  "/bin/",
  "/opt/",
  "/usr/bin/",
  "/usr/local/bin/",
  "/usr/local/lib/nemoclaw/",
] as const;

/** A package manifest failed the public, data-only harness contract. */
export class HarnessManifestValidationError extends Error {
  override readonly name = "HarnessManifestValidationError";
}

export function fail(field: string, requirement: string): never {
  throw new HarnessManifestValidationError(`Harness manifest field '${field}' ${requirement}`);
}

export function isRecord(value: unknown): value is ManifestRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function requireRecord(value: unknown, field: string): ManifestRecord {
  if (!isRecord(value)) fail(field, "must be an object");
  return value;
}

export function requireExactFields(
  value: ManifestRecord,
  expected: ReadonlySet<string>,
  field: string,
): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    fail(field, `must contain exactly: ${[...expected].join(", ")}`);
  }
}

export function requireKnownFields(
  value: ManifestRecord,
  allowed: ReadonlySet<string>,
  required: ReadonlySet<string>,
  field: string,
): void {
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.has(key))) {
    fail(field, `must contain ${[...required].join(", ")} and only: ${[...allowed].join(", ")}`);
  }
  const missingField = [...required].find((key) => !Object.hasOwn(value, key));
  if (missingField !== undefined) fail(`${field}.${missingField}`, "is required");
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") fail(field, "must be a string");
  return value;
}

export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export function isCanonicalAbsolutePath(value: string): boolean {
  return (
    value.startsWith("/") &&
    value.length > 1 &&
    value
      .slice(1)
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

export function isCanonicalRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

/** A canonical absolute path owned by the sandbox user-visible filesystem. */
export function isCanonicalSandboxPath(value: string): boolean {
  return (
    value.startsWith("/sandbox/") &&
    isCanonicalAbsolutePath(value) &&
    !CONTROL_CHARACTER_PATTERN.test(value) &&
    !value.includes("\\")
  );
}

/** A canonical executable path stored in the sandbox image rather than mutable user state. */
export function isImmutableSandboxCommandPath(value: string): boolean {
  return (
    isCanonicalAbsolutePath(value) &&
    !CONTROL_CHARACTER_PATTERN.test(value) &&
    !value.includes("\\") &&
    IMMUTABLE_SANDBOX_COMMAND_ROOTS.some(
      (root) => value.startsWith(root) && value.length > root.length,
    )
  );
}

/** A canonical relative file path that cannot escape its declared owner directory. */
export function isCanonicalRelativeFilePath(value: string): boolean {
  return (
    isCanonicalRelativePath(value) &&
    !CONTROL_CHARACTER_PATTERN.test(value) &&
    !value.includes("\\")
  );
}

export function requireCanonicalId(value: unknown, field: string): string {
  const identifier = requireString(value, field);
  if (identifier.length > 256 || !HARNESS_ID_PATTERN.test(identifier)) {
    fail(field, "must be a canonical lowercase identifier");
  }
  return identifier;
}
