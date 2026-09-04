// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition, AgentMcpAdapter } from "../../agent/defs";
import type { McpBridgeEntry } from "../../state/registry";
import {
  assertDeepAgentsMcpMutationRuntimeCapability,
  inspectDeepAgentsAdapterRegistration,
} from "./mcp-bridge-adapter-deepagents";
import {
  assertHermesMcpMutationRuntimeCapability,
  inspectHermesAdapterRegistration,
} from "./mcp-bridge-adapter-hermes";
import type {
  AdapterMutationOptions,
  AdapterRegistrationInspection,
  AdapterRemovalOutcome,
} from "./mcp-bridge-adapter-inspection";
import { inspectAdapterRegistrationCommand } from "./mcp-bridge-adapter-inspection";
import { McpBridgeError } from "./mcp-bridge-contracts";
import { inspectOpenClawAdapterRegistration } from "./mcp-bridge-adapter-openclaw";
import { openClawMcporterRoot } from "./mcp-bridge-adapter-status";
import {
  assertHermesMcpRuntimeIntent,
  inspectHermesMcpRuntimeIntent,
} from "./mcp-bridge-hermes-reconciliation";
import {
  mcpAdapterCredentialRevisionUnavailableError,
  mcpAdapterCredentialRevisionUnstableError,
  type McpAttachedCredentialRevision,
  observeMcpCredentialRevision,
} from "./mcp-bridge-provider-readiness";
import {
  bridgeState,
  getAgentConfigDir,
  getSandboxHarnessPackage,
  getSandboxOrThrow,
} from "./mcp-bridge-state";
import {
  getMcpProviderInspectionRuntimeSelection,
  type McpProviderInspectionRuntimeSelection,
} from "./mcp-bridge-provider-inspection";
import { waitForMcpBridgeCondition } from "./mcp-bridge/timing";
import {
  buildInstalledMcpInspectionCommand,
  describeInstalledMcpMutationCapability,
  describeInstalledMcpRuntimeIntentVerification,
  describeInstalledMcpTeardownCapability,
} from "./mcp-bridge/package-command";
import { assertInstalledMcpCapability } from "./mcp-bridge/package-probe";
import {
  registerInstalledMcpAdapter,
  unregisterInstalledMcpAdapter,
} from "./mcp-bridge/package-mutation";
import { registerLegacyMcpAdapter, unregisterLegacyMcpAdapter } from "./mcp-bridge/legacy-mutation";

const STABLE_CREDENTIAL_REVISION_OBSERVATIONS = 3;
const MAX_CREDENTIAL_REVISION_REGISTRATIONS = 2;

function assertPinnedDefinitionMatchesEntry(
  adapter: AgentMcpAdapter,
  entry: McpBridgeEntry,
  agentDefinition: AgentDefinition | undefined,
): void {
  if (!agentDefinition) return;
  const agent = agentDefinition;
  if (entry.agent !== agent.name) {
    throw new McpBridgeError(
      `MCP server '${entry.server}' records agent '${entry.agent}', not the pinned '${agent.name}' definition.`,
    );
  }
  const pinnedAdapter = agent.mcpCapability.adapter;
  if (agent.mcpCapability.support !== "bridge" || !pinnedAdapter) {
    throw new McpBridgeError(
      `Pinned agent '${agent.name}' does not declare a managed MCP adapter.`,
    );
  }
  if (adapter !== pinnedAdapter || entry.adapter !== pinnedAdapter) {
    throw new McpBridgeError(
      `MCP server '${entry.server}' does not match the pinned '${pinnedAdapter}' adapter.`,
    );
  }
}

export {
  buildDeepAgentsMcpRegisterCommand,
  buildDeepAgentsMcpRemoveCommand,
} from "./mcp-bridge-adapter-deepagents";
export {
  buildHermesMcpExecArgs,
  buildHermesMcpProbeCommand,
  buildHermesMcpRegisterCommand,
} from "./mcp-bridge-adapter-hermes";
export {
  type AdapterRegistrationInspection,
  parseAdapterRegistrationInspection,
} from "./mcp-bridge-adapter-inspection";
export {
  buildOpenClawMcporterRegisterCommand,
  buildOpenClawMcporterRemoveCommand,
  MCPORTER_VERSION,
} from "./mcp-bridge-adapter-openclaw";
export {
  buildDeepAgentsMcpStatusCommand,
  buildHermesMcpStatusCommand,
  buildOpenClawMcporterInspectCommand,
  DEFAULT_OPENCLAW_CONFIG_DIR,
  DEEPAGENTS_MCP_CONFIG_PATH,
  mcporterHeadersMatchExpected,
  openClawMcporterRoot,
} from "./mcp-bridge-adapter-status";

export function inspectAgentAdapterRegistration(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: McpBridgeEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  agentDefinition?: AgentDefinition,
): AdapterRegistrationInspection {
  assertPinnedDefinitionMatchesEntry(adapter, entry, agentDefinition);
  const configDirectory =
    agentDefinition?.configPaths.dir ??
    getAgentConfigDir(entry.agent, undefined, getSandboxOrThrow(sandboxName));
  const installedCommand = buildInstalledMcpInspectionCommand(sandboxName, adapter, entry, {
    configDirectory,
  });
  if (installedCommand !== null) {
    return inspectAdapterRegistrationCommand(
      sandboxName,
      entry,
      installedCommand,
      runtimeSelection,
    );
  }
  switch (adapter) {
    case "mcporter":
      return inspectOpenClawAdapterRegistration(
        sandboxName,
        entry,
        runtimeSelection,
        configDirectory,
      );
    case "hermes-config":
      return inspectHermesAdapterRegistration(sandboxName, entry, runtimeSelection);
    case "deepagents-config":
      return inspectDeepAgentsAdapterRegistration(sandboxName, entry, runtimeSelection);
  }
  throw new McpBridgeError(`MCP adapter '${adapter}' is not installed.`);
}

export function assertAgentMcpMutationRuntimeCapability(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): void {
  const harnessPackage = getSandboxHarnessPackage(sandboxName);
  if (harnessPackage) {
    const probe = describeInstalledMcpMutationCapability(sandboxName, adapter, harnessPackage.id);
    if (!probe) {
      throw new McpBridgeError(
        `Installed MCP adapter '${adapter}' for sandbox '${sandboxName}' is unavailable.`,
      );
    }
    assertInstalledMcpCapability(sandboxName, probe, runtimeSelection);
    return;
  }
  switch (adapter) {
    case "deepagents-config":
      assertDeepAgentsMcpMutationRuntimeCapability(sandboxName, runtimeSelection);
      return;
    case "hermes-config":
      assertHermesMcpMutationRuntimeCapability(sandboxName, runtimeSelection);
      return;
    case "mcporter":
      return;
  }
  throw new McpBridgeError(`MCP adapter '${adapter}' is not installed.`);
}

/**
 * Validate the runtime needed to scrub an existing adapter definition.
 * Hermes teardown still uses its managed transaction helper and therefore
 * requires the full helper/lifecycle probe. Deep Agents teardown executes the
 * ownership-checked config scrub directly and must remain available to images
 * that predate the new launcher marker.
 */
export function assertAgentMcpTeardownRuntimeCapability(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): void {
  const harnessPackage = getSandboxHarnessPackage(sandboxName);
  if (harnessPackage) {
    const probe = describeInstalledMcpTeardownCapability(sandboxName, adapter, harnessPackage.id);
    if (!probe) {
      throw new McpBridgeError(
        `Installed MCP adapter '${adapter}' for sandbox '${sandboxName}' is unavailable.`,
      );
    }
    assertInstalledMcpCapability(sandboxName, probe, runtimeSelection);
    return;
  }
  if (adapter === "hermes-config") {
    assertAgentMcpMutationRuntimeCapability(sandboxName, adapter, runtimeSelection);
  }
}

export interface AgentMcpRuntimeIntentOptions {
  readonly entries?: readonly McpBridgeEntry[];
  readonly managedServerNames?: readonly string[];
  readonly credentialRevisions?: ReadonlyMap<string, McpAttachedCredentialRevision>;
  readonly runtimeSelection?: McpProviderInspectionRuntimeSelection;
}

export type AgentMcpRuntimeIntentInspection =
  | { ok: true; state: "matched" | "not-applicable" }
  | { ok: false; state: "mismatch" | "error"; detail: string };

function resolveRuntimeIntentState(sandboxName: string, options: AgentMcpRuntimeIntentOptions) {
  const sandbox = getSandboxOrThrow(sandboxName);
  const entries = options.entries ? [...options.entries] : Object.values(bridgeState(sandbox));
  const managedServerNames = [
    ...new Set(
      options.managedServerNames ??
        sandbox.mcp?.managedServerNames ??
        entries.map((entry) => entry.server),
    ),
  ];
  return { sandbox, entries, managedServerNames };
}

/** Inspect complete runtime intent without selecting a harness implementation in core. */
export function inspectAgentMcpRuntimeIntent(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  options: AgentMcpRuntimeIntentOptions = {},
): AgentMcpRuntimeIntentInspection | undefined {
  const { sandbox, entries, managedServerNames } = resolveRuntimeIntentState(sandboxName, options);
  const harnessPackage = getSandboxHarnessPackage(sandboxName);
  if (harnessPackage) {
    const incompatible = entries.find(
      (entry) => entry.agent !== harnessPackage.id || entry.adapter !== adapter,
    );
    if (incompatible) {
      throw new McpBridgeError(
        `MCP server '${incompatible.server}' does not match the installed package runtime intent.`,
      );
    }
    const verification = describeInstalledMcpRuntimeIntentVerification(
      sandboxName,
      adapter,
      harnessPackage.id,
      entries,
      managedServerNames,
      options.credentialRevisions,
    );
    if (!verification) {
      throw new McpBridgeError(
        `Installed MCP adapter '${adapter}' for sandbox '${sandboxName}' is unavailable.`,
      );
    }
    if (verification.kind === "not-required") return undefined;
    try {
      assertInstalledMcpCapability(
        sandboxName,
        verification,
        options.runtimeSelection ?? getMcpProviderInspectionRuntimeSelection(sandbox),
      );
      return { ok: true, state: "matched" };
    } catch (error) {
      return {
        ok: false,
        state: "error",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
  if (adapter === "hermes-config" || entries.some((entry) => entry.adapter === "hermes-config")) {
    return inspectHermesMcpRuntimeIntent(sandboxName, {
      entries,
      managedServerNames,
      ...(options.credentialRevisions ? { credentialRevisions: options.credentialRevisions } : {}),
      ...(options.runtimeSelection ? { runtimeSelection: options.runtimeSelection } : {}),
    });
  }
  return undefined;
}

/** Verify complete package-owned runtime intent, retaining Hermes logic only for legacy state. */
export function assertAgentMcpRuntimeIntent(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  options: AgentMcpRuntimeIntentOptions = {},
): void {
  const harnessPackage = getSandboxHarnessPackage(sandboxName);
  if (!harnessPackage) {
    const { entries, managedServerNames } = resolveRuntimeIntentState(sandboxName, options);
    if (adapter === "hermes-config" || entries.some((entry) => entry.adapter === "hermes-config")) {
      assertHermesMcpRuntimeIntent(sandboxName, {
        entries,
        managedServerNames,
        ...(options.runtimeSelection ? { runtimeSelection: options.runtimeSelection } : {}),
      });
    }
    return;
  }
  const inspection = inspectAgentMcpRuntimeIntent(sandboxName, adapter, options);
  if (!inspection || inspection.ok) return;
  throw new McpBridgeError(inspection.detail);
}

export function registerAgentAdapter(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: McpBridgeEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  envValues: Record<string, string> = {},
  options: {
    replaceExisting?: boolean;
    teardownRollback?: boolean;
    credentialRevision?: McpAttachedCredentialRevision;
  } = {},
  agentDefinition?: AgentDefinition,
): void {
  assertPinnedDefinitionMatchesEntry(adapter, entry, agentDefinition);
  if (getSandboxHarnessPackage(sandboxName)) {
    registerInstalledMcpAdapter(sandboxName, adapter, entry, runtimeSelection, envValues, {
      ...options,
      configDirectory:
        agentDefinition?.configPaths.dir ??
        getAgentConfigDir(entry.agent, undefined, getSandboxOrThrow(sandboxName)),
    });
    return;
  }
  registerLegacyMcpAdapter(
    sandboxName,
    adapter,
    entry,
    runtimeSelection,
    envValues,
    options,
    agentDefinition,
  );
}

/** Register one adapter and converge it on the credential revision exposed by fresh execs. */
export function registerAgentAdapterAtCurrentCredentialRevision(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: McpBridgeEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  envValues: Record<string, string>,
  initialCredentialRevision: McpAttachedCredentialRevision,
  options: { replaceExisting?: boolean; teardownRollback?: boolean } = {},
  agentDefinition?: AgentDefinition,
): McpAttachedCredentialRevision {
  const timeoutSeconds = Number.parseInt(
    process.env.NEMOCLAW_MCP_PROVIDER_SYNC_TIMEOUT_SECONDS ?? "30",
    10,
  );
  let credentialRevision = initialCredentialRevision;
  let replaceExisting = options.replaceExisting === true;
  for (
    let registration = 1;
    registration <= MAX_CREDENTIAL_REVISION_REGISTRATIONS;
    registration += 1
  ) {
    const registrationOptions = {
      replaceExisting,
      teardownRollback: options.teardownRollback === true,
      credentialRevision,
    };
    if (agentDefinition) {
      registerAgentAdapter(
        sandboxName,
        adapter,
        entry,
        runtimeSelection,
        envValues,
        registrationOptions,
        agentDefinition,
      );
    } else {
      registerAgentAdapter(
        sandboxName,
        adapter,
        entry,
        runtimeSelection,
        envValues,
        registrationOptions,
      );
    }
    let candidateRevision: McpAttachedCredentialRevision | undefined;
    let stableObservations = 0;
    let observedRevision: McpAttachedCredentialRevision | undefined;
    const stable = waitForMcpBridgeCondition(
      () => {
        const observation = observeMcpCredentialRevision(sandboxName, entry, runtimeSelection);
        if (observation === "absent" || observation === "canonical") {
          throw mcpAdapterCredentialRevisionUnavailableError(entry.server);
        }
        if (candidateRevision !== observation) {
          candidateRevision = observation;
          stableObservations = 1;
          return false;
        }
        stableObservations += 1;
        if (stableObservations < STABLE_CREDENTIAL_REVISION_OBSERVATIONS) {
          return false;
        }
        observedRevision = observation;
        return true;
      },
      Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 30,
      1_000,
    );
    if (!stable || observedRevision === undefined) {
      throw mcpAdapterCredentialRevisionUnstableError(entry.server);
    }
    if (observedRevision === credentialRevision) {
      return credentialRevision;
    }
    if (registration === MAX_CREDENTIAL_REVISION_REGISTRATIONS) {
      throw mcpAdapterCredentialRevisionUnstableError(entry.server);
    }
    credentialRevision = observedRevision;
    replaceExisting = true;
  }
  throw mcpAdapterCredentialRevisionUnstableError(entry.server);
}

export function unregisterAgentAdapter(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: McpBridgeEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  options: AdapterMutationOptions = {},
  agentDefinition?: AgentDefinition,
): AdapterRemovalOutcome {
  assertPinnedDefinitionMatchesEntry(adapter, entry, agentDefinition);
  if (getSandboxHarnessPackage(sandboxName)) {
    return unregisterInstalledMcpAdapter(sandboxName, adapter, entry, runtimeSelection, {
      ...options,
      configDirectory:
        agentDefinition?.configPaths.dir ??
        getAgentConfigDir(entry.agent, undefined, getSandboxOrThrow(sandboxName)),
    });
  }
  return unregisterLegacyMcpAdapter(
    sandboxName,
    adapter,
    entry,
    runtimeSelection,
    options,
    agentDefinition,
  );
}
