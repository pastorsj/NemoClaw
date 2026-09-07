// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import type { HarnessSelectionQualificationDeclaration } from "@nvidia/nemoclaw-harness-contract";

import type {
  HarnessPackageAuthority,
  HarnessPackageIdentity,
} from "../../../agent-runtime/package/identity";
import type { Session } from "../../../state/onboard-session";
import type { SandboxEntry } from "../../../state/registry";
import type { PackageSelectionQualificationReader } from "../../selection/qualification";
import { usesManagedDcodeIdentity } from "../../dcode-selection-drift";
import type { SandboxResumeDecision } from "./sandbox-resume";

export interface Deps {
  getDcodeSelectionDrift(
    sandboxName: string,
    provider: string,
    model: string,
    preferredInferenceApi: string | null,
    endpointUrl: string | null,
  ): { changed: boolean; unknown: boolean };
  getPackageSelectionQualification?: PackageSelectionQualificationReader;
  revalidateHarnessPackageAuthority?(session: Session, operation: string): HarnessPackageAuthority;
  error(message?: string): void;
  exitProcess(code: number): never;
}

interface SelectionOptions<Agent> {
  readonly agent: Agent;
  readonly fromDockerfile: string | null;
  readonly provider: string;
  readonly model: string;
}

interface ResumeOptions<Agent> extends SelectionOptions<Agent> {
  readonly resume: boolean;
  readonly preferredInferenceApi: string | null;
  readonly endpointUrl: string | null;
}

interface ResumeState {
  readonly session: Session | null;
  readonly sandboxName: string | null;
}

function agentName<Agent>(agent: Agent): string | null | undefined {
  return (agent as { name?: string } | null | undefined)?.name;
}

function selectionQualification<Agent>(
  agent: Agent,
): HarnessSelectionQualificationDeclaration | null {
  return (
    (
      agent as {
        runtime?: {
          selection_qualification?: HarnessSelectionQualificationDeclaration;
        };
      } | null
    )?.runtime?.selection_qualification ?? null
  );
}

function requireCurrentReceiptAuthority(
  session: Session,
  operation: string,
  expected: HarnessPackageIdentity,
  deps: Deps,
): void {
  if (!deps.revalidateHarnessPackageAuthority) {
    throw new Error(`Cannot ${operation}: harness package revalidation is unavailable`);
  }
  const current = deps.revalidateHarnessPackageAuthority(session, operation).harnessPackage;
  if (!current || !isDeepStrictEqual(current, expected)) {
    throw new Error(`Cannot ${operation}: harness package authority changed`);
  }
}

export function preserveManagedDcodeRegistryEntry<Agent>(
  options: SelectionOptions<Agent>,
  decision: SandboxResumeDecision,
  receiptBackedPackage = false,
): SandboxResumeDecision {
  if (
    receiptBackedPackage ||
    decision.kind !== "recreate" ||
    !decision.removeRegistryEntry ||
    !usesManagedDcodeIdentity(agentName(options.agent), options.fromDockerfile)
  ) {
    return decision;
  }
  return { ...decision, removeRegistryEntry: false };
}

export function resolveSignals<Agent>(
  options: ResumeOptions<Agent>,
  state: ResumeState,
  sandboxReuseState: string,
  registryEntry: SandboxEntry | null,
  deps: Deps,
): { inferenceSelectionChanged: boolean } {
  const sandboxName = state.sandboxName;
  const packageIdentity = state.session?.harnessPackage ?? null;
  const packageQualifier = packageIdentity ? selectionQualification(options.agent) : null;
  const legacyManagedDcode =
    packageIdentity === null &&
    usesManagedDcodeIdentity(agentName(options.agent), options.fromDockerfile);
  if (
    !options.resume ||
    state.session?.steps?.sandbox?.status !== "complete" ||
    !sandboxName ||
    (!packageQualifier && !legacyManagedDcode) ||
    sandboxReuseState !== "ready"
  ) {
    return { inferenceSelectionChanged: false };
  }
  if (!registryEntry) {
    deps.error(
      `  Sandbox '${sandboxName}' is live but missing its NemoClaw registry record; refusing unverified agent-runtime reuse.`,
    );
    return deps.exitProcess(1);
  }
  if (
    packageIdentity &&
    (!registryEntry.harnessPackage ||
      !isDeepStrictEqual(registryEntry.harnessPackage, packageIdentity))
  ) {
    deps.error(
      `  Sandbox '${sandboxName}' package identity does not match the active onboarding receipt; refusing unverified agent-runtime reuse.`,
    );
    return deps.exitProcess(1);
  }
  const drift = packageIdentity
    ? (deps.getPackageSelectionQualification?.(
        sandboxName,
        packageIdentity.id,
        packageQualifier!,
        options.provider,
        options.model,
        options.preferredInferenceApi,
        options.endpointUrl,
        () =>
          requireCurrentReceiptAuthority(
            state.session!,
            "qualify live inference selection",
            packageIdentity,
            deps,
          ),
      ) ?? { changed: true, unknown: true })
    : deps.getDcodeSelectionDrift(
        sandboxName,
        options.provider,
        options.model,
        options.preferredInferenceApi,
        options.endpointUrl,
      );
  return {
    inferenceSelectionChanged: Boolean(drift.changed || drift.unknown),
  };
}

export function selectionFidelity<Agent>(
  options: SelectionOptions<Agent>,
  existing: SandboxEntry | null,
  receiptBackedPackage = false,
): Partial<Pick<SandboxEntry, "provider" | "model">> {
  if (
    receiptBackedPackage ||
    !usesManagedDcodeIdentity(agentName(options.agent), options.fromDockerfile) ||
    (existing?.provider === options.provider && existing?.model === options.model)
  ) {
    return {};
  }
  return { provider: options.provider, model: options.model };
}
