// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseHarnessPackageIdentity } from "../../agent-runtime/package/identity-validation";
import { reportsExactProviderNotFound } from "../../adapters/openshell/provider-diagnostic-cli";
import { parseStrictOpenShellSandboxListJson } from "../../adapters/openshell/sandbox-identity";
import { getHarnessPackageStoreRootForEnvironment } from "../../agent-runtime/package/pinned";
import type { HarnessPackageIdentity } from "../../agent-runtime/package/types";
import {
  prepareManagedAgentStateVolumeCleanup,
  removePreparedManagedAgentStateVolumes,
  type ManagedAgentStateVolumeContext,
  type PreparedManagedAgentStateVolumeCleanup,
} from "../../onboard/managed-workload/agent-state-volume";
import { normalizeRuntimeProviderIdentity } from "../../onboard/runtime-provider/access";
import { CURRENT_RUNTIME_PROVIDER_BUNDLES } from "../../onboard/runtime-provider/current";
import type { RuntimeProviderBundleRegistry } from "../../onboard/runtime-provider/contract";
import type { GatewayRegistryEntry } from "../../state/gateway-registry";

export type ReceiptSandboxDestroyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly exitCode: number };

type OpenShellInspectionRuntime = {
  readonly env: NodeJS.ProcessEnv;
  run(
    command: string,
    args: string[],
    options: { readonly env: NodeJS.ProcessEnv; readonly stdio: ["ignore", "pipe", "pipe"] },
  ): { readonly status: number | null; readonly stdout: string; readonly stderr: string };
};

/** Confirm that the selected OpenShell gateway reports no sandbox rows. */
export function allOpenShellSandboxesAreAbsent(runtime: OpenShellInspectionRuntime): boolean {
  const result = runtime.run("openshell", ["sandbox", "list", "-o", "json"], {
    env: runtime.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 || result.stderr.trim().length > 0) return false;
  return parseStrictOpenShellSandboxListJson(result.stdout)?.length === 0;
}

/** Confirm exact provider absence without treating an arbitrary CLI failure as absence. */
export function exactOpenShellProviderIsAbsent(
  runtime: OpenShellInspectionRuntime,
  providerName: string,
): boolean {
  const diagnosticLimit = 16 * 1024;
  const result = runtime.run("openshell", ["provider", "get", providerName], {
    env: runtime.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0) return false;
  return reportsExactProviderNotFound(
    `${result.stdout}\n${result.stderr}`,
    providerName,
    diagnosticLimit,
  );
}

/** Invoke the ordinary receipt-checked sandbox destroy transaction without exiting this process. */
export async function destroySandboxForUninstall(
  sandboxName: string,
  expectedSandbox: GatewayRegistryEntry,
): Promise<ReceiptSandboxDestroyResult> {
  const destroy = await import("../sandbox/destroy");
  return destroy.destroySandboxForUninstall(sandboxName, expectedSandbox);
}

export {
  prepareProviderBrokerCleanup,
  removePreparedProviderBroker,
  type PreparedProviderBrokerCleanup,
} from "../../agent-runtime/provider-broker-cleanup";
export { getHarnessPackageStoreRoot } from "../../agent-runtime/package/pinned";
export type {
  ManagedAgentStateVolumeContext,
  PreparedManagedAgentStateVolumeCleanup,
} from "../../onboard/managed-workload/agent-state-volume";

export interface ManagedAgentStateVolumeRuntime {
  env: NodeJS.ProcessEnv;
  error(message: string): void;
  log(message: string): void;
  runtimeProviders?: RuntimeProviderBundleRegistry;
  runDocker(
    args: string[],
    options?: {
      env?: NodeJS.ProcessEnv;
      maxBuffer?: number;
      timeout?: number;
    },
  ): { status: number | null; stderr: string; stdout: string };
  warn(message: string): void;
}

function readHarnessPackage(value: unknown): HarnessPackageIdentity | undefined {
  return value === undefined || value === null ? undefined : parseHarnessPackageIdentity(value);
}

/** Convert one raw uninstall registry row into the generic cleanup context. */
export function managedAgentStateVolumeContext(
  sandboxName: string,
  entry: Readonly<Record<string, unknown>>,
): ManagedAgentStateVolumeContext {
  const agent = entry["agent"];
  const openshellDriver = entry["openshellDriver"];
  const workload = entry["workload"];
  const workloadKind =
    workload && typeof workload === "object" && !Array.isArray(workload)
      ? (workload as Record<string, unknown>)["kind"]
      : "";
  const harnessPackage = readHarnessPackage(entry["harnessPackage"]);
  return {
    agentName: typeof agent === "string" ? agent : undefined,
    ...(harnessPackage ? { harnessPackage } : {}),
    runtimeProviderId:
      openshellDriver === undefined ||
      openshellDriver === null ||
      typeof openshellDriver === "string"
        ? normalizeRuntimeProviderIdentity(openshellDriver)
        : "",
    sandboxName,
    workloadKind: typeof workloadKind === "string" ? workloadKind : "",
  };
}

function cleanupDependencies(runtime: ManagedAgentStateVolumeRuntime) {
  return {
    packageStoreRoot: getHarnessPackageStoreRootForEnvironment(runtime.env),
    runtimeProviders: runtime.runtimeProviders ?? CURRENT_RUNTIME_PROVIDER_BUNDLES,
    runDocker: (args: readonly string[], options?: { maxBuffer?: number; timeout?: number }) =>
      runtime.runDocker(["volume", ...args], {
        env: runtime.env,
        maxBuffer: options?.maxBuffer,
        timeout: options?.timeout,
      }),
  };
}

/** Resolve every package receipt and state root before uninstall removes resources. */
export function prepareManagedAgentStateVolumeCleanups(
  contexts: readonly ManagedAgentStateVolumeContext[],
  runtime: ManagedAgentStateVolumeRuntime,
): readonly PreparedManagedAgentStateVolumeCleanup[] {
  const deps = cleanupDependencies(runtime);
  return Object.freeze(
    contexts.map((context) => prepareManagedAgentStateVolumeCleanup(context, deps)),
  );
}

export function requiresManagedAgentStateVolumeCleanup(
  prepared: PreparedManagedAgentStateVolumeCleanup,
): boolean {
  return prepared.roots.length > 0;
}

/** Revalidate all receipt authority and remove only exact label-owned volumes. */
export function removeManagedAgentStateVolumesForUninstall(
  preparedCleanups: readonly PreparedManagedAgentStateVolumeCleanup[],
  runtime: ManagedAgentStateVolumeRuntime,
): boolean {
  const deps = cleanupDependencies(runtime);
  for (const prepared of preparedCleanups) {
    let results: ReturnType<typeof removePreparedManagedAgentStateVolumes>;
    try {
      results = removePreparedManagedAgentStateVolumes(prepared, deps);
    } catch (error) {
      runtime.error(
        `Managed package state cleanup authority for '${prepared.context.sandboxName}' could not be revalidated: ${error instanceof Error ? error.message : String(error)}`,
      );
      runtime.error("Preserved NemoClaw state so exact cleanup can be retried.");
      return false;
    }
    for (const result of results) {
      if (result.status === "failed") {
        runtime.error(`Managed state volume '${result.volumeName}' could not be removed.`);
        runtime.error("Preserved NemoClaw state so exact cleanup can be retried.");
        return false;
      }
      if (result.status === "not-owned") {
        runtime.warn(
          `Left managed state volume '${result.volumeName}' untouched because ${result.detail}.`,
        );
      } else if (result.status === "removed") {
        runtime.log(`Removed managed agent state volume for '${prepared.context.sandboxName}'.`);
      }
    }
  }
  return true;
}
