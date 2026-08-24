// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadHarnessCommonJsModule, resolveHarnessPackage } from "../harness/commonjs-runtime";

type DeepAgentsCodeSpecificationsRuntime = {
  buildDcodeManagedExecLaunchArgs(commandArgs: readonly string[]): unknown;
  createDeepAgentsCodeDos2UnixProbe(imageRef: string): unknown;
  createDeepAgentsCodeVersionProbe(imageRef: string): unknown;
  getDeepAgentsCodeBaseImageInputPaths(): unknown;
  getDeepAgentsCodeDistribution(): unknown;
  getDcodeActivityProbe(): unknown;
  getDcodeManagedExec(): unknown;
};

export const DEEP_AGENTS_CODE_PACKAGE_ID = "langchain-deepagents-code";

export type DeepAgentsCodeVersionProbe = Readonly<{
  args: readonly string[];
  distribution: string;
}>;

export type DeepAgentsCodeDos2UnixProbe = Readonly<{
  args: readonly string[];
  expectedOutput: string;
}>;

export type DcodeActivityProbeStates = Readonly<{
  active: string;
  idleDcodeRuntime: string;
  unverifiableDcodeRuntime: string;
  noDcodeRuntime: string;
}>;

export type DcodeActivityProbe = Readonly<{
  agentName: string;
  prefix: string;
  states: DcodeActivityProbeStates;
  script: string;
}>;

export type DcodeManagedExec = Readonly<{
  agentName: string;
  launcher: string;
  missingDetail: string;
}>;

let cachedRuntime: {
  selectionKey: string;
  packageId: string;
  packageRoot: string;
  module: DeepAgentsCodeSpecificationsRuntime;
} | null = null;

function loadDeepAgentsCodeSpecificationsRuntime(): {
  packageId: string;
  module: DeepAgentsCodeSpecificationsRuntime;
} {
  const selectionKey = process.env.HOME?.trim() || "<default-home>";
  // A command captures verified helper bytes once. Harness installation takes effect in the next process.
  if (cachedRuntime?.selectionKey === selectionKey) {
    return { packageId: cachedRuntime.packageId, module: cachedRuntime.module };
  }
  const harnessPackage = resolveHarnessPackage(DEEP_AGENTS_CODE_PACKAGE_ID);
  if (!harnessPackage) {
    throw new Error("LangChain Deep Agents Code harness package is unavailable.");
  }
  const loaded = loadHarnessCommonJsModule(
    harnessPackage,
    "host/base-qualification.cts",
    128 * 1024,
  );
  const runtime = loaded.exports as Partial<DeepAgentsCodeSpecificationsRuntime>;
  if (
    typeof runtime.buildDcodeManagedExecLaunchArgs !== "function" ||
    typeof runtime.createDeepAgentsCodeDos2UnixProbe !== "function" ||
    typeof runtime.createDeepAgentsCodeVersionProbe !== "function" ||
    typeof runtime.getDeepAgentsCodeBaseImageInputPaths !== "function" ||
    typeof runtime.getDeepAgentsCodeDistribution !== "function" ||
    typeof runtime.getDcodeActivityProbe !== "function" ||
    typeof runtime.getDcodeManagedExec !== "function"
  ) {
    throw new Error("LangChain Deep Agents Code qualification module has an invalid contract.");
  }
  cachedRuntime = {
    selectionKey,
    packageId: harnessPackage.id,
    packageRoot: harnessPackage.rootDir,
    module: runtime as DeepAgentsCodeSpecificationsRuntime,
  };
  return { packageId: cachedRuntime.packageId, module: cachedRuntime.module };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  options: { allowNewlines?: boolean; maxLength?: number } = {},
): string | null {
  const maxLength = options.maxLength ?? 4096;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.includes("\0") ||
    (!options.allowNewlines && /[\r\n]/u.test(value))
  ) {
    return null;
  }
  return value;
}

function commandArgs(value: unknown): readonly string[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 64 ||
    !value.every(
      (entry) => typeof entry === "string" && entry.length <= 128 * 1024 && !entry.includes("\0"),
    )
  ) {
    return null;
  }
  return Object.freeze([...value]);
}

function invalidProbe(): never {
  throw new Error(
    "LangChain Deep Agents Code qualification module returned an invalid specification.",
  );
}

export function createDeepAgentsCodeVersionProbe(imageRef: string): DeepAgentsCodeVersionProbe {
  const value =
    loadDeepAgentsCodeSpecificationsRuntime().module.createDeepAgentsCodeVersionProbe(imageRef);
  if (!isRecord(value)) return invalidProbe();
  const args = commandArgs(value.args);
  const distribution = requiredString(value.distribution);
  if (!args || !distribution) return invalidProbe();
  return Object.freeze({ args, distribution });
}

export function getDeepAgentsCodeDistribution(): string {
  const distribution = requiredString(
    loadDeepAgentsCodeSpecificationsRuntime().module.getDeepAgentsCodeDistribution(),
  );
  if (!distribution) return invalidProbe();
  return distribution;
}

export function getDeepAgentsCodeBaseImageInputPaths(): readonly string[] {
  const value =
    loadDeepAgentsCodeSpecificationsRuntime().module.getDeepAgentsCodeBaseImageInputPaths();
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 16 ||
    !value.every(
      (entry) =>
        typeof entry === "string" &&
        entry.length > 0 &&
        entry.length <= 1024 &&
        !entry.startsWith("/") &&
        !entry.includes("\\") &&
        entry
          .split("/")
          .every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
    )
  ) {
    return invalidProbe();
  }
  return Object.freeze([...value]);
}

export function createDeepAgentsCodeDos2UnixProbe(imageRef: string): DeepAgentsCodeDos2UnixProbe {
  const value =
    loadDeepAgentsCodeSpecificationsRuntime().module.createDeepAgentsCodeDos2UnixProbe(imageRef);
  if (!isRecord(value)) return invalidProbe();
  const args = commandArgs(value.args);
  const expectedOutput = requiredString(value.expectedOutput);
  if (!args || !expectedOutput) return invalidProbe();
  return Object.freeze({ args, expectedOutput });
}

export function getDcodeActivityProbe(): DcodeActivityProbe {
  const runtime = loadDeepAgentsCodeSpecificationsRuntime();
  const value = runtime.module.getDcodeActivityProbe();
  if (!isRecord(value) || !isRecord(value.states)) return invalidProbe();
  const agentName = requiredString(value.agentName);
  const prefix = requiredString(value.prefix);
  const script = requiredString(value.script, { allowNewlines: true, maxLength: 128 * 1024 });
  const active = requiredString(value.states.active);
  const idleDcodeRuntime = requiredString(value.states.idleDcodeRuntime);
  const unverifiableDcodeRuntime = requiredString(value.states.unverifiableDcodeRuntime);
  const noDcodeRuntime = requiredString(value.states.noDcodeRuntime);
  if (
    agentName !== runtime.packageId ||
    !prefix ||
    !script ||
    !active ||
    !idleDcodeRuntime ||
    !unverifiableDcodeRuntime ||
    !noDcodeRuntime ||
    new Set([active, idleDcodeRuntime, unverifiableDcodeRuntime, noDcodeRuntime]).size !== 4
  ) {
    return invalidProbe();
  }
  return Object.freeze({
    agentName,
    prefix,
    script,
    states: Object.freeze({
      active,
      idleDcodeRuntime,
      unverifiableDcodeRuntime,
      noDcodeRuntime,
    }),
  });
}

export function getDcodeManagedExec(): DcodeManagedExec {
  const runtime = loadDeepAgentsCodeSpecificationsRuntime();
  const value = runtime.module.getDcodeManagedExec();
  if (!isRecord(value)) return invalidProbe();
  const agentName = requiredString(value.agentName);
  const launcher = requiredString(value.launcher);
  const missingDetail = requiredString(value.missingDetail);
  if (agentName !== runtime.packageId || !launcher || !missingDetail) return invalidProbe();
  return Object.freeze({ agentName, launcher, missingDetail });
}

export function buildDcodeManagedExecLaunchArgs(
  requestedCommandArgs: readonly string[],
): readonly string[] {
  const requested = commandArgs(requestedCommandArgs);
  if (!requested) return invalidProbe();
  const value = loadDeepAgentsCodeSpecificationsRuntime().module.buildDcodeManagedExecLaunchArgs([
    ...requested,
  ]);
  const built = commandArgs(value);
  if (!built) return invalidProbe();
  return built;
}
