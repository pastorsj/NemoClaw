// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadHarnessCommonJsModule, resolveHarnessPackage } from "../harness/commonjs-runtime";

export type HermesBaseImageQualificationProbe = Readonly<{
  args: readonly string[];
  expectedOutput: string;
}>;

type HermesBaseImageQualificationRuntime = {
  createHermesBaseImageQualificationProbe(imageRef: string): unknown;
  hermesFinalBaseAcceptsResolution(input: {
    imageRef: string;
    pinnedRemoteRef?: string;
    source?: string;
    trackedPinnedRemoteRef: string;
  }): unknown;
  isHermesOfficialBaseDigestRef(imageRef: string): unknown;
  isHermesRepositoryBaseRef(imageRef: string): unknown;
  parseHermesPinnedRemoteBaseRef(dockerfile: string): unknown;
};

let cachedRuntime: {
  selectionKey: string;
  packageRoot: string;
  module: HermesBaseImageQualificationRuntime;
} | null = null;

function loadHermesBaseImageQualificationRuntime(): HermesBaseImageQualificationRuntime {
  const selectionKey = process.env.HOME?.trim() || "<default-home>";
  // A command captures verified helper bytes once. Harness installation takes effect in the next process.
  if (cachedRuntime?.selectionKey === selectionKey) return cachedRuntime.module;
  const harnessPackage = resolveHarnessPackage("hermes");
  if (!harnessPackage) throw new Error("Hermes harness package is unavailable.");
  const loaded = loadHarnessCommonJsModule(
    harnessPackage,
    "host/base-qualification.cts",
    64 * 1024,
  );
  const runtime = loaded.exports as Partial<HermesBaseImageQualificationRuntime>;
  if (
    typeof runtime.createHermesBaseImageQualificationProbe !== "function" ||
    typeof runtime.hermesFinalBaseAcceptsResolution !== "function" ||
    typeof runtime.isHermesOfficialBaseDigestRef !== "function" ||
    typeof runtime.isHermesRepositoryBaseRef !== "function" ||
    typeof runtime.parseHermesPinnedRemoteBaseRef !== "function"
  ) {
    throw new Error("Hermes harness base-image qualification module has an invalid contract.");
  }
  cachedRuntime = {
    selectionKey,
    packageRoot: harnessPackage.rootDir,
    module: runtime as HermesBaseImageQualificationRuntime,
  };
  return cachedRuntime.module;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function qualificationArgs(value: unknown): readonly string[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 64 ||
    !value.every(
      (entry) => typeof entry === "string" && entry.length <= 64 * 1024 && !entry.includes("\0"),
    )
  ) {
    return null;
  }
  return Object.freeze([...value]);
}

export function createHermesBaseImageQualificationProbe(
  imageRef: string,
): HermesBaseImageQualificationProbe {
  const value =
    loadHermesBaseImageQualificationRuntime().createHermesBaseImageQualificationProbe(imageRef);
  if (!isRecord(value)) {
    throw new Error("Hermes harness base-image qualification module returned an invalid probe.");
  }
  const args = qualificationArgs(value.args);
  const expectedOutput = value.expectedOutput;
  if (
    !args ||
    typeof expectedOutput !== "string" ||
    expectedOutput.length === 0 ||
    expectedOutput.length > 1024 ||
    /[\0\r\n]/u.test(expectedOutput)
  ) {
    throw new Error("Hermes harness base-image qualification module returned an invalid probe.");
  }
  return Object.freeze({ args, expectedOutput });
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new Error("Hermes harness base-image qualification module returned an invalid result.");
  }
  return value;
}

export function parseHermesPinnedRemoteBaseRef(dockerfile: string): string | null {
  const value =
    loadHermesBaseImageQualificationRuntime().parseHermesPinnedRemoteBaseRef(dockerfile);
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw new Error("Hermes harness base-image qualification module returned an invalid result.");
  }
  return value;
}

export function isHermesOfficialBaseDigestRef(imageRef: string): boolean {
  return requireBoolean(
    loadHermesBaseImageQualificationRuntime().isHermesOfficialBaseDigestRef(imageRef),
  );
}

export function isHermesRepositoryBaseRef(imageRef: string): boolean {
  return requireBoolean(
    loadHermesBaseImageQualificationRuntime().isHermesRepositoryBaseRef(imageRef),
  );
}

export function hermesFinalBaseAcceptsResolution(input: {
  imageRef: string;
  pinnedRemoteRef?: string;
  source?: string;
  trackedPinnedRemoteRef: string;
}): boolean {
  return requireBoolean(
    loadHermesBaseImageQualificationRuntime().hermesFinalBaseAcceptsResolution({ ...input }),
  );
}
