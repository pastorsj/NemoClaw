// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessMessagingBuildFileTemplate,
  HarnessMessagingHookOperation,
  HarnessMessagingValue,
} from "@nvidia/nemoclaw-harness-contract";

import type { MessagingSerializableValue } from "../../manifest";
import type {
  MessagingHookHandler,
  MessagingHookOutputMap,
  MessagingHookRegistration,
} from "../types";

export const COMMON_PACKAGE_BUILD_FILES_HOOK_HANDLER_ID = "common.packageBuildFiles";

const OMIT_VALUE = Symbol("omit-package-build-file-value");
const INPUT_PATH_TOKEN = /\{\{input:([^{}]+)\}\}/gu;

export interface PackageBuildFilesHookOptions {
  readonly now?: () => Date | string;
}

/** Render package-declared build files without loading package code into the host process. */
export function createPackageBuildFilesHook(
  options: PackageBuildFilesHookOptions = {},
): MessagingHookHandler {
  return (context) => {
    const operation = readBuildFilesOperation(context.packageOperation);
    if (!operation) {
      throw new Error(`Package build-files hook '${context.hookId}' has no typed operation`);
    }
    const outputs: Record<string, MessagingHookOutputMap[string]> = {};
    const generatedAt = isoTimestamp(options.now);
    for (const template of operation.outputs) {
      const value = renderBuildFile(template, context.inputs ?? {}, generatedAt);
      outputs[template.id] = { kind: "build-file", value };
    }
    return { outputs };
  };
}

export function createPackageBuildFilesHookRegistration(
  options: PackageBuildFilesHookOptions = {},
): MessagingHookRegistration {
  return {
    id: COMMON_PACKAGE_BUILD_FILES_HOOK_HANDLER_ID,
    handler: createPackageBuildFilesHook(options),
  };
}

function readBuildFilesOperation(
  value: HarnessMessagingHookOperation | undefined,
): Extract<HarnessMessagingHookOperation, { readonly kind: "build-files" }> | null {
  return value?.kind === "build-files" ? value : null;
}

function renderBuildFile(
  template: HarnessMessagingBuildFileTemplate,
  inputs: Readonly<Record<string, MessagingSerializableValue>>,
  generatedAt: string,
): MessagingSerializableValue {
  const path = template.pathTemplate.replace(INPUT_PATH_TOKEN, (_match, inputId) => {
    const value = inputs[String(inputId)];
    if (typeof value !== "string" || !isSafePathSegment(value)) {
      throw new Error(`Package build-file path requires safe segment input '${String(inputId)}'`);
    }
    return value;
  });
  if (
    path.includes("{{") ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Package build-file path '${template.pathTemplate}' has an unresolved token`);
  }
  const source = template.content !== undefined ? template.content : template.merge;
  const rendered = renderTemplateValue(source as HarnessMessagingValue, inputs, generatedAt);
  if (rendered === OMIT_VALUE) {
    throw new Error(`Package build-file '${template.id}' cannot omit its root value`);
  }
  return {
    path,
    ...(template.mode ? { mode: template.mode } : {}),
    ...(template.content !== undefined ? { content: rendered } : { merge: rendered }),
  };
}

function isSafePathSegment(value: string): boolean {
  return (
    value === value.trim() &&
    value.length > 0 &&
    value.length <= 128 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("..") &&
    !/[\\/\0-\x1f\x7f]/u.test(value)
  );
}

function renderTemplateValue(
  value: HarnessMessagingValue,
  inputs: Readonly<Record<string, MessagingSerializableValue>>,
  generatedAt: string,
): MessagingSerializableValue | typeof OMIT_VALUE {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const rendered = renderTemplateValue(entry, inputs, generatedAt);
      return rendered === OMIT_VALUE ? [] : [rendered];
    });
  }
  if (!isObject(value)) return value;
  if (Object.hasOwn(value, "$input")) {
    const inputId = value.$input;
    if (typeof inputId !== "string") throw new Error("Package build-file input marker is invalid");
    const input = inputs[inputId];
    if (input === undefined) {
      if (value.optional === true) return OMIT_VALUE;
      throw new Error(`Package build-file requires input '${inputId}'`);
    }
    return input;
  }
  if (Object.hasOwn(value, "$generated")) {
    if (value.$generated !== "iso-timestamp") {
      throw new Error("Package build-file generated marker is invalid");
    }
    return generatedAt;
  }
  const rendered: Record<string, MessagingSerializableValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    const next = renderTemplateValue(entry, inputs, generatedAt);
    if (next !== OMIT_VALUE) rendered[renderObjectKey(key, inputs)] = next;
  }
  return rendered;
}

function renderObjectKey(
  key: string,
  inputs: Readonly<Record<string, MessagingSerializableValue>>,
): string {
  const rendered = key.replace(INPUT_PATH_TOKEN, (_match, inputId) => {
    const value = inputs[String(inputId)];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Package build-file key requires string input '${String(inputId)}'`);
    }
    return value;
  });
  if (
    rendered.includes("{{") ||
    /[\0\r\n]/u.test(rendered) ||
    ["__proto__", "constructor", "prototype"].includes(rendered)
  ) {
    throw new Error("Package build-file rendered an unsafe object key");
  }
  return rendered;
}

function isObject(
  value: HarnessMessagingValue,
): value is { readonly [key: string]: HarnessMessagingValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isoTimestamp(now: PackageBuildFilesHookOptions["now"]): string {
  const value = now?.() ?? new Date();
  return typeof value === "string" ? value : value.toISOString();
}
