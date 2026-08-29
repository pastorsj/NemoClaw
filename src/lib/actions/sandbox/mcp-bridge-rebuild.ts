// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../../agent/defs";
import type { McpBridgeEntry, SandboxEntry } from "../../state/registry";
import {
  rollbackScrubbedMcpAdapters,
  scrubManagedMcpAdapterOrThrow,
  type McpScrubbedAdapterEntry,
} from "./mcp-bridge-adapter-teardown";
import { McpBridgeError } from "./mcp-bridge-contracts";
import {
  cloneMcpBridgeEntry,
  discardSafeIncompleteMcpAdds,
  inspectExactMcpDestroyProvider,
} from "./mcp-bridge-destroy";
import {
  assertGeneratedPolicyMutationSafe,
  assertGeneratedPolicyRegistrationMutationSafe,
  removeGeneratedPolicy,
} from "./mcp-bridge-policy";
import {
  assertMcpProviderRecoverable,
  assertNoProviderCredentialCollisions,
  assertNoRegisteredProviderCredentialCollisions,
  detachProvider,
  preflightMcpEntryTargets,
  waitForDetachedMcpCredential,
} from "./mcp-bridge-provider";
import { restoreExistingMcpBridgeRuntime } from "./mcp-bridge-restart";
import {
  assertMcpAdapterConfigMutationsAllowed,
  assertMcpAdapterTeardownRuntimeCapabilities,
} from "./mcp-bridge-runtime-capabilities";
import {
  assertMcpDestroyNotPending,
  bridgeState,
  ensureSandboxGatewaySelected,
  getBridgeAdapter,
  getSandboxAgent,
  getSandboxOrThrow,
  setBridgeState,
} from "./mcp-bridge-state";
import { assertAuthenticatedBridgeEntry, validateSandboxName } from "./mcp-bridge-validation";

export interface McpRebuildPreparation {
  entries: McpBridgeEntry[];
  detachedProviderEntries: McpBridgeEntry[];
  scrubbedAdapterEntries: McpScrubbedAdapterEntry[];
  /** Full read-only target, policy, provider, and registry proof before delete. */
  revalidateBeforeDelete?: () => Promise<void>;
  /** Final synchronous registry-only proof immediately before delete. */
  assertDeleteEdgeUnchanged?: () => void;
}

export type McpRebuildAgentOptions = {
  /** Definition pinned by rebuild preflight. Ordinary MCP commands omit it. */
  agentDefinition?: AgentDefinition;
};

export { prepareMcpBridgesForExecUnavailableRebuild } from "./mcp-bridge-rebuild-exec-unavailable";

async function getCompleteMcpRebuildEntries(
  sandboxName: string,
  options: McpRebuildAgentOptions & { sandboxAbsent?: boolean } = {},
): Promise<McpBridgeEntry[]> {
  validateSandboxName(sandboxName);
  const currentSandbox = getSandboxOrThrow(sandboxName);
  assertMcpDestroyNotPending(currentSandbox);
  const currentEntries = Object.values(bridgeState(currentSandbox)).map(cloneMcpBridgeEntry);
  assertEntriesMatchPinnedAgent(currentSandbox, currentEntries, options.agentDefinition);
  if (!options.sandboxAbsent) {
    const entriesRequiringExternalCleanup = currentEntries.filter(
      (entry) => entry.addState !== "prepared",
    );
    // This host-visible config preflight must precede
    // discardSafeIncompleteMcpAdds, which can remove an owned policy for a
    // providerless preflighted add. That cleanup has no adapter/provider to
    // probe; complete entries get the teardown runtime probe below.
    assertMcpAdapterConfigMutationsAllowed(
      sandboxName,
      currentSandbox,
      entriesRequiringExternalCleanup,
    );
  }
  const sandbox = await discardSafeIncompleteMcpAdds(sandboxName, currentSandbox, options);
  const entries = Object.values(bridgeState(sandbox)).map(cloneMcpBridgeEntry);
  assertEntriesMatchPinnedAgent(sandbox, entries, options.agentDefinition);
  const incompleteAdd = entries.find((entry) => entry.addState);
  if (incompleteAdd) {
    throw new McpBridgeError(
      `MCP server '${incompleteAdd.server}' has an incomplete add transaction (${incompleteAdd.addState}). Re-run the original mcp add command or remove it with --force before rebuilding the sandbox.`,
    );
  }
  return entries;
}

function assertEntriesMatchPinnedAgent(
  sandbox: SandboxEntry,
  entries: readonly McpBridgeEntry[],
  agentDefinition?: AgentDefinition,
): void {
  if (!agentDefinition || entries.length === 0) return;
  const agent = getSandboxAgent(sandbox, agentDefinition);
  const adapter = getBridgeAdapter(agent);
  const incompatible = entries.find(
    (entry) => entry.agent !== agent.name || entry.adapter !== adapter,
  );
  if (incompatible) {
    throw new McpBridgeError(
      `MCP server '${incompatible.server}' does not match the pinned '${agent.name}' agent and '${adapter}' adapter.`,
    );
  }
}

/**
 * Preserve MCP intent for stale-registry recovery after OpenShell has already
 * proved the sandbox absent. There is no sandbox process or retained adapter
 * to scrub, so this path validates targets and provider recoverability without
 * attempting sandbox exec or changing provider attachment state.
 */
export async function prepareMcpBridgesForAbsentSandboxRebuild(
  sandboxName: string,
  options: McpRebuildAgentOptions = {},
): Promise<McpRebuildPreparation> {
  const entries = await getCompleteMcpRebuildEntries(sandboxName, {
    ...options,
    sandboxAbsent: true,
  });
  if (entries.length === 0) {
    return {
      entries: [],
      detachedProviderEntries: [],
      scrubbedAdapterEntries: [],
    };
  }
  await preflightMcpEntryTargets(entries);
  await ensureSandboxGatewaySelected(sandboxName);
  for (const entry of entries) {
    assertGeneratedPolicyRegistrationMutationSafe(sandboxName, entry);
  }
  for (const entry of entries) assertMcpProviderRecoverable(entry);
  assertNoRegisteredProviderCredentialCollisions(entries);
  return {
    entries,
    detachedProviderEntries: [],
    scrubbedAdapterEntries: [],
  };
}

export async function prepareMcpBridgesForRebuild(
  sandboxName: string,
  options: McpRebuildAgentOptions = {},
): Promise<McpRebuildPreparation> {
  const entries = await getCompleteMcpRebuildEntries(sandboxName, options);
  if (entries.length === 0) {
    return {
      entries: [],
      detachedProviderEntries: [],
      scrubbedAdapterEntries: [],
    };
  }
  const sandbox = getSandboxOrThrow(sandboxName);
  await preflightMcpEntryTargets(entries);
  await ensureSandboxGatewaySelected(sandboxName);
  for (const entry of entries) assertGeneratedPolicyMutationSafe(sandboxName, entry);
  assertMcpAdapterTeardownRuntimeCapabilities(sandboxName, sandbox, entries);
  for (const entry of entries) assertMcpProviderRecoverable(entry);
  assertNoProviderCredentialCollisions(sandboxName, entries);
  const detached: McpBridgeEntry[] = [];
  const scrubbedAdapters: McpScrubbedAdapterEntry[] = [];
  const removedPolicies: McpBridgeEntry[] = [];
  try {
    for (const entry of entries) {
      // `/sandbox` may be a retained PVC. Scrub before delete so a replacement
      // Hermes/agent cannot boot with a stale placeholder while its provider
      // is intentionally detached during recreate.
      scrubbedAdapters.push(
        scrubManagedMcpAdapterOrThrow(sandboxName, sandbox, entry, options.agentDefinition),
      );
    }
    for (const entry of entries) {
      // The same-name replacement journal fingerprints this source row before
      // MCP teardown. Keep exact generated-policy ownership in that preserved
      // row while removing only the live policy; inner onboarding excludes the
      // generated name and post-rebuild restoration reuses this ownership.
      removeGeneratedPolicy(sandboxName, entry, { preserveRegistryOwnership: true });
      removedPolicies.push(entry);
    }
    for (const entry of entries) {
      // Keep the provider and its host-only credentials for the replacement
      // sandbox, but detach it before OpenShell deletes the old attachment.
      inspectExactMcpDestroyProvider(entry, { allowMissing: false });
      const detachOutcome = detachProvider(sandboxName, entry);
      if (detachOutcome === "unknown") {
        throw new McpBridgeError(
          `Could not prove provider detach for MCP server '${entry.server}'.`,
        );
      }
      waitForDetachedMcpCredential(sandboxName, entry);
      // A binding already absent on retry was still detached by this rebuild
      // transaction (possibly before a prior process died), so it must be
      // reattached if sandbox deletion later aborts.
      detached.push(entry);
    }
  } catch (error) {
    const rollbackFailures: string[] = [];
    let runtimeRestored = false;
    if (removedPolicies.length > 0) {
      try {
        await restoreExistingMcpBridgeRuntime(sandboxName, removedPolicies, {
          agentDefinition: options.agentDefinition,
          lifecyclePhase: "teardown-rollback",
        });
        runtimeRestored = true;
      } catch (rollbackError) {
        rollbackFailures.push(
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        );
      }
    }
    if (!runtimeRestored) {
      rollbackFailures.push(
        ...rollbackScrubbedMcpAdapters(
          sandboxName,
          sandbox,
          scrubbedAdapters,
          options.agentDefinition,
        ),
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new McpBridgeError(
      rollbackFailures.length > 0
        ? `${detail}\nMCP rebuild rollback could not reattach: ${rollbackFailures.join("; ")}`
        : detail,
    );
  }
  return {
    entries,
    detachedProviderEntries: detached,
    scrubbedAdapterEntries: scrubbedAdapters,
  };
}

export async function reattachMcpProvidersAfterRebuildAbort(
  sandboxName: string,
  entries: readonly McpBridgeEntry[],
  scrubbedAdapterEntries: readonly McpScrubbedAdapterEntry[] = [],
  options: McpRebuildAgentOptions = {},
): Promise<void> {
  if (entries.length === 0 && scrubbedAdapterEntries.length === 0) return;
  const sandbox = getSandboxOrThrow(sandboxName);
  assertEntriesMatchPinnedAgent(
    sandbox,
    [...entries, ...scrubbedAdapterEntries],
    options.agentDefinition,
  );
  await ensureSandboxGatewaySelected(sandboxName);
  assertMcpAdapterTeardownRuntimeCapabilities(sandboxName, sandbox, [
    ...entries,
    ...scrubbedAdapterEntries,
  ]);

  const failures: string[] = [];
  let runtimeRestored = false;
  if (entries.length > 0) {
    try {
      await restoreExistingMcpBridgeRuntime(sandboxName, entries, {
        agentDefinition: options.agentDefinition,
        lifecyclePhase: "teardown-rollback",
      });
      runtimeRestored = true;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (!runtimeRestored) {
    failures.push(
      ...rollbackScrubbedMcpAdapters(
        sandboxName,
        sandbox,
        scrubbedAdapterEntries,
        options.agentDefinition,
      ),
    );
  }
  if (failures.length > 0) {
    throw new McpBridgeError(failures.join("; "));
  }
}

export async function restoreMcpBridgesAfterRebuild(
  sandboxName: string,
  entries: readonly McpBridgeEntry[],
  options: McpRebuildAgentOptions = {},
): Promise<void> {
  if (entries.length === 0) return;
  for (const entry of entries) assertAuthenticatedBridgeEntry(entry);
  const sandbox = getSandboxOrThrow(sandboxName);
  assertEntriesMatchPinnedAgent(sandbox, entries, options.agentDefinition);
  const bridges = Object.fromEntries(
    entries.map((entry) => [entry.server, cloneMcpBridgeEntry(entry)]),
  );
  // Persist the recovery contract before touching the gateway. If refresh
  // fails, `mcp restart` remains retryable after the operator fixes the cause.
  setBridgeState(sandboxName, bridges);
  await restoreExistingMcpBridgeRuntime(sandboxName, entries, {
    agentDefinition: options.agentDefinition,
  });
}
