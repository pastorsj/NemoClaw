// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HarnessMessagingHookOperation } from "@nvidia/nemoclaw-harness-contract";

import {
  type ChannelHealthCommandRunner,
  type ChannelHealthReport,
  DEFAULT_CHANNEL_STATUS_HEALTH_TIMEOUT_MS,
  MESSAGING_CHANNEL_HEALTH_OUTPUT_TYPE,
} from "../../channels/channel-health";
import type { MessagingSerializableValue } from "../../manifest";
import type { MessagingHookHandler, MessagingHookRegistration } from "../types";

export const COMMON_PACKAGE_COMMAND_HOOK_HANDLER_ID = "common.packageCommand";

const MAX_RESULT_BYTES = 64 * 1024;
const MAX_BRIDGE_LINES = 16;
const MAX_BRIDGE_LINE_BYTES = 2 * 1024;

export interface PackageCommandHookOptions {
  readonly executeSandboxCommand?: ChannelHealthCommandRunner;
  readonly timeoutMs?: number;
  readonly log?: (message: string) => void;
}

/** Execute one package-declared argv and accept only NemoClaw's bounded result protocols. */
export function createPackageCommandHook(
  options: PackageCommandHookOptions = {},
): MessagingHookHandler {
  return (context) => {
    const operation = readSandboxCommandOperation(context.packageOperation);
    if (!operation) {
      throw new Error(`Package command hook '${context.hookId}' has no typed operation`);
    }
    const execute = options.executeSandboxCommand;
    const sandboxName = readNonEmptyString(context.inputs?.currentSandbox);
    if (!execute || !sandboxName) return {};
    const timeoutMs = normalizeTimeout(options.timeoutMs);
    const command = packageCommandArguments(operation, context.inputs ?? {})
      .map(quoteFixedArgument)
      .join(" ");
    const result = execute(sandboxName, command, timeoutMs);
    if (!result || result.status !== 0) {
      if (operation.output === "bridge-health") {
        (options.log ?? console.log)(
          `  ⚠ Package bridge-health probe for '${context.channelId}' did not complete.`,
        );
      }
      return {};
    }
    const payload = parseBoundedJson(result.stdout);
    if (operation.output === "bridge-health") {
      const lines = readBridgeHealthLines(payload, context.channelId);
      const log = options.log ?? console.log;
      for (const line of lines) log(redactPackageDiagnosticLine(line));
      return {};
    }
    const report = readChannelHealthReport(payload, context.channelId);
    return {
      outputs: {
        channelHealth: {
          kind: "status",
          value: {
            type: MESSAGING_CHANNEL_HEALTH_OUTPUT_TYPE,
            report,
          } as unknown as MessagingSerializableValue,
        },
      },
    };
  };
}

function packageCommandArguments(
  operation: Extract<HarnessMessagingHookOperation, { readonly kind: "sandbox-command" }>,
  inputs: Readonly<Record<string, MessagingSerializableValue>>,
): readonly string[] {
  if (operation.context !== "channel-health") return operation.command.argv;
  const context = {
    agent: readNonEmptyString(inputs.agent) ?? "unknown",
    probedAt: readNonEmptyString(inputs.probedAt) ?? "",
    channelEnabledInRegistry: inputs.channelEnabledInRegistry === true,
    presetApplied: inputs.presetApplied === true,
    presetOnGateway:
      inputs.presetOnGateway === true ? true : inputs.presetOnGateway === false ? false : null,
  };
  return [
    ...operation.command.argv,
    "--nemoclaw-context",
    Buffer.from(JSON.stringify(context), "utf8").toString("base64url"),
  ];
}

function quoteFixedArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Package diagnostics are summaries, but redact common accidental secret and URL shapes again. */
function redactPackageDiagnosticLine(value: string): string {
  return value
    .replace(/\bhttps?:\/\/[^\s"'<>]+/giu, "[redacted URL]")
    .replace(/\b(?:xox[a-z]-[A-Za-z0-9-]+|\d{5,}:[A-Za-z0-9_-]{16,})\b/gu, "[REDACTED]")
    .replace(
      /\b(token|secret|password|authorization|credential)(\s*[=:]\s*)\S+/giu,
      "$1$2[REDACTED]",
    );
}

export function createPackageCommandHookRegistration(
  options: PackageCommandHookOptions = {},
): MessagingHookRegistration {
  return { id: COMMON_PACKAGE_COMMAND_HOOK_HANDLER_ID, handler: createPackageCommandHook(options) };
}

function readSandboxCommandOperation(
  value: HarnessMessagingHookOperation | undefined,
): Extract<HarnessMessagingHookOperation, { readonly kind: "sandbox-command" }> | null {
  return value?.kind === "sandbox-command" ? value : null;
}

function parseBoundedJson(value: unknown): unknown {
  const source = String(value ?? "");
  if (Buffer.byteLength(source, "utf8") > MAX_RESULT_BYTES) {
    throw new Error("Package messaging command returned an oversized result");
  }
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error("Package messaging command must return valid JSON", { cause: error });
  }
}

function readBridgeHealthLines(value: unknown, channelId: string): readonly string[] {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ["schemaVersion", "type", "channel", "lines"]) ||
    value.schemaVersion !== 1 ||
    value.type !== "messaging-bridge-health" ||
    value.channel !== channelId ||
    !Array.isArray(value.lines) ||
    value.lines.length > MAX_BRIDGE_LINES ||
    value.lines.some(
      (line) =>
        typeof line !== "string" ||
        Buffer.byteLength(line, "utf8") > MAX_BRIDGE_LINE_BYTES ||
        /[\0\r\n]/u.test(line),
    )
  ) {
    throw new Error("Package bridge-health command returned an invalid result");
  }
  return value.lines as string[];
}

function readChannelHealthReport(value: unknown, channelId: string): ChannelHealthReport {
  const report = isObject(value) && value.type === "messaging-channel-health" ? value.report : null;
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ["type", "report"]) ||
    !isObject(report) ||
    !hasOnlyKeys(report, [
      "schemaVersion",
      "channel",
      "agent",
      "verdict",
      "probedAt",
      "signals",
      "hints",
      "readiness",
    ]) ||
    report.schemaVersion !== 1 ||
    report.channel !== channelId ||
    !isBoundedText(report.agent) ||
    !isBoundedText(report.verdict) ||
    !isBoundedText(report.probedAt) ||
    !Array.isArray(report.signals) ||
    report.signals.length > 32 ||
    !report.signals.every(isDiagnosticSignal) ||
    !Array.isArray(report.hints) ||
    report.hints.length > 32 ||
    !report.hints.every(isBoundedText) ||
    (report.readiness !== undefined && !isChannelReadiness(report.readiness))
  ) {
    throw new Error("Package channel-health command returned an invalid result");
  }
  return report as unknown as ChannelHealthReport;
}

function isChannelReadiness(value: unknown): boolean {
  return (
    isObject(value) &&
    hasOnlyKeys(value, ["state", "category", "reason", "retryable", "lastTransitionAt"]) &&
    ["ready", "waiting", "terminal"].includes(String(value.state)) &&
    (value.category === null ||
      ["credential", "network", "plugin", "policy", "runtime"].includes(String(value.category))) &&
    isBoundedText(value.reason) &&
    typeof value.retryable === "boolean" &&
    (value.lastTransitionAt === null || isBoundedText(value.lastTransitionAt))
  );
}

function isDiagnosticSignal(value: unknown): boolean {
  return (
    isObject(value) &&
    hasOnlyKeys(value, ["label", "severity", "detail", "hint"]) &&
    isBoundedText(value.label) &&
    ["ok", "warn", "fail", "info"].includes(String(value.severity)) &&
    isBoundedText(value.detail) &&
    (value.hint === undefined || isBoundedText(value.hint))
  );
}

function isBoundedText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") <= MAX_BRIDGE_LINE_BYTES &&
    !/[\0\r\n]/u.test(value)
  );
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_CHANNEL_STATUS_HEALTH_TIMEOUT_MS;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
