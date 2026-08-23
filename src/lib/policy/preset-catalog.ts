// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import YAML from "yaml";

import { openRegularFileNoFollow } from "../adapters/fs/regular-file";
import {
  captureHarnessPackageText,
  captureHarnessPackageTextDirectory,
  type HarnessPackage,
  listHarnessPackages,
  resolveHarnessPackage,
} from "../harness/package-registry";
import { materializeLocalInferencePresetPorts } from "./preset-parsing";

export { PERSONAL_OPEN_INTERNET_PRESET_NAME } from "./tiers";

export const PRESETS_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "nemoclaw-blueprint",
  "policies",
  "presets",
);

const HARNESS_PRESETS_RELATIVE_DIR = "policies/presets";
const MAX_PRESET_FILE_BYTES = 10_000_000;

export type PresetInfo = {
  file: string;
  name: string;
  description: string;
};

function readPresetFile(file: string): string {
  const opened = openRegularFileNoFollow(file);
  try {
    return opened.readBytes(MAX_PRESET_FILE_BYTES).toString("utf8");
  } finally {
    opened.close();
  }
}

function presetInfo(file: string, content: string): PresetInfo {
  const document = YAML.parse(content) as unknown;
  const record =
    typeof document === "object" && document !== null && !Array.isArray(document)
      ? (document as Record<string, unknown>)
      : {};
  const preset =
    typeof record.preset === "object" && record.preset !== null && !Array.isArray(record.preset)
      ? (record.preset as Record<string, unknown>)
      : {};
  const expectedName = file.endsWith(".yaml") ? file.slice(0, -".yaml".length) : file;
  if (preset.name !== expectedName) {
    throw new Error(`Policy preset '${file}' must declare preset.name '${expectedName}'`);
  }
  return {
    file,
    name: expectedName,
    description: typeof preset.description === "string" ? preset.description.trim() : "",
  };
}

function listPresetFileNames(directory: string): string[] {
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Policy preset path must be a regular directory: ${directory}`);
  }
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith(".yaml"))
    .map((entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error(`Policy preset must be a regular file: ${file}`);
      }
      return entry.name;
    });
}

function listSharedPresets(): PresetInfo[] {
  return listPresetFileNames(PRESETS_DIR).map((file) =>
    presetInfo(file, readPresetFile(path.join(PRESETS_DIR, file))),
  );
}

function harnessPackagesWithPresets(agent: string | null | undefined): HarnessPackage[] {
  if (agent === undefined) return listHarnessPackages();
  const selectedAgent = agent?.trim().toLowerCase() || "openclaw";
  const harnessPackage = resolveHarnessPackage(selectedAgent);
  return harnessPackage ? [harnessPackage] : [];
}

function listHarnessPresets(harnessPackage: HarnessPackage): PresetInfo[] {
  const snapshot = captureHarnessPackageTextDirectory(
    harnessPackage,
    HARNESS_PRESETS_RELATIVE_DIR,
    ".yaml",
    MAX_PRESET_FILE_BYTES,
  );
  return [...snapshot.sources.entries()]
    .map(([relativePath, source]) => presetInfo(path.posix.basename(relativePath), source ?? ""))
    .sort((left, right) => left.file.localeCompare(right.file));
}

export function listNonMessagingPolicyPresets(agent: string | null | undefined): PresetInfo[] {
  return [...listSharedPresets(), ...harnessPackagesWithPresets(agent).flatMap(listHarnessPresets)];
}

/** Read a shared policy preset without selecting an agent runtime package. */
export function loadSharedPolicyPreset(
  name: string,
  options: { reportMissing?: boolean } = {},
): string | null {
  const file = path.resolve(PRESETS_DIR, `${name}.yaml`);
  if (!file.startsWith(PRESETS_DIR + path.sep) && file !== PRESETS_DIR) {
    console.error(`  Invalid preset name: ${name}`);
    return null;
  }
  if (!fs.existsSync(file)) {
    if (options.reportMissing !== false) console.error(`  Preset not found: ${name}`);
    return null;
  }
  const content = readPresetFile(file);
  presetInfo(path.basename(file), content);
  return name === "local-inference" ? materializeLocalInferencePresetPorts(content) : content;
}

function loadHarnessPolicyPreset(name: string, agent: string | null | undefined): string | null {
  const selectedAgent = agent?.trim().toLowerCase() || "openclaw";
  const harnessPackage = resolveHarnessPackage(selectedAgent);
  if (!harnessPackage) return null;
  const relativePath = `${HARNESS_PRESETS_RELATIVE_DIR}/${name}.yaml`;
  const source = captureHarnessPackageText(
    harnessPackage,
    relativePath,
    MAX_PRESET_FILE_BYTES,
  ).source;
  if (source !== null) presetInfo(path.posix.basename(relativePath), source);
  return source;
}

export function loadBuiltInPolicyPreset(
  name: string,
  agent: string | null | undefined,
): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) {
    console.error(`  Invalid preset name: ${name}`);
    return null;
  }
  const shared = loadSharedPolicyPreset(name, { reportMissing: false });
  const harness = loadHarnessPolicyPreset(name, agent);
  if (shared && harness) throw new Error(`Duplicate built-in policy preset '${name}'`);
  if (shared) return shared;
  if (harness) return harness;
  console.error(`  Preset not found: ${name}`);
  return null;
}

function policyMap(content: string): Record<string, unknown> {
  const policies = YAML.parse(content)?.network_policies;
  return policies && typeof policies === "object" && !Array.isArray(policies) ? policies : {};
}

/**
 * Return the first incoming key whose live value differs from the value that
 * the caller previously proved it owned. A null expected document owns no keys.
 */
export function findUnexpectedExistingPolicyKey(
  currentPolicy: string,
  presetEntries: string,
  expectedPolicyContent: string | null,
): string | null {
  const current = policyMap(currentPolicy);
  const incoming = policyMap(`network_policies:\n${presetEntries}`);
  const expected = expectedPolicyContent === null ? {} : policyMap(expectedPolicyContent);
  return (
    Object.keys(incoming).find((key) => {
      const currentHasKey = Object.prototype.hasOwnProperty.call(current, key);
      if (expectedPolicyContent === null) return currentHasKey;
      return (
        !currentHasKey ||
        !Object.prototype.hasOwnProperty.call(expected, key) ||
        !isDeepStrictEqual(current[key], expected[key])
      );
    }) ?? null
  );
}
