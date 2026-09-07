// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HarnessStartupSettings } from "@nvidia/nemoclaw-harness-contract";

import type { AgentDefinition } from "../../agent/defs";
import { isWebSearchProvider, webSearchProviderForConfig } from "../../inference/web-search";
import type { DcodeAutoApprovalMode } from "../../onboard/dcode-auto-approval";
import type { ResolvedSandboxAgent } from "../../onboard/sandbox-agent";
import type { Session } from "../../state/onboard-session";
import * as onboardSession from "../../state/onboard-session";
import { cloneSandboxWorkloadReceipt } from "../../state/registry/workload";
import {
  decodeManagedStartupDurableProfile,
  isManagedStartupPackageProfile,
  type ManagedStartupPackageProfile,
} from "../../onboard/managed-startup/profile";
import {
  DEFAULT_TOOL_DISCLOSURE,
  normalizeToolDisclosure,
  type ToolDisclosure,
} from "../../tool-disclosure";
import type { RebuildBail } from "./rebuild-credential-preflight";
import {
  type RebuildDurableConfig,
  resolveRebuildDockerfile,
  resolveRebuildDurableConfig,
} from "./rebuild-durable-config";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import { printRebuildPreflightFailure } from "./rebuild-preflight-error";
import {
  isLocalInferenceProvider,
  prepareRebuildResumeConfig,
  type RebuildResumeConfig,
} from "./rebuild-resume-config";
import {
  filterLegacyRebuildToolGatewaysForWebSearch,
  legacyManagedRebuildRejectsCustomDockerfile,
  resolveLegacyRebuildToolGateways,
} from "./rebuild/legacy-state";

const hermesProviderAuth = require("../../hermes-provider-auth") as {
  HERMES_PROVIDER_NAME: string;
  HERMES_INFERENCE_CREDENTIAL_ENV: string;
  HERMES_NOUS_API_KEY_CREDENTIAL_ENV: string;
};

export type RebuildTargetConfig = {
  agentAuthority: ResolvedSandboxAgent;
  agentDefinition: AgentDefinition;
  resumeConfig: RebuildResumeConfig;
  sessionSnapshot: Session | null;
  sessionMatchesSandbox: boolean;
  durableConfig: RebuildDurableConfig;
  hermesToolGateways: string[];
  hasHermesToolGateways: boolean;
  credentialEnv: string | null;
  /** Receipt-backed authentication choice selected during onboarding. */
  providerAuthMethod: string | null;
  fromDockerfile: string | null;
};

function readRecordedStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item: unknown): item is string => typeof item === "string");
}

function resolveReceiptRebuildToolGateways(
  sb: RebuildSandboxEntry,
  session: Session | null,
  sessionMatchesSandbox: boolean,
): { gateways: string[]; recorded: boolean } {
  const registryGateways = readRecordedStringList(sb.toolGatewaySelections);
  const sessionGateways = sessionMatchesSandbox
    ? readRecordedStringList(session?.toolGatewaySelections)
    : null;
  return {
    gateways: registryGateways ?? sessionGateways ?? [],
    recorded: registryGateways !== null || sessionGateways !== null,
  };
}

export function resolveReceiptRebuildStartupProfile(
  sb: RebuildSandboxEntry,
  agentAuthority: ResolvedSandboxAgent,
): ManagedStartupPackageProfile | null {
  const receipt = agentAuthority.harnessPackage;
  if (!receipt) return null;
  const workload = cloneSandboxWorkloadReceipt(sb.workload, { harnessPackage: receipt });
  const encodedProfile =
    workload?.kind === "managed-image"
      ? workload.encodedProfile
      : workload?.kind === "legacy-dockerfile"
        ? workload.packageStartupProfile?.encodedProfile
        : undefined;
  if (encodedProfile === undefined) {
    throw new Error("receipt-backed rebuild has no exact package startup profile");
  }
  const profile = decodeManagedStartupDurableProfile(encodedProfile);
  if (!isManagedStartupPackageProfile(profile) || profile.agent !== receipt.id) {
    throw new Error("receipt-backed rebuild startup profile does not match its package authority");
  }
  return profile;
}

export function resolveReceiptRebuildStartupSettings(
  sb: RebuildSandboxEntry,
  agentAuthority: ResolvedSandboxAgent,
): HarnessStartupSettings | null {
  return resolveReceiptRebuildStartupProfile(sb, agentAuthority)?.desiredState ?? null;
}

/** Resolve durable rebuild state without consulting any pre-package harness encoding. */
export function resolveReceiptRebuildDurableConfig(
  entry: RebuildSandboxEntry,
  startupSettings: HarnessStartupSettings | null,
  requestedToolDisclosure?: ToolDisclosure,
  requestedApprovalMode?: DcodeAutoApprovalMode,
): RebuildDurableConfig {
  const configuredWebSearch = startupSettings?.configuration.webSearch;
  const webSearchEnabled = configuredWebSearch?.enabled ?? entry.webSearchEnabled === true;
  const webSearchProvider = configuredWebSearch?.provider ?? entry.webSearchProvider;
  const webSearchError =
    webSearchEnabled && !isWebSearchProvider(webSearchProvider)
      ? "recorded package web-search provider is invalid or missing"
      : null;
  const recordedDisclosure = startupSettings?.tools.disclosure ?? entry.toolDisclosure;
  const toolDisclosure =
    requestedToolDisclosure ??
    normalizeToolDisclosure(recordedDisclosure) ??
    DEFAULT_TOOL_DISCLOSURE;
  const toolDisclosureError =
    recordedDisclosure !== undefined && normalizeToolDisclosure(recordedDisclosure) === null
      ? "recorded package toolDisclosure value must be progressive or direct"
      : null;
  const recordedApprovalMode =
    startupSettings?.configuration.autoApprovalMode ?? entry.approvalMode;
  const approvalMode =
    requestedApprovalMode ??
    (recordedApprovalMode === "thread-opt-in" ? "thread-opt-in" : "disabled");
  const approvalModeError =
    recordedApprovalMode !== undefined &&
    recordedApprovalMode !== "disabled" &&
    recordedApprovalMode !== "thread-opt-in"
      ? "recorded package approvalMode value must be disabled or thread-opt-in"
      : null;
  const recordedFromDockerfile: unknown = entry.fromDockerfile ?? null;

  return {
    dcodeAutoApprovalMode: approvalMode,
    dcodeAutoApprovalModeError: approvalModeError,
    fromDockerfile:
      typeof recordedFromDockerfile === "string" && recordedFromDockerfile.length > 0
        ? recordedFromDockerfile
        : null,
    fromDockerfileError:
      recordedFromDockerfile !== null &&
      (typeof recordedFromDockerfile !== "string" || recordedFromDockerfile.length === 0)
        ? "recorded value is not a non-empty path"
        : null,
    hermesAuthMethod: null,
    hermesAuthMethodError: null,
    webSearchConfig:
      webSearchEnabled && isWebSearchProvider(webSearchProvider)
        ? { fetchEnabled: true, provider: webSearchProvider }
        : null,
    webSearchError,
    toolDisclosure,
    toolDisclosureError,
  };
}

function validateRebuildDurableConfig(
  durableConfig: RebuildDurableConfig,
  resumeConfig: RebuildResumeConfig,
  bail: RebuildBail,
  receiptBacked: boolean,
): boolean {
  if (durableConfig.webSearchError) {
    printRebuildPreflightFailure(
      "recorded web-search state is invalid.",
      durableConfig.webSearchError,
      "Recorded web-search state is invalid",
      bail,
    );
    return false;
  }
  if (durableConfig.toolDisclosureError) {
    printRebuildPreflightFailure(
      "recorded tool-disclosure state is invalid.",
      durableConfig.toolDisclosureError,
      "Recorded tool-disclosure state is invalid",
      bail,
    );
    return false;
  }
  if (durableConfig.dcodeAutoApprovalModeError) {
    printRebuildPreflightFailure(
      receiptBacked
        ? "recorded package approval state is invalid."
        : "recorded DCode auto-approval state is invalid.",
      durableConfig.dcodeAutoApprovalModeError,
      receiptBacked
        ? "Recorded package approval state is invalid"
        : "Recorded DCode auto-approval state is invalid",
      bail,
    );
    return false;
  }
  if (durableConfig.fromDockerfileError) {
    printRebuildPreflightFailure(
      "recorded custom Dockerfile is invalid.",
      durableConfig.fromDockerfileError,
      "Recorded custom Dockerfile is invalid",
      bail,
    );
    return false;
  }
  if (
    !receiptBacked &&
    (durableConfig.hermesAuthMethodError ||
      (resumeConfig.provider === hermesProviderAuth.HERMES_PROVIDER_NAME &&
        durableConfig.hermesAuthMethod === null))
  ) {
    printRebuildPreflightFailure(
      "Hermes auth state is incomplete.",
      durableConfig.hermesAuthMethodError ??
        "cannot determine the recorded Hermes Provider authentication method",
      "Cannot determine recorded Hermes Provider authentication method",
      bail,
    );
    return false;
  }
  return true;
}

/** Preserve package-selected credential routing; only legacy rows decode Hermes auth fields. */
export function resolveRebuildTargetCredentialEnv(
  resumeConfig: Pick<RebuildResumeConfig, "provider" | "credentialEnv">,
  durableConfig: Pick<RebuildDurableConfig, "hermesAuthMethod">,
  receiptBacked: boolean,
  recordedCredentialEnv?: string | null,
): string | null {
  if (receiptBacked) {
    if (isLocalInferenceProvider(resumeConfig.provider)) return null;
    return typeof recordedCredentialEnv === "string" && recordedCredentialEnv.trim()
      ? recordedCredentialEnv.trim()
      : resumeConfig.credentialEnv;
  }
  if (resumeConfig.provider !== hermesProviderAuth.HERMES_PROVIDER_NAME) {
    return resumeConfig.credentialEnv;
  }
  return durableConfig.hermesAuthMethod === "api_key"
    ? hermesProviderAuth.HERMES_NOUS_API_KEY_CREDENTIAL_ENV
    : hermesProviderAuth.HERMES_INFERENCE_CREDENTIAL_ENV;
}

/** Preserve only the target sandbox's receipt-backed, non-secret auth-method selection. */
export function resolveRebuildTargetProviderAuthMethod(
  entry: Pick<RebuildSandboxEntry, "providerAuthMethod">,
  session: Pick<Session, "providerAuthMethod"> | null,
  sessionMatchesSandbox: boolean,
  receiptBacked: boolean,
): string | null {
  if (!receiptBacked) return null;
  const recorded = entry.providerAuthMethod;
  if (typeof recorded === "string" && recorded.trim()) return recorded.trim();
  const matchingSessionMethod = sessionMatchesSandbox ? session?.providerAuthMethod : null;
  return typeof matchingSessionMethod === "string" && matchingSessionMethod.trim()
    ? matchingSessionMethod.trim()
    : null;
}

export function prepareRebuildTargetConfig(
  sandboxName: string,
  sb: RebuildSandboxEntry,
  agentAuthority: ResolvedSandboxAgent,
  log: (message: string) => void,
  bail: RebuildBail,
  requestedToolDisclosure?: ToolDisclosure,
  allowLegacyManagedImageRecovery = false,
  requestedDcodeAutoApprovalMode?: DcodeAutoApprovalMode,
): RebuildTargetConfig | null {
  const resumeConfig = prepareRebuildResumeConfig(sandboxName, sb, agentAuthority, log, bail);
  if (!resumeConfig) return null;
  if (
    resumeConfig.agentAuthority !== agentAuthority ||
    resumeConfig.agentAuthority.definition !== agentAuthority.definition
  ) {
    bail("Pinned rebuild agent authority changed during target configuration");
    return null;
  }
  let receiptStartupSettings: HarnessStartupSettings | null;
  try {
    receiptStartupSettings = resolveReceiptRebuildStartupSettings(sb, agentAuthority);
  } catch (error) {
    printRebuildPreflightFailure(
      "the receipt-backed startup state is unavailable.",
      error instanceof Error ? error.message : String(error),
      "Cannot resolve package startup state for rebuild",
      bail,
    );
    return null;
  }
  const sessionSnapshot = onboardSession.loadSession();
  const sessionMatchesSandbox = sessionSnapshot?.sandboxName === sandboxName;
  const durableConfig = agentAuthority.harnessPackage
    ? resolveReceiptRebuildDurableConfig(
        sb,
        receiptStartupSettings,
        requestedToolDisclosure,
        requestedDcodeAutoApprovalMode,
      )
    : resolveRebuildDurableConfig(
        sandboxName,
        sb,
        sessionSnapshot,
        {
          provider: resumeConfig.provider,
          model: resumeConfig.model,
        },
        requestedToolDisclosure,
        allowLegacyManagedImageRecovery,
        requestedDcodeAutoApprovalMode,
      );
  if (
    !validateRebuildDurableConfig(
      durableConfig,
      resumeConfig,
      bail,
      agentAuthority.harnessPackage != null,
    )
  )
    return null;
  const rejectsCustomDockerfile = agentAuthority.harnessPackage
    ? (receiptStartupSettings?.configuration.autoApprovalMode !== undefined ||
        sb.dcodeAutoApprovalMode !== undefined) &&
      durableConfig.fromDockerfile !== null
    : legacyManagedRebuildRejectsCustomDockerfile(sb, durableConfig.fromDockerfile);
  if (rejectsCustomDockerfile) {
    printRebuildPreflightFailure(
      "the managed package registry entry conflicts with a recorded custom Dockerfile.",
      "Managed package rebuilds must use their verified managed image path.",
      "Managed package rebuild cannot use a recorded custom Dockerfile",
      bail,
    );
    return null;
  }

  const dockerfile = resolveRebuildDockerfile(durableConfig.fromDockerfile);
  if (!dockerfile.ok) {
    printRebuildPreflightFailure(
      "recorded custom Dockerfile is unavailable.",
      `${dockerfile.path}: ${dockerfile.reason}`,
      "Recorded custom Dockerfile is unavailable",
      bail,
    );
    return null;
  }

  const toolGateways = agentAuthority.harnessPackage
    ? receiptStartupSettings
      ? { gateways: [...receiptStartupSettings.tools.enabledGateways], recorded: true }
      : resolveReceiptRebuildToolGateways(sb, sessionSnapshot, sessionMatchesSandbox)
    : resolveLegacyRebuildToolGateways(sb, sessionSnapshot, sessionMatchesSandbox);
  const hermesToolGateways = agentAuthority.harnessPackage
    ? toolGateways.gateways
    : filterLegacyRebuildToolGatewaysForWebSearch(
        sb,
        toolGateways.gateways,
        durableConfig.webSearchConfig
          ? webSearchProviderForConfig(durableConfig.webSearchConfig)
          : null,
      );
  const credentialEnv = resolveRebuildTargetCredentialEnv(
    resumeConfig,
    durableConfig,
    agentAuthority.harnessPackage != null,
    sb.credentialEnv,
  );
  const providerAuthMethod = resolveRebuildTargetProviderAuthMethod(
    sb,
    sessionSnapshot,
    sessionMatchesSandbox,
    agentAuthority.harnessPackage != null,
  );

  return {
    agentAuthority,
    agentDefinition: agentAuthority.definition,
    resumeConfig,
    sessionSnapshot,
    sessionMatchesSandbox,
    durableConfig,
    hermesToolGateways,
    hasHermesToolGateways: toolGateways.recorded,
    credentialEnv,
    providerAuthMethod,
    fromDockerfile: dockerfile.path,
  };
}
