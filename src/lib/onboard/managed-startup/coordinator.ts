// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type CommittedManagedStartupApplication,
  commitManagedStartupApplication,
  type PreparedManagedStartupApplication,
  type PrepareManagedStartupApplicationInput,
  prepareManagedStartupApplication,
} from "./application";
import type { ManagedStartupDurableProfile } from "./profile";

export interface ManagedStartupAdapterContext {
  readonly agent: string;
  readonly profile: ManagedStartupDurableProfile;
  readonly fingerprint: string;
  readonly generationDirectory: string;
  readonly profilePath: string;
  readonly corporateCaPath: string | null;
}

export interface ManagedStartupAgentAdapter {
  readonly packageId: string;
  readonly apply: (context: ManagedStartupAdapterContext) => void | Promise<void>;
}

export interface ManagedStartupCoordinatorDependencies {
  readonly prepareApplication: (
    input: PrepareManagedStartupApplicationInput,
  ) => PreparedManagedStartupApplication | Promise<PreparedManagedStartupApplication>;
  readonly commitApplication: (
    prepared: PreparedManagedStartupApplication,
  ) => CommittedManagedStartupApplication | Promise<CommittedManagedStartupApplication>;
}

export interface ManagedStartupCoordinationResult {
  readonly adapterApplied: boolean;
  readonly application: CommittedManagedStartupApplication;
}

const DEFAULT_DEPENDENCIES: ManagedStartupCoordinatorDependencies = {
  prepareApplication: (input) => prepareManagedStartupApplication(input),
  commitApplication: (prepared) => commitManagedStartupApplication(prepared),
};

export class ManagedStartupCoordinatorError extends Error {
  constructor(message: string) {
    super(`Managed startup coordination failed: ${message}`);
    this.name = "ManagedStartupCoordinatorError";
  }
}

function fail(message: string): never {
  throw new ManagedStartupCoordinatorError(message);
}

function validateAdapter(adapter: ManagedStartupAgentAdapter): void {
  if (
    typeof adapter !== "object" ||
    adapter === null ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(adapter.packageId) ||
    typeof adapter.apply !== "function"
  ) {
    fail("the adapter must identify one package and provide an apply function");
  }
}

function requirePreparedIdentity(
  prepared: PreparedManagedStartupApplication,
  requestedAgent: string,
): void {
  if (prepared.expectedAgent !== requestedAgent || prepared.profile.agent !== requestedAgent) {
    fail(`prepared profile targets ${prepared.profile.agent}, expected ${requestedAgent}`);
  }
}

function adapterContext(prepared: PreparedManagedStartupApplication): ManagedStartupAdapterContext {
  return Object.freeze({
    agent: prepared.profile.agent,
    profile: prepared.profile,
    fingerprint: prepared.fingerprint,
    generationDirectory: prepared.generationDirectory,
    profilePath: prepared.profilePath,
    corporateCaPath: prepared.corporateCaPath,
  });
}

/**
 * Coordinate one managed startup without depending on a host container driver.
 *
 * The package identity must match before application state is prepared. A new
 * pending profile applies exactly that package's validated finite plan and
 * commits only after it succeeds. An already committed profile is revalidated
 * through commit without reapplying mutable package configuration.
 */
export async function coordinateManagedStartupApplication(
  input: PrepareManagedStartupApplicationInput,
  adapter: ManagedStartupAgentAdapter,
  dependencies: ManagedStartupCoordinatorDependencies = DEFAULT_DEPENDENCIES,
): Promise<ManagedStartupCoordinationResult> {
  validateAdapter(adapter);
  if (adapter.packageId !== input.expectedAgent) {
    fail(`adapter for ${adapter.packageId} cannot apply ${input.expectedAgent}`);
  }
  const prepared = await dependencies.prepareApplication(input);
  requirePreparedIdentity(prepared, input.expectedAgent);

  if (prepared.status === "already-committed") {
    return {
      adapterApplied: false,
      application: await dependencies.commitApplication(prepared),
    };
  }

  await adapter.apply(adapterContext(prepared));
  return {
    adapterApplied: true,
    application: await dependencies.commitApplication(prepared),
  };
}
