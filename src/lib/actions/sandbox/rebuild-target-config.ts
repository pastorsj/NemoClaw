// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HarnessStartupSettings } from "@nvidia/nemoclaw-harness-contract";

import type { AgentDefinition } from "../../agent/defs";
import { webSearchProviderForConfig } from "../../inference/web-search";
import type { DcodeAutoApprovalMode } from "../../onboard/dcode-auto-approval";
import type { ResolvedSandboxAgent } from "../../onboard/sandbox-agent";
import type { Session } from "../../state/onboard-session";
import * as onboardSession from "../../state/onboard-session";
import { cloneSandboxWorkloadReceipt } from "../../state/registry/workload";
import {
  decodeManagedStartupDurableProfile,
  isManagedStartupPackageProfile,
} from "../../onboard/managed-startup/profile";
import type { ToolDisclosure } from "../../tool-disclosure";
import type { RebuildBail } from "./rebuild-credential-preflight";
import {
  type RebuildDurableConfig,
  resolveRebuildDockerfile,
  resolveRebuildDurableConfig,
} from "./rebuild-durable-config";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import { printRebuildPreflightFailure } from "./rebuild-preflight-error";
import { prepareRebuildResumeConfig, type RebuildResumeConfig } from "./rebuild-resume-config";
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
  fromDockerfile: string | null;
};

function readRecordedStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item: unknown): item is string => typeof item === "string");
}

function resolveRecordedRebuildToolGateways(
  sb: RebuildSandboxEntry,
  session: Session | null,
  sessionMatchesSandbox: boolean,
): { gateways: string[]; recorded: boolean } {
  const registryGateways = readRecordedStringList(sb.hermesToolGateways);
  const sessionGateways = sessionMatchesSandbox
    ? readRecordedStringList(session?.hermesToolGateways)
    : null;
  return {
    gateways: registryGateways ?? sessionGateways ?? [],
    recorded: registryGateways !== null || sessionGateways !== null,
  };
}

export function resolveReceiptRebuildStartupSettings(
  sb: RebuildSandboxEntry,
  agentAuthority: ResolvedSandboxAgent,
): HarnessStartupSettings | null {
  const receipt = agentAuthority.harnessPackage;
  if (!receipt) return null;
  // Package receipts predate managed startup-profile receipts. Keep those
  // rows on their already-validated registry/session state until rebuild
  // writes a current workload receipt; never guess from a different profile.
  if (sb.workload?.kind !== "managed-image") return null;
  const workload = cloneSandboxWorkloadReceipt(sb.workload, { harnessPackage: receipt });
  if (workload?.kind !== "managed-image") {
    throw new Error("receipt-backed rebuild has no exact managed startup profile");
  }
  const profile = decodeManagedStartupDurableProfile(workload.encodedProfile);
  if (!isManagedStartupPackageProfile(profile) || profile.agent !== receipt.id) {
    throw new Error("receipt-backed rebuild startup profile does not match its package authority");
  }
  return profile.desiredState;
}

function validateRebuildDurableConfig(
  durableConfig: RebuildDurableConfig,
  resumeConfig: RebuildResumeConfig,
  bail: RebuildBail,
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
      "recorded DCode auto-approval state is invalid.",
      durableConfig.dcodeAutoApprovalModeError,
      "Recorded DCode auto-approval state is invalid",
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
    durableConfig.hermesAuthMethodError ||
    (resumeConfig.provider === hermesProviderAuth.HERMES_PROVIDER_NAME &&
      durableConfig.hermesAuthMethod === null)
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
  const legacyDurableConfig = resolveRebuildDurableConfig(
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
  const durableConfig = receiptStartupSettings
    ? {
        ...legacyDurableConfig,
        dcodeAutoApprovalMode: receiptStartupSettings.configuration.autoApprovalMode ?? "disabled",
        dcodeAutoApprovalModeError: null,
        toolDisclosure: receiptStartupSettings.tools.disclosure,
        toolDisclosureError: null,
        webSearchConfig: receiptStartupSettings.configuration.webSearch?.enabled
          ? {
              fetchEnabled: true,
              provider: receiptStartupSettings.configuration.webSearch.provider,
            }
          : null,
        webSearchError: null,
      }
    : legacyDurableConfig;
  if (!validateRebuildDurableConfig(durableConfig, resumeConfig, bail)) return null;
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

  const toolGateways = receiptStartupSettings
    ? { gateways: [...receiptStartupSettings.tools.enabledGateways], recorded: true }
    : agentAuthority.harnessPackage
      ? resolveRecordedRebuildToolGateways(sb, sessionSnapshot, sessionMatchesSandbox)
      : resolveLegacyRebuildToolGateways(sb, sessionSnapshot, sessionMatchesSandbox);
  const hermesToolGateways = receiptStartupSettings
    ? toolGateways.gateways
    : agentAuthority.harnessPackage
      ? durableConfig.webSearchConfig &&
        webSearchProviderForConfig(durableConfig.webSearchConfig) === "tavily"
        ? toolGateways.gateways.filter((gateway) => gateway !== "nous-web")
        : toolGateways.gateways
      : filterLegacyRebuildToolGatewaysForWebSearch(
          sb,
          toolGateways.gateways,
          durableConfig.webSearchConfig
            ? webSearchProviderForConfig(durableConfig.webSearchConfig)
            : null,
        );
  const credentialEnv =
    resumeConfig.provider === hermesProviderAuth.HERMES_PROVIDER_NAME
      ? durableConfig.hermesAuthMethod === "api_key"
        ? hermesProviderAuth.HERMES_NOUS_API_KEY_CREDENTIAL_ENV
        : hermesProviderAuth.HERMES_INFERENCE_CREDENTIAL_ENV
      : resumeConfig.credentialEnv;

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
    fromDockerfile: dockerfile.path,
  };
}
