// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import path from "node:path";

import YAML from "yaml";

import { openRegularFileNoFollow } from "../adapters/fs/regular-file";
import type { AgentDefinition } from "../agent/defs";
import { isObjectRecord } from "../shared/object-record";

export { PERSONAL_OPEN_INTERNET_PRESET_NAME } from "./tiers";

const MAX_PACKAGE_PRESET_BYTES = 1024 * 1024;
const POLICY_PRESET_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

export interface PackagePolicyPreset {
  readonly file: string;
  readonly name: string;
  readonly description: string;
  readonly content: string;
}

function packagePresetPath(agent: AgentDefinition, presetName: string): string {
  if (!POLICY_PRESET_NAME_PATTERN.test(presetName)) {
    throw new Error(`Package policy preset name is invalid: ${presetName}`);
  }
  return path.join(agent.agentDir, "policies", "presets", `${presetName}.yaml`);
}

/** Read one convention-based policy asset from the exact package definition. */
export function loadPackagePolicyPreset(
  agent: AgentDefinition,
  presetName: string,
): PackagePolicyPreset | null {
  if (!agent.policyCapability.owned_presets.includes(presetName)) return null;

  const file = packagePresetPath(agent, presetName);
  let opened: ReturnType<typeof openRegularFileNoFollow>;
  try {
    opened = openRegularFileNoFollow(file);
  } catch {
    throw new Error(
      `Harness package '${agent.name}' declares policy preset '${presetName}' but its package asset is unavailable`,
    );
  }

  let content: string;
  try {
    content = opened.readBytes(MAX_PACKAGE_PRESET_BYTES).toString("utf8");
  } catch {
    throw new Error(
      `Harness package '${agent.name}' policy preset '${presetName}' exceeds its read boundary or changed while reading`,
    );
  } finally {
    opened.close();
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch {
    throw new Error(
      `Harness package '${agent.name}' policy preset '${presetName}' contains invalid YAML`,
    );
  }
  if (
    !isObjectRecord(parsed) ||
    !isObjectRecord(parsed.preset) ||
    !isObjectRecord(parsed.network_policies)
  ) {
    throw new Error(
      `Harness package '${agent.name}' policy preset '${presetName}' must contain preset metadata and network_policies`,
    );
  }
  const declaredName = parsed.preset.name;
  const description = parsed.preset.description;
  if (declaredName !== presetName || typeof description !== "string") {
    throw new Error(
      `Harness package '${agent.name}' policy preset '${presetName}' metadata does not match its declared name`,
    );
  }

  return Object.freeze({ file: path.basename(file), name: presetName, description, content });
}

/** Enumerate package policy assets in manifest order, failing closed on missing declarations. */
export function listPackagePolicyPresets(agent: AgentDefinition): PackagePolicyPreset[] {
  return agent.policyCapability.owned_presets.map((name) => {
    const preset = loadPackagePolicyPreset(agent, name);
    if (!preset) {
      throw new Error(`Harness package '${agent.name}' policy preset '${name}' is unavailable`);
    }
    return preset;
  });
}

function policyMap(content: string): Record<string, unknown> {
  const policies = YAML.parse(content)?.network_policies;
  return policies && typeof policies === "object" && !Array.isArray(policies) ? policies : {};
}

/**
 * Return the first incoming key whose live value is not exactly the value the
 * caller previously proved it owned. A null expected document owns no keys.
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
