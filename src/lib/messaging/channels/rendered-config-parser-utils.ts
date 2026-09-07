// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ChannelManifest,
  MessagingAgentId,
  MessagingSerializableValue,
  SandboxMessagingInputReference,
} from "../manifest";

export type RenderedConfigSourceKind = "structured" | "env";

export interface RenderedConfigVisibilityKey {
  readonly key: string;
  readonly inputId: string;
  readonly target: string;
  readonly kind: RenderedConfigSourceKind;
  readonly path?: readonly string[];
  readonly envKey?: string;
}

function effectiveInputValue(
  context: RenderedChannelConfigParserContext,
  inputId: string,
  fallback?: string,
): string | undefined {
  const value = context.inputs.find((input) => input.inputId === inputId)?.value;
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function safeTargetInput(value: string | undefined): value is string {
  return Boolean(
    value &&
    value !== "." &&
    value !== ".." &&
    !value.includes("..") &&
    /^[A-Za-z0-9._-]+$/u.test(value),
  );
}

/**
 * Project receipt-backed package visibility metadata into the fixed core reader.
 * `null` means this is a pre-package manifest and permits the explicit legacy map;
 * an empty array is an authoritative package declaration of no readable config.
 */
export function listPackageConfigVisibilityKeys(
  context: RenderedChannelConfigParserContext,
): readonly RenderedConfigVisibilityKey[] | null {
  const declared = context.manifest.configVisibility;
  if (declared === undefined) return null;
  return declared.flatMap((entry) => {
    if (entry.whenInput) {
      const actual = effectiveInputValue(
        context,
        entry.whenInput.inputId,
        entry.whenInput.defaultValue,
      );
      if (actual !== entry.whenInput.equals) return [];
    }
    let target = entry.target;
    if (entry.targetInputId) {
      const input = effectiveInputValue(context, entry.targetInputId);
      if (!safeTargetInput(input)) return [];
      target = target.replace("{{input}}", input);
      if (target.includes("{{input}}")) return [];
    }
    return [
      {
        key: entry.key ?? entry.inputId,
        inputId: entry.inputId,
        target,
        kind: entry.kind,
        ...(entry.path ? { path: entry.path } : {}),
        ...(entry.envKey ? { envKey: entry.envKey } : {}),
      },
    ];
  });
}

export type RenderedConfigSource =
  | {
      readonly kind: "structured";
      readonly value: unknown;
    }
  | {
      readonly kind: "env";
      readonly entries: ReadonlyMap<string, string>;
    };

export interface RenderedChannelConfigParserContext {
  readonly manifest: ChannelManifest;
  readonly agentId: MessagingAgentId;
  readonly inputs: readonly SandboxMessagingInputReference[];
}

export interface RenderedChannelConfigParser {
  listConfigVisibilityKeys(
    context: RenderedChannelConfigParserContext,
  ): readonly RenderedConfigVisibilityKey[];
  getValue(
    key: RenderedConfigVisibilityKey,
    source: RenderedConfigSource,
  ): MessagingSerializableValue | undefined;
}

export function structuredConfigKey(
  inputId: string,
  target: string,
  path: readonly string[],
  key = inputId,
): RenderedConfigVisibilityKey {
  return { key, inputId, target, kind: "structured", path };
}

export function envConfigKey(
  inputId: string,
  target: string,
  envKey: string,
  key = inputId,
): RenderedConfigVisibilityKey {
  return { key, inputId, target, kind: "env", envKey };
}

export function getStructuredConfigValue(
  source: RenderedConfigSource,
  path: readonly string[] | undefined,
): MessagingSerializableValue | undefined {
  if (source.kind !== "structured" || !path) return undefined;
  return getStructuredPath(source.value, path);
}

export function getEnvConfigValue(
  source: RenderedConfigSource,
  envKey: string | undefined,
): MessagingSerializableValue | undefined {
  if (source.kind !== "env" || !envKey) return undefined;
  return source.entries.get(envKey);
}

export function getStructuredPath(
  value: unknown,
  path: readonly string[],
): MessagingSerializableValue | undefined {
  let current = value;
  for (const segment of path) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
      continue;
    }
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return isMessagingSerializableValue(current) ? current : undefined;
}

export function isMessagingSerializableValue(value: unknown): value is MessagingSerializableValue {
  if (value === null) return true;
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") return true;
  if (Array.isArray(value)) return value.every(isMessagingSerializableValue);
  if (type !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isMessagingSerializableValue);
}
