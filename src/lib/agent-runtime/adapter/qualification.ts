// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ManifestRecord } from "../manifest-types";
import type { HarnessPackageStoreOptions } from "../package/store";
import type { HarnessPackageIdentity } from "../package/types";
import { listRequiredHarnessPackageArtifacts } from "../package/validation";
import { HARNESS_AGENT_ROSTER_ADAPTER_CONTRACT } from "./agent-roster";
import { HARNESS_CONFIG_ADAPTER_CONTRACT, HARNESS_CONFIG_RESTORE_CONTRACT } from "./config";
import type { HarnessAdapterContract, HarnessAdapterOperations } from "./contract";
import { HarnessAdapterError, initializeHarnessAdapter } from "./loader";
import { HARNESS_MCP_ADAPTER_CONTRACT } from "./mcp";
import { HARNESS_MESSAGING_ADAPTER_CONTRACT } from "./messaging";
import { HARNESS_PROVIDER_AUTH_ADAPTER_CONTRACT } from "./provider-auth";
import { HARNESS_PROVIDER_BROKER_ADAPTER_CONTRACT } from "./provider-broker";
import { HARNESS_SESSION_ADAPTER_CONTRACT } from "./session";
import {
  HARNESS_STARTUP_PLAN_ADAPTER_CONTRACT,
  HARNESS_STARTUP_PROFILE_ADAPTER_CONTRACT,
} from "./startup";

type FixedHarnessAdapterContract = HarnessAdapterContract<HarnessAdapterOperations>;

interface HarnessAdapterQualificationDependencies {
  readonly initializeAdapter: (
    identity: HarnessPackageIdentity,
    contract: FixedHarnessAdapterContract,
    options: HarnessPackageStoreOptions,
  ) => void;
}

export interface HarnessPackageAdapterInitializationQualifier {
  (
    identity: HarnessPackageIdentity,
    manifest: ManifestRecord,
    options?: HarnessPackageStoreOptions,
  ): void;
}

const FIXED_CONTRACTS_BY_MODULE = new Map<string, readonly FixedHarnessAdapterContract[]>([
  ["host/config-adapter.cts", [HARNESS_CONFIG_ADAPTER_CONTRACT]],
  ["host/messaging-adapter.cts", [HARNESS_MESSAGING_ADAPTER_CONTRACT]],
  ["host/mcp-adapter.cts", [HARNESS_MCP_ADAPTER_CONTRACT]],
  ["host/agent-roster-adapter.cts", [HARNESS_AGENT_ROSTER_ADAPTER_CONTRACT]],
  ["host/session-adapter.cts", [HARNESS_SESSION_ADAPTER_CONTRACT]],
  [
    "host/startup-adapter.cts",
    [HARNESS_STARTUP_PLAN_ADAPTER_CONTRACT, HARNESS_STARTUP_PROFILE_ADAPTER_CONTRACT],
  ],
  ["host/provider-auth-adapter.cts", [HARNESS_PROVIDER_AUTH_ADAPTER_CONTRACT]],
  ["host/provider-broker-adapter.cts", [HARNESS_PROVIDER_BROKER_ADAPTER_CONTRACT]],
  ["host/restore-adapter.cts", [HARNESS_CONFIG_RESTORE_CONTRACT]],
]);

const REQUIRED_NON_ADAPTER_ARTIFACTS = new Set(["host/provider-broker-control.cts"]);

export class HarnessAdapterQualificationError extends Error {
  override readonly name = "HarnessAdapterQualificationError";
}

/** Select the complete fixed adapter surface implied by one validated package manifest. */
export function listRequiredHarnessAdapterContracts(
  manifest: ManifestRecord,
): readonly FixedHarnessAdapterContract[] {
  const contracts: FixedHarnessAdapterContract[] = [];
  for (const artifact of listRequiredHarnessPackageArtifacts(manifest)) {
    const selected = FIXED_CONTRACTS_BY_MODULE.get(artifact);
    if (selected) {
      contracts.push(...selected);
      continue;
    }
    if (!REQUIRED_NON_ADAPTER_ARTIFACTS.has(artifact)) {
      throw new HarnessAdapterQualificationError(
        `NemoClaw has no fixed initialization contract for required artifact '${artifact}'`,
      );
    }
  }
  return Object.freeze(contracts);
}

function sameContracts(
  left: readonly FixedHarnessAdapterContract[],
  right: readonly FixedHarnessAdapterContract[],
): boolean {
  return left.length === right.length && left.every((contract, index) => contract === right[index]);
}

/** Create one process-local qualifier with an isolated success cache. */
export function createHarnessPackageAdapterInitializationQualifier(
  dependencies: HarnessAdapterQualificationDependencies = {
    initializeAdapter: initializeHarnessAdapter,
  },
): HarnessPackageAdapterInitializationQualifier {
  // A successful qualification is immutable for this qualifier's life: the receipt digest covers
  // every adapter byte and the fixed contracts are process-local constants.
  const qualifiedContractsByPackage = new Map<string, readonly FixedHarnessAdapterContract[]>();

  return (identity, manifest, options = {}): void => {
    // Select contracts before consulting the cache. A caller cannot use an earlier success to skip
    // validation of the manifest surface supplied with the same package identity.
    const contracts = listRequiredHarnessAdapterContracts(manifest);
    const cacheKey = `${identity.kind}\0${identity.id}\0${identity.packageVersion}\0${identity.contentDigest}`;
    const qualifiedContracts = qualifiedContractsByPackage.get(cacheKey);
    if (qualifiedContracts) {
      if (!sameContracts(qualifiedContracts, contracts)) {
        throw new HarnessAdapterQualificationError(
          "Harness package adapter contract selection changed for a qualified package identity",
        );
      }
      return;
    }

    for (const contract of contracts) {
      try {
        dependencies.initializeAdapter(identity, contract, options);
      } catch (error) {
        if (error instanceof HarnessAdapterError) {
          throw new HarnessAdapterQualificationError(
            `Harness package ${contract.displayName} initialization failed: ${error.message}`,
            { cause: error },
          );
        }
        throw new HarnessAdapterQualificationError(
          `Harness package ${contract.displayName} initialization failed`,
          { cause: error },
        );
      }
    }
    qualifiedContractsByPackage.set(cacheKey, contracts);
  };
}

/** Initialize every required adapter in the bounded VM without invoking package operations. */
export const qualifyHarnessPackageAdapterInitialization =
  createHarnessPackageAdapterInitializationQualifier();
