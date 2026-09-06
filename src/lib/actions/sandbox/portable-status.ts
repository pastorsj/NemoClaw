// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getGatewayPresets } from "../../policy";
import {
  readPublishedSandboxAuthority,
  readRegisteredSandboxAuthority,
  type RegisteredSandboxAuthority,
} from "../../onboard/package/package-authority";
import { classifyHermesPortableRegistry } from "../../onboard/experimental/hermes-portable-onboarding";
import {
  qualifyPortableAgentLifecycleAuthority,
  type HermesPortableAgentLifecycleAuthority,
} from "../../onboard/experimental/portable-agent-lifecycle";
import { inspectPortableAgentReceiptAuthorityForClassification } from "../../onboard/experimental/hermes-portable-receipt";
import { defaultPortableDemoStateDir } from "../../onboard/experimental/portable-runtime-receipt-readiness";
import { normalizeSandboxStatusHostMounts, type SandboxStatusReport } from "./status-snapshot";

/**
 * Report the separately qualified Hermes Portable product lifecycle.
 *
 * This is not ordinary harness-package dispatch: its schema-specific receipt,
 * runtime authority, and accepted lifecycle are established by
 * `qualifyPortableAgentLifecycleAuthority` before this module observes them.
 */
export function inspectHermesPortableStatus(
  sandboxName: string,
): HermesPortableAgentLifecycleAuthority | null {
  const authority = qualifyPortableAgentLifecycleAuthority(sandboxName, {
    readRegistry: getPublishedSandbox,
  });
  return authority.kind === "hermes" ? authority : null;
}

/** Read the phase owned by a Hermes Portable receipt and its exact registry row. */
export function getQualifiedHermesPortablePhase(
  sandboxName: string,
): "pending" | "configuring" | "active" | null {
  const authority = inspectPortableAgentReceiptAuthorityForClassification(
    sandboxName,
    defaultPortableDemoStateDir(process.env),
  );
  if (authority.kind !== "hermes") return null;
  const disposition = classifyHermesPortableRegistry(
    authority.snapshot.receipt,
    readRegisteredSandboxAuthority(sandboxName),
  );
  if (disposition.kind !== "matching") {
    throw new Error(
      "Global status found a Hermes portable receipt that disagrees with its registry row.",
    );
  }
  return authority.snapshot.receipt.phase;
}

function getPublishedSandbox(sandboxName: string): RegisteredSandboxAuthority | null {
  return readPublishedSandboxAuthority(sandboxName);
}

export function hermesPortableStatusReport(
  sandboxName: string,
  authority: HermesPortableAgentLifecycleAuthority,
  readPolicies: typeof getGatewayPresets,
): SandboxStatusReport {
  const { entry, phase } = authority;
  const model = entry?.model ?? "unknown";
  const provider = entry?.provider ?? "unknown";
  const livePolicies = readPolicies(sandboxName);
  return {
    schemaVersion: 1,
    name: sandboxName,
    found: phase === "active",
    agent: "hermes",
    agentDisplayName: "Hermes",
    agentRuntime: "gateway",
    dcodeAutoApprovalMode: null,
    model,
    provider,
    servingProfileProvenance: entry?.servingProfileProvenance ?? null,
    recordedRoute:
      entry?.provider && entry.model ? { provider: entry.provider, model: entry.model } : null,
    liveRoute: null,
    routeDrift: null,
    phase: null,
    portableLifecyclePhase: phase,
    gatewayState: "not-probed",
    inferenceHealth: null,
    rpcIssue: null,
    hostGpuDetected: entry?.hostGpuDetected === true,
    sandboxGpuEnabled: entry?.sandboxGpuEnabled ?? entry?.gpuEnabled === true,
    sandboxGpuMode: entry?.sandboxGpuMode ?? null,
    sandboxGpuDevice: entry?.sandboxGpuDevice ?? null,
    sandboxGpuProof: entry?.sandboxGpuProof ?? null,
    hostMounts: normalizeSandboxStatusHostMounts(entry?.hostMounts),
    openshellDriver: entry?.openshellDriver ?? "unknown",
    openshellVersion: entry?.openshellVersion ?? "unknown",
    policies: livePolicies ?? [],
    policiesAvailable: livePolicies !== null,
    failureLayer: null,
    terminalRuntimeHealth: null,
    servingProcessHealth: null,
    dockerPaused: false,
  };
}
