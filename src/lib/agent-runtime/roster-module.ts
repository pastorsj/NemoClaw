// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  HarnessAdapterError,
  HarnessAdapterModuleMissingError,
  loadHarnessAdapter,
} from "./adapter/loader";
import {
  HARNESS_AGENT_ROSTER_ADAPTER_CONTRACT,
  type HarnessAgentRosterApplyPlan,
  type HarnessAgentRosterApplyRequest,
  type HarnessAgentRosterCommandPlan,
  type HarnessAgentRosterCommandRequest,
  type HarnessAgentRosterInspectionPlan,
  type HarnessAgentRosterInspectionRequest,
} from "./adapter/agent-roster";
import { readObject, readString } from "./manifest-readers";
import type { HarnessPackageStoreOptions } from "./package/store";
import type { HarnessPackageIdentity } from "./package/types";

export type {
  HarnessAgentRosterApplyPlan,
  HarnessAgentRosterApplyRequest,
  HarnessAgentRosterCommandPlan,
  HarnessAgentRosterCommandRequest,
  HarnessAgentRosterInspectionPlan,
  HarnessAgentRosterInspectionRequest,
} from "./adapter/agent-roster";

export interface HarnessAgentRosterAdapterHostModule {
  buildAgentRosterCommand(request: HarnessAgentRosterCommandRequest): HarnessAgentRosterCommandPlan;
  buildAgentRosterInspection(
    request: HarnessAgentRosterInspectionRequest,
  ): HarnessAgentRosterInspectionPlan;
  buildAgentRosterApplyPlan(request: HarnessAgentRosterApplyRequest): HarnessAgentRosterApplyPlan;
}

export class HarnessAgentRosterModuleError extends Error {
  override readonly name = "HarnessAgentRosterModuleError";

  constructor(
    message: string,
    readonly code: "missing-adapter" | "invalid-adapter" = "invalid-adapter",
    options: ErrorOptions = {},
  ) {
    super(message, options);
  }
}

function rosterModuleFailure(error: unknown): never {
  if (error instanceof HarnessAgentRosterModuleError) throw error;
  if (error instanceof HarnessAdapterError) {
    throw new HarnessAgentRosterModuleError(
      error.message,
      error instanceof HarnessAdapterModuleMissingError ? "missing-adapter" : "invalid-adapter",
      { cause: error },
    );
  }
  throw new HarnessAgentRosterModuleError(
    "Installed harness agent roster adapter failed",
    "invalid-adapter",
    { cause: error },
  );
}

function callRosterAdapter<Result>(operation: () => Result): Result {
  try {
    return operation();
  } catch (error) {
    rosterModuleFailure(error);
  }
}

/** Load agent-roster behavior from the exact package identity recorded for one sandbox. */
export function loadHarnessAgentRosterAdapterHostModule(
  identity: HarnessPackageIdentity,
  options: HarnessPackageStoreOptions = {},
): HarnessAgentRosterAdapterHostModule {
  let adapter: ReturnType<typeof loadHarnessAdapter<typeof HARNESS_AGENT_ROSTER_ADAPTER_CONTRACT>>;
  try {
    adapter = loadHarnessAdapter(identity, HARNESS_AGENT_ROSTER_ADAPTER_CONTRACT, {
      ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
      validateManifest(manifest) {
        const roster = readObject(manifest, "agent_roster");
        if (
          readString(roster ?? {}, "support") !== "managed" ||
          readString(roster ?? {}, "adapter") !== "agent-roster" ||
          readString(roster ?? {}, "onboarding_environment") !== "NEMOCLAW_EXTRA_AGENTS_JSON"
        ) {
          throw new HarnessAgentRosterModuleError(
            "Installed harness package has an invalid agent roster declaration",
          );
        }
      },
    });
  } catch (error) {
    rosterModuleFailure(error);
  }

  return Object.freeze({
    buildAgentRosterCommand(
      request: HarnessAgentRosterCommandRequest,
    ): HarnessAgentRosterCommandPlan {
      return callRosterAdapter(() => adapter.buildCommand(request));
    },
    buildAgentRosterInspection(
      request: HarnessAgentRosterInspectionRequest,
    ): HarnessAgentRosterInspectionPlan {
      return callRosterAdapter(() => adapter.buildInspection(request));
    },
    buildAgentRosterApplyPlan(
      request: HarnessAgentRosterApplyRequest,
    ): HarnessAgentRosterApplyPlan {
      return callRosterAdapter(() => adapter.buildApplyPlan(request));
    },
  });
}
