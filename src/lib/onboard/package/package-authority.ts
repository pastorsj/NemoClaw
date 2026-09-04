// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import {
  inspectHarnessPackageState,
  type HarnessPackageAuthority,
  type HarnessPackageIdentity,
  type HarnessPackageMigration,
} from "../../agent-runtime/package/identity";
import { normalizeSandboxAgentName, resolveSandboxAgent } from "../sandbox-agent";
import type { ResolveSandboxAgentOptions, ResolvedSandboxAgent } from "../sandbox-agent";

/** Exact package authority carried by one onboarding session and its registry writes. */
export type OnboardHarnessPackageAuthority = HarnessPackageAuthority;

export interface CurrentSessionHarnessPackageAuthority {
  readonly authority: OnboardHarnessPackageAuthority;
  readonly resolvedAgent: ResolvedSandboxAgent;
}

export interface CurrentSessionHarnessPackageAuthorityDependencies {
  readonly loadSession: () => HarnessPackageSessionAuthority | null;
  readonly resolveSandboxAgent: typeof resolveSandboxAgent;
}

export interface HarnessPackageSessionAuthority {
  readonly sessionId: string;
  readonly agent: string | null;
  readonly harnessPackage: HarnessPackageIdentity | null;
  readonly harnessPackageMigration: HarnessPackageMigration | null;
}

/** Resolve one package-backed sandbox through its exact recorded receipt. */
export function resolvePackageBackedSandboxAgent(
  entry: Parameters<typeof resolveSandboxAgent>[0],
  options?: ResolveSandboxAgentOptions,
): ResolvedSandboxAgent {
  return options === undefined ? resolveSandboxAgent(entry) : resolveSandboxAgent(entry, options);
}

/** Resolve exact package bytes and any release-candidate qualification together. */
export function resolveLifecycleEligibleSandboxAgent(
  entry: Parameters<typeof resolveSandboxAgent>[0],
  options: Omit<ResolveSandboxAgentOptions, "requireLifecycleEligibility"> = {},
): ResolvedSandboxAgent {
  return resolveSandboxAgent(entry, { ...options, requireLifecycleEligibility: true });
}

/** Parse the complete package pair without treating explicit candidate absence as malformed. */
export function onboardHarnessPackageAuthority(
  session: Pick<
    HarnessPackageSessionAuthority,
    "agent" | "harnessPackage" | "harnessPackageMigration"
  >,
): OnboardHarnessPackageAuthority {
  const state = inspectHarnessPackageState(session.harnessPackage, session.harnessPackageMigration);
  if (state.status === "invalid") {
    throw new Error("Onboarding session harness package authority is malformed");
  }
  if (state.status === "absent") {
    const effectiveAgentId = normalizeSandboxAgentName(session.agent);
    if (effectiveAgentId !== "nemocua") {
      throw new Error(
        `Onboarding session agent '${effectiveAgentId}' requires harness package migration`,
      );
    }
    return Object.freeze({ harnessPackage: null, harnessPackageMigration: null });
  }
  return Object.freeze({
    harnessPackage: state.harnessPackage,
    harnessPackageMigration: state.harnessPackageMigration,
  });
}

/** Re-read one Session and resolve its pinned package object before an external mutation. */
export function requireCurrentSessionHarnessPackageAuthority(
  expected: HarnessPackageSessionAuthority,
  operation: string,
  options: ResolveSandboxAgentOptions = {},
  deps: CurrentSessionHarnessPackageAuthorityDependencies,
): CurrentSessionHarnessPackageAuthority {
  const current = deps.loadSession();
  if (
    !current ||
    current.sessionId !== expected.sessionId ||
    current.agent !== expected.agent ||
    !isDeepStrictEqual(current.harnessPackage, expected.harnessPackage) ||
    !isDeepStrictEqual(current.harnessPackageMigration, expected.harnessPackageMigration)
  ) {
    throw new Error(`Cannot ${operation}: onboarding session harness package authority changed`);
  }
  const authority = onboardHarnessPackageAuthority(current);
  const resolvedAgent = deps.resolveSandboxAgent(
    {
      agent: current.agent,
      ...(authority.harnessPackage
        ? {
            harnessPackage: authority.harnessPackage,
            ...(authority.harnessPackageMigration
              ? { harnessPackageMigration: authority.harnessPackageMigration }
              : {}),
          }
        : {}),
    },
    options,
  );
  return Object.freeze({ authority, resolvedAgent });
}
