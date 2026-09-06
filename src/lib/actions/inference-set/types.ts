// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  CaptureOpenshellOptions,
  CaptureOpenshellResult,
} from "../../adapters/openshell/client";
import type {
  HarnessInferenceConfigUpdatePlan,
  HarnessInferenceConfigUpdateRequest,
} from "../../agent-runtime/config-module";
import type { HarnessPackageIdentity } from "../../agent-runtime/package/types";
import type { ValidationResult } from "../../inference/local";
import type { AgentConfigTarget, HermesDashboardReseedResult } from "../../sandbox/config";
import type { InstalledInferenceConfigSupport } from "../../sandbox/package-config";
import type { ConfigObject, ConfigValue } from "../../security/credential-filter";
import type * as onboardSession from "../../state/onboard-session";
import type { SandboxEntry } from "../../state/registry";
import type { InferenceGatewayRestartDeps } from "../inference-set-gateway-restart";
import type { LegacyOpenClawPairingResult, LegacyOpenClawPairingTarget } from "./legacy";
import type {
  InferenceSetSandboxRouteProbe,
  RuntimeProviderBundleRegistry,
} from "../inference-set-provider";
import type { EnsureHttpsPinRuntimeAdapterFn } from "../inference-set-route-containment";
import type { withGatewayRouteMutationLock } from "../../inference/gateway-route-mutation-lock";

export interface InferenceSetOptions {
  provider: string;
  model: string;
  sandboxName?: string | null;
  noVerify?: boolean;
  endpointUrl?: string | null;
  credentialEnv?: string | null;
  inferenceApi?: string | null;
  reasoningEffort?: string | null;
}

export interface InferenceSetResult {
  sandboxName: string;
  provider: string;
  model: string;
  primaryModelRef: string;
  providerKey: string;
  configChanged: boolean;
  sessionUpdated: boolean;
  inSandboxConfigSynced: boolean;
}

export interface InferenceSetDeps extends InferenceGatewayRestartDeps {
  getDefaultSandbox: () => string | null;
  getSandbox: (name: string) => SandboxEntry | null;
  listSandboxes: () => {
    sandboxes: SandboxEntry[];
    defaultSandbox: string | null;
  };
  updateSandbox: (name: string, updates: Partial<SandboxEntry>) => boolean;
  getRequestedAgent: () => string | null | undefined;
  loadSession: () => onboardSession.Session | null;
  updateSession: (
    mutator: (session: onboardSession.Session) => onboardSession.Session | void,
  ) => onboardSession.Session;
  resolveAgentConfig: (sandboxName: string) => AgentConfigTarget;
  inspectInstalledInferenceConfigSupport: (
    sandboxName: string,
    target: AgentConfigTarget,
  ) => InstalledInferenceConfigSupport;
  preparePackageInferenceConfig: (
    identity: HarnessPackageIdentity,
    request: HarnessInferenceConfigUpdateRequest,
  ) => HarnessInferenceConfigUpdatePlan;
  preserveConfigReadAuthority: (previous: ConfigObject, next: ConfigObject) => ConfigObject;
  readSandboxConfig: (sandboxName: string, target: AgentConfigTarget) => ConfigObject;
  writeSandboxConfig: (
    sandboxName: string,
    target: AgentConfigTarget,
    config: ConfigObject,
  ) => void;
  runtimeProviders?: RuntimeProviderBundleRegistry;
  recomputeSandboxConfigHash: (sandboxName: string, target: AgentConfigTarget) => void;
  seedHermesDashboardConfig: (
    sandboxName: string,
    target: AgentConfigTarget,
  ) => HermesDashboardReseedResult;
  prepareRunOpenshell: () => void;
  captureOpenshell: (
    args: string[],
    opts?: Pick<
      CaptureOpenshellOptions,
      "env" | "ignoreError" | "includeStreams" | "maxBuffer" | "timeout"
    >,
  ) => CaptureOpenshellResult;
  isLocalInferenceProvider: (provider: string) => boolean;
  validateLocalProvider: (provider: string) => ValidationResult;
  ensureLocalProviderReachable: (provider: string) => boolean;
  resolveContextWindowForModel: (provider: string, model: string) => number | null;
  rewriteConfigUrlsWithDnsPinning: (value: ConfigValue) => Promise<ConfigValue>;
  resolveCredentialValue: (credentialEnv: string) => string;
  ensureHttpsPinRuntimeAdapter: EnsureHttpsPinRuntimeAdapterFn;
  revokeHttpsPinRuntimeAdapterRoute: (routeId: string) => Promise<boolean>;
  probeSandboxRoute: InferenceSetSandboxRouteProbe;
  sleep: (milliseconds: number) => Promise<void>;
  withGatewayRouteMutationLock: typeof withGatewayRouteMutationLock;
  settleLegacyPairing: (target: LegacyOpenClawPairingTarget) => LegacyOpenClawPairingResult;
}
