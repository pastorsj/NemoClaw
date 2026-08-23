// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const SINGLE_LINE_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const SCRIPT_CONTROL_PATTERN = /[\u0000-\u0009\u000b-\u001f\u007f]/u;

type RuntimeTextOptions = Readonly<{
  allowLineFeeds?: boolean;
  maxLength?: number;
}>;

function invalidRuntimeResult(owner: string, label: string): never {
  throw new Error(`${owner} returned an invalid ${label}.`);
}

export function requireRuntimeText(
  value: unknown,
  owner: string,
  label: string,
  options: RuntimeTextOptions = {},
): string {
  const maxLength = options.maxLength ?? 4096;
  const unsafePattern = options.allowLineFeeds
    ? SCRIPT_CONTROL_PATTERN
    : SINGLE_LINE_CONTROL_PATTERN;
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength ||
    unsafePattern.test(value)
  ) {
    return invalidRuntimeResult(owner, label);
  }
  return value;
}

export function requireRuntimeCommand(value: unknown, owner: string, label: string): string {
  return requireRuntimeText(value, owner, label, {
    allowLineFeeds: true,
    maxLength: 512 * 1024,
  });
}

export function requireRuntimeArgv(value: unknown, owner: string, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 64 ||
    !value.every(
      (entry) =>
        typeof entry === "string" &&
        entry.length > 0 &&
        entry.length <= 128 * 1024 &&
        !SINGLE_LINE_CONTROL_PATTERN.test(entry),
    ) ||
    value.reduce((total, entry) => total + entry.length, 0) > 512 * 1024
  ) {
    return invalidRuntimeResult(owner, label);
  }
  return Object.freeze([...value]) as string[];
}

export function requireRuntimeBoolean(value: unknown, owner: string, label: string): boolean {
  if (typeof value !== "boolean") return invalidRuntimeResult(owner, label);
  return value;
}

export function requireRuntimeRecord(
  value: unknown,
  owner: string,
  label: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    return invalidRuntimeResult(owner, label);
  }
  return value as Record<string, unknown>;
}

export function requireExactRuntimeKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  owner: string,
  label: string,
): void {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) invalidRuntimeResult(owner, label);
  const actual = (ownKeys as string[]).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalidRuntimeResult(owner, label);
  }
}

export function requireRuntimeStringArray(
  value: unknown,
  owner: string,
  label: string,
  maxEntries: number,
  allowEmpty = false,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.length > maxEntries ||
    !value.every(
      (entry) =>
        typeof entry === "string" &&
        entry.length > 0 &&
        entry.length <= 16 * 1024 &&
        !SINGLE_LINE_CONTROL_PATTERN.test(entry),
    )
  ) {
    return invalidRuntimeResult(owner, label);
  }
  return Object.freeze([...value]);
}
