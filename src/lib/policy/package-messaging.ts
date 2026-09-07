// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { TextDecoder } from "node:util";

import type { AgentDefinition } from "../agent/defs";
import {
  assertSourcePathAuthority,
  assertTreeAuthority,
  getPackageTreeAuthority,
  readVerifiedFile,
  validateHarnessPackageTree,
} from "../agent-runtime/package/tree";
import type { HarnessPackageIdentity } from "../agent-runtime/package/types";
import { isValidCliOpenShellProviderIdentifier } from "../adapters/openshell/provider-metadata-cli";
import { materializeMessagingChannelPolicyContent } from "../messaging/channels/policy";
import type { SandboxMessagingNetworkPolicyEntryPlan } from "../messaging/manifest";
import type { MessagingChannelConfig } from "../messaging-channel-config";
import { getCredentialBindingProviders } from "../onboard/initial-policy";
import type { PackagePolicyPreset } from "./preset-ownership";
import { isObjectRecord } from "../shared/object-record";

type PolicyMapping = Record<string, unknown>;
const MAX_PACKAGE_PRESET_BYTES = 1024 * 1024;
const POLICY_PRESET_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface ResolvedPackageMessagingPolicyEntry {
  readonly entry: SandboxMessagingNetworkPolicyEntryPlan;
  readonly content: string;
}

function packagePresetRelativePath(agent: AgentDefinition, presetName: string): string {
  if (!POLICY_PRESET_NAME_PATTERN.test(presetName)) {
    throw new Error("Harness package policy preset name is invalid");
  }
  const packageRoot = path.resolve(agent.packageRoot);
  const target = path.resolve(agent.agentDir, "policies", "presets", `${presetName}.yaml`);
  const nativeRelativePath = path.relative(packageRoot, target);
  if (
    nativeRelativePath.length === 0 ||
    path.isAbsolute(nativeRelativePath) ||
    nativeRelativePath === ".." ||
    nativeRelativePath.startsWith(`..${path.sep}`)
  ) {
    throw new Error("Harness package policy preset path escapes its package root");
  }
  return nativeRelativePath.split(path.sep).join("/");
}

/**
 * Read one policy asset only after binding the complete mutable package tree
 * to the durable receipt that selected it. The path and every parent are
 * rechecked around the read so a symlink or swap cannot redirect mutation
 * policy outside the installed package.
 */
export function loadReceiptBoundPackagePolicyPreset(input: {
  readonly agentDefinition: AgentDefinition;
  readonly harnessPackageIdentity: HarnessPackageIdentity;
  readonly presetName: string;
}): PackagePolicyPreset | null {
  const { agentDefinition, harnessPackageIdentity, presetName } = input;
  if (harnessPackageIdentity.id !== agentDefinition.name) {
    throw new Error("Harness package policy authority does not match its agent definition");
  }
  if (!agentDefinition.policyCapability.owned_presets.includes(presetName)) return null;

  let tree;
  try {
    tree = validateHarnessPackageTree(agentDefinition.packageRoot, { sourceTrust: "mutable" });
  } catch (error) {
    throw new Error("Harness package policy tree failed integrity validation", { cause: error });
  }
  if (tree.contentDigest !== harnessPackageIdentity.contentDigest) {
    throw new Error("Harness package policy tree does not match its installed receipt");
  }
  const authority = getPackageTreeAuthority(tree);
  const entriesByPath = new Map(
    authority.entries.map((entry) => [entry.relativePath, entry] as const),
  );
  const relativePath = packagePresetRelativePath(agentDefinition, presetName);
  const entry = entriesByPath.get(relativePath);
  if (!entry || entry.type !== "file" || entry.stat.size > BigInt(MAX_PACKAGE_PRESET_BYTES)) {
    throw new Error(
      `Harness package '${agentDefinition.name}' declares policy preset '${presetName}' but its package asset is unavailable`,
    );
  }

  let content: string;
  try {
    assertSourcePathAuthority(authority, entry, entriesByPath);
    content = UTF8_DECODER.decode(readVerifiedFile(entry, MAX_PACKAGE_PRESET_BYTES));
    assertSourcePathAuthority(authority, entry, entriesByPath);
    assertTreeAuthority(authority);
  } catch (error) {
    throw new Error(
      `Harness package '${agentDefinition.name}' policy preset '${presetName}' changed while reading`,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch {
    throw new Error(
      `Harness package '${agentDefinition.name}' policy preset '${presetName}' contains invalid YAML`,
    );
  }
  if (
    !isObjectRecord(parsed) ||
    !isObjectRecord(parsed.preset) ||
    !isObjectRecord(parsed.network_policies) ||
    parsed.preset.name !== presetName ||
    typeof parsed.preset.description !== "string"
  ) {
    throw new Error(
      `Harness package '${agentDefinition.name}' policy preset '${presetName}' metadata does not match its declaration`,
    );
  }
  return Object.freeze({
    file: path.posix.basename(relativePath),
    name: presetName,
    description: parsed.preset.description,
    content,
  });
}

/**
 * Validate every non-secret provider reference before package policy can be
 * displayed or applied. Diagnostics intentionally do not echo rejected package
 * text, so control characters cannot reach an operator terminal.
 */
export function requireAuthorizedPackageMessagingPolicyProviders(
  policyDocuments: readonly string[],
  allowedProviderNames: ReadonlySet<string>,
): void {
  for (const policyDocument of policyDocuments) {
    for (const providerName of getCredentialBindingProviders(policyDocument)) {
      if (!isValidCliOpenShellProviderIdentifier(providerName)) {
        throw new Error("Package messaging policy contains an invalid credential provider name");
      }
      if (!allowedProviderNames.has(providerName)) {
        throw new Error(
          "Package messaging policy references a credential provider outside its typed package plan",
        );
      }
    }
  }
}

function policyMapping(value: unknown, label: string): PolicyMapping {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping`);
  }
  return value as PolicyMapping;
}

function withoutCredentialBindings(networkPolicies: PolicyMapping): PolicyMapping {
  const unbound = structuredClone(networkPolicies);
  for (const policy of Object.values(unbound)) {
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) continue;
    const endpoints = (policy as PolicyMapping).endpoints;
    if (!Array.isArray(endpoints)) continue;
    for (const endpoint of endpoints) {
      if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) continue;
      delete (endpoint as PolicyMapping).credential_binding;
    }
  }
  return unbound;
}

/**
 * Resolve only the policy keys named by a compiled messaging plan from one
 * exact package definition. Package ownership is mandatory: this path never
 * consults legacy channel or central preset locations.
 */
export function resolvePackageMessagingPolicyEntries(input: {
  readonly agentDefinition: AgentDefinition;
  readonly entries: readonly SandboxMessagingNetworkPolicyEntryPlan[];
  readonly harnessPackageIdentity: HarnessPackageIdentity;
  readonly includeCredentialBindings: boolean;
  readonly messagingConfig?: MessagingChannelConfig | null;
  readonly sandboxName: string;
}): readonly ResolvedPackageMessagingPolicyEntry[] {
  const loadedPresets = new Map<string, string>();

  const resolvedEntries = input.entries.map((entry) => {
    let packageContent = loadedPresets.get(entry.presetName);
    if (packageContent === undefined) {
      const preset = loadReceiptBoundPackagePolicyPreset({
        agentDefinition: input.agentDefinition,
        harnessPackageIdentity: input.harnessPackageIdentity,
        presetName: entry.presetName,
      });
      if (!preset) {
        throw new Error(
          `Harness package '${input.agentDefinition.name}' does not own required messaging policy preset '${entry.presetName}'`,
        );
      }
      packageContent = preset.content;
      loadedPresets.set(entry.presetName, packageContent);
    }

    const materialized = materializeMessagingChannelPolicyContent(packageContent, entry.channelId, {
      sandboxName: input.sandboxName,
      messagingConfig: input.messagingConfig,
      policyKeys: entry.policyKeys,
    });
    if (materialized === null) {
      throw new Error(
        `Harness package '${input.agentDefinition.name}' messaging policy preset '${entry.presetName}' could not be materialized`,
      );
    }

    let document: PolicyMapping;
    try {
      document = policyMapping(
        YAML.parse(materialized),
        `Harness package '${input.agentDefinition.name}' messaging policy preset '${entry.presetName}'`,
      );
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
    const networkPolicies = policyMapping(
      document.network_policies,
      `Harness package '${input.agentDefinition.name}' messaging policy preset '${entry.presetName}' network_policies`,
    );
    if (entry.policyKeys.length === 0) {
      throw new Error(
        `Harness package '${input.agentDefinition.name}' messaging policy preset '${entry.presetName}' declares no network policy keys`,
      );
    }
    const selectedPolicies: PolicyMapping = {};
    for (const key of entry.policyKeys) {
      if (!Object.hasOwn(networkPolicies, key)) {
        throw new Error(
          `Harness package '${input.agentDefinition.name}' messaging policy preset '${entry.presetName}' does not provide declared network policy key '${key}'`,
        );
      }
      selectedPolicies[key] = networkPolicies[key];
    }

    return Object.freeze({
      entry,
      content: YAML.stringify({
        ...(document.preset === undefined ? {} : { preset: document.preset }),
        network_policies: input.includeCredentialBindings
          ? selectedPolicies
          : withoutCredentialBindings(selectedPolicies),
      }),
    });
  });

  const selectedValues = new Map<string, unknown>();
  for (const resolved of resolvedEntries) {
    const document = policyMapping(YAML.parse(resolved.content), "Resolved package policy");
    const networkPolicies = policyMapping(
      document.network_policies,
      "Resolved package policy network_policies",
    );
    for (const [key, value] of Object.entries(networkPolicies)) {
      if (selectedValues.has(key) && !isDeepStrictEqual(selectedValues.get(key), value)) {
        throw new Error(
          `Harness package '${input.agentDefinition.name}' provides conflicting messaging policy sources for key '${key}'`,
        );
      }
      selectedValues.set(key, value);
    }
  }
  return resolvedEntries;
}
