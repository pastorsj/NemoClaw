// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HarnessAgentCommandDeclaration } from "@nvidia/nemoclaw-harness-contract";

export type PackageAgentCommandPlan =
  | { readonly kind: "help" }
  | {
      readonly kind: "missing-selector";
      readonly argv: readonly string[];
      readonly selectors: readonly string[];
    }
  | {
      readonly kind: "dispatch";
      readonly argv: readonly string[];
      readonly outputMode: "direct" | "bounded-text" | "bounded-json";
      readonly structuredTurnEnvelope?: StructuredTurnEnvelopeDeclaration;
      readonly requestedTimeoutSeconds: number | null;
    };

export type ReceiptAgentCommandPlan = Exclude<PackageAgentCommandPlan, { readonly kind: "help" }>;

/** The exact package declaration that authorizes core's finite envelope parser. */
export type StructuredTurnEnvelopeDeclaration = HarnessAgentCommandDeclaration & {
  readonly output_interpretation: "structured-turn-envelope";
};

export function declarationAuthorizesStructuredTurnEnvelope(
  declaration: StructuredTurnEnvelopeDeclaration,
  command: readonly string[],
): boolean {
  return (
    declaration.output_mode === "bounded-text" &&
    declaration.output_interpretation === "structured-turn-envelope" &&
    declaration.argv.length > 0 &&
    declaration.argv.every((argument, index) => command[index] === argument)
  );
}

function hasSelector(
  args: readonly string[],
  declaration: HarnessAgentCommandDeclaration,
): boolean {
  const selectors = declaration.selector_options ?? [];
  const valueOptions = [...selectors, ...(declaration.value_options ?? [])];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--") return false;
    if (selectors.some((option) => argument === option || argument.startsWith(`${option}=`))) {
      return true;
    }
    if (valueOptions.includes(argument)) index += 1;
  }
  return false;
}

function requestsNativeHelp(args: readonly string[]): boolean {
  for (const argument of args) {
    if (argument === "--") return false;
    if (argument === "-h" || argument === "--help") return true;
  }
  return false;
}

function requestsJsonOutput(
  args: readonly string[],
  declaration: HarnessAgentCommandDeclaration,
): boolean {
  const option = declaration.json_output_option;
  if (!option) return false;
  const valueOptions = [
    ...(declaration.selector_options ?? []),
    ...(declaration.value_options ?? []),
  ];
  const booleanOptions = declaration.boolean_options ?? [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--") return false;
    if (argument === option) return true;
    if (argument.startsWith(`${option}=`)) {
      return !["0", "false", "no", "off"].includes(argument.slice(option.length + 1).toLowerCase());
    }
    if (valueOptions.includes(argument)) {
      index += 1;
      continue;
    }
    const equalsIndex = argument.indexOf("=");
    if (
      equalsIndex > 0 &&
      argument.startsWith("--") &&
      valueOptions.includes(argument.slice(0, equalsIndex))
    ) {
      continue;
    }
    if (booleanOptions.includes(argument)) continue;
    if (argument.startsWith("-")) return false;
  }
  return false;
}

export function packageRequestedTimeoutSeconds(
  args: readonly string[],
  declaration: HarnessAgentCommandDeclaration,
): number | null {
  const timeoutOption = declaration.timeout_option;
  if (!timeoutOption) return null;
  const valueOptions = [
    ...(declaration.selector_options ?? []),
    ...(declaration.value_options ?? []),
  ];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--") return null;
    let raw: string | undefined;
    if (argument === timeoutOption) raw = args[index + 1];
    if (argument.startsWith(`${timeoutOption}=`)) raw = argument.slice(timeoutOption.length + 1);
    if (raw !== undefined) {
      if (!/^\d+$/u.test(raw)) return null;
      const seconds = Number(raw);
      return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
    }
    if (valueOptions.includes(argument)) {
      index += 1;
      continue;
    }
    const equalsIndex = argument.indexOf("=");
    if (
      equalsIndex > 0 &&
      argument.startsWith("--") &&
      valueOptions.includes(argument.slice(0, equalsIndex))
    ) {
      continue;
    }
    const jsonOption = declaration.json_output_option;
    if (
      declaration.boolean_options?.includes(argument) ||
      (jsonOption !== undefined &&
        (argument === jsonOption || argument.startsWith(`${jsonOption}=`)))
    ) {
      continue;
    }
    return null;
  }
  return null;
}

/** Interpret one package-owned finite argv declaration without inspecting a harness ID. */
export function buildPackageAgentCommandPlan(
  declaration: HarnessAgentCommandDeclaration,
  args: readonly string[],
): ReceiptAgentCommandPlan {
  // Help belongs to the package-native command. It is not a turn, so bypass
  // selector enforcement and relay it without interpreting agent output.
  if (requestsNativeHelp(args)) {
    return {
      kind: "dispatch",
      argv: Object.freeze([...declaration.argv, ...args]),
      outputMode: declaration.output_mode,
      requestedTimeoutSeconds: null,
    };
  }
  const selectors = declaration.selector_options ?? [];
  if (declaration.selector_required && !hasSelector(args, declaration)) {
    return {
      kind: "missing-selector",
      argv: Object.freeze([...declaration.argv, ...args]),
      selectors,
    };
  }
  const outputMode =
    declaration.output_mode === "bounded-text" && requestsJsonOutput(args, declaration)
      ? "bounded-json"
      : declaration.output_mode;
  return {
    kind: "dispatch",
    argv: Object.freeze([...declaration.argv, ...args]),
    outputMode,
    ...(declaration.output_interpretation === "structured-turn-envelope"
      ? { structuredTurnEnvelope: declaration as StructuredTurnEnvelopeDeclaration }
      : {}),
    requestedTimeoutSeconds: packageRequestedTimeoutSeconds(args, declaration),
  };
}
