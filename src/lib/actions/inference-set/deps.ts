// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { captureOpenshell, getOpenshellBinary } from "../../adapters/openshell/runtime";
import { loadHarnessConfigAdapterHostModule } from "../../agent-runtime/config-module";
import { resolveContextWindowForModel } from "../../inference/context-window";
import { withGatewayRouteMutationLock } from "../../inference/gateway-route-mutation-lock";
import {
  ensureHttpsPinRuntimeAdapter,
  revokeHttpsPinRuntimeAdapterRoute,
} from "../../inference/https-pin-runtime-adapter";
import { validateLocalProvider } from "../../inference/local";
import { ensureLocalProviderReachable } from "../../onboard/local-inference-topology";
import {
  preserveConfigReadAuthority,
  readSandboxConfig,
  recomputeSandboxConfigHash,
  resolveAgentConfig,
  rewriteConfigUrlsWithDnsPinning,
  seedHermesDashboardConfig,
  writeSandboxConfig,
} from "../../sandbox/config";
import { inspectInstalledInferenceConfigSupport } from "../../sandbox/package-config";
import { reconcilePackageSandbox } from "../../sandbox/package-reconcile";
import * as onboardSession from "../../state/onboard-session";
import { appendAuditEntry } from "../../state/audit/operational";
import * as registry from "../../state/registry";
import { defaultInferenceGatewayRestart } from "../inference-set-gateway-restart";
import { settleLegacyOpenClawPairing } from "./legacy";
import {
  probeInferenceSetSandboxRoute,
  sleepInferenceSetRouteConvergence,
} from "../inference-set-provider";
import type { InferenceSetDeps } from "./types";

export function createInferenceSetDeps(): InferenceSetDeps {
  return {
    getDefaultSandbox: registry.getDefault,
    getSandbox: registry.getSandbox,
    listSandboxes: registry.listSandboxes,
    updateSandbox: registry.updateSandbox,
    getRequestedAgent: () => process.env.NEMOCLAW_AGENT,
    loadSession: onboardSession.loadSession,
    updateSession: onboardSession.updateSession,
    resolveAgentConfig,
    inspectInstalledInferenceConfigSupport,
    preparePackageInferenceConfig: (identity, request) =>
      loadHarnessConfigAdapterHostModule(identity).prepareInferenceConfig(request),
    preserveConfigReadAuthority,
    readSandboxConfig,
    writeSandboxConfig,
    recomputeSandboxConfigHash,
    seedHermesDashboardConfig,
    prepareRunOpenshell: () => {
      getOpenshellBinary();
    },
    captureOpenshell: (args, options) => captureOpenshell(args, options),
    appendAuditEntry,
    log: console.log,
    isLocalInferenceProvider: (provider) =>
      provider === "ollama-local" || provider === "vllm-local",
    validateLocalProvider,
    ensureLocalProviderReachable,
    resolveContextWindowForModel,
    rewriteConfigUrlsWithDnsPinning,
    resolveCredentialValue: (credentialEnv) => process.env[credentialEnv] ?? "",
    ensureHttpsPinRuntimeAdapter: (options) => {
      if (!options.discoverAllowedSourceCidrs) {
        throw new Error("HTTPS Pin Runtime adapter is missing runtime-provider network authority.");
      }
      return ensureHttpsPinRuntimeAdapter({
        ...options,
        discoverAllowedSourceCidrs: options.discoverAllowedSourceCidrs,
      });
    },
    revokeHttpsPinRuntimeAdapterRoute,
    probeSandboxRoute: probeInferenceSetSandboxRoute,
    sleep: sleepInferenceSetRouteConvergence,
    withGatewayRouteMutationLock,
    restartSandboxGateway: defaultInferenceGatewayRestart,
    reconcilePackageSandbox,
    settleLegacyPairing: settleLegacyOpenClawPairing,
  };
}
