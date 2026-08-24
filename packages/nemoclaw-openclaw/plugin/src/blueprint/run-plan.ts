// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { DASHBOARD_PORT } from "../lib/ports.js";
import { isPlainObject, type UnknownRecord } from "../shared/object-record.js";
import {
  DEFAULT_ROUTER_PORT,
  isOptionalPortList,
  isPolicyAdditions,
  isValidPort,
  type InferenceProfile,
  type PolicyAdditions,
  type RouterConfig,
  type SandboxConfig,
} from "./blueprint-config.js";
import {
  buildRuntimeIdentityPlan,
  isRuntimeIdentityReceipt,
  type RuntimeIdentityConfig,
  type RuntimeIdentityPlan,
  type RuntimeIdentityReceipt,
} from "./runtime-identity.js";

export interface RunPlan {
  run_id: string;
  profile: string;
  sandbox: {
    image: string;
    name: string;
    forward_ports: number[];
  };
  inference: {
    provider_type: string | undefined;
    provider_name: string | undefined;
    endpoint: string | undefined;
    model: string | undefined;
  };
  router: {
    enabled: boolean;
    port: number;
    pool_config_path: string | undefined;
  };
  identity?: RuntimeIdentityPlan;
  policy_additions: PolicyAdditions;
  dry_run: boolean;
}

interface SafeInferencePlan {
  provider_type: string | undefined;
  provider_name: string | undefined;
  endpoint: string | undefined;
  model: string | undefined;
}

export interface PersistedRunPlan {
  run_id: string;
  profile: string;
  sandbox_name: string;
  sandbox_created_by_apply: boolean;
  inference_provider_created_by_apply: boolean;
  policy_additions: PolicyAdditions;
  inference: SafeInferencePlan;
  identity?: RuntimeIdentityReceipt;
  timestamp: string;
}

export type StatusRunPlan = {
  run_id: string;
  profile?: string;
  sandbox?: {
    image?: string;
    name?: string;
    forward_ports?: number[];
  };
  sandbox_name?: string;
  sandbox_created_by_apply?: boolean;
  inference_provider_created_by_apply?: boolean;
  policy_additions?: PolicyAdditions;
  inference?: SafeInferencePlan;
  identity?: RuntimeIdentityReceipt;
  router?: {
    enabled?: boolean;
    port?: number;
    pool_config_path?: string;
  };
  timestamp?: string;
  dry_run?: boolean;
};

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function buildSafeInferencePlan(source: InferenceProfile | UnknownRecord): SafeInferencePlan {
  return {
    provider_type: optionalString(source.provider_type),
    provider_name: optionalString(source.provider_name),
    endpoint: optionalString(source.endpoint),
    model: optionalString(source.model),
  };
}

export function buildSafePublicRunPlan(args: {
  runId: string;
  profile: string;
  inferenceCfg: InferenceProfile;
  sandboxCfg: SandboxConfig;
  routerCfg: RouterConfig;
  runtimeIdentityConfig?: RuntimeIdentityConfig;
  policyAdditions: PolicyAdditions;
  dryRun: boolean;
}): RunPlan {
  const routerEnabled = args.routerCfg.enabled === true;
  const routerPort = args.routerCfg.port ?? DEFAULT_ROUTER_PORT;

  const plan: RunPlan = {
    run_id: args.runId,
    profile: args.profile,
    sandbox: {
      image: args.sandboxCfg.image ?? "openclaw",
      name: args.sandboxCfg.name ?? "openclaw",
      forward_ports: args.sandboxCfg.forward_ports ?? [DASHBOARD_PORT],
    },
    inference: buildSafeInferencePlan(args.inferenceCfg),
    router: {
      enabled: routerEnabled,
      port: routerPort,
      pool_config_path: args.routerCfg.pool_config_path,
    },
    policy_additions: args.policyAdditions,
    dry_run: args.dryRun,
  };
  if (args.runtimeIdentityConfig) {
    plan.identity = buildRuntimeIdentityPlan(args.runtimeIdentityConfig);
  }
  return plan;
}

export function buildPersistedRunPlan(args: {
  runId: string;
  profile: string;
  sandboxName: string;
  sandboxCreatedByApply: boolean;
  inferenceProviderCreatedByApply: boolean;
  policyAdditions: PolicyAdditions;
  inferenceCfg: InferenceProfile;
  runtimeIdentityReceipt?: RuntimeIdentityReceipt;
  timestamp: string;
}): PersistedRunPlan {
  const plan: PersistedRunPlan = {
    run_id: args.runId,
    profile: args.profile,
    sandbox_name: args.sandboxName,
    sandbox_created_by_apply: args.sandboxCreatedByApply,
    inference_provider_created_by_apply: args.inferenceProviderCreatedByApply,
    policy_additions: args.policyAdditions,
    inference: buildSafeInferencePlan(args.inferenceCfg),
    timestamp: args.timestamp,
  };
  if (args.runtimeIdentityReceipt) {
    plan.identity = args.runtimeIdentityReceipt;
  }
  return plan;
}

export function buildStatusRunPlan(source: unknown, fallbackRunId: string): StatusRunPlan | null {
  if (!isPlainObject(source)) {
    return null;
  }

  const safePlan: StatusRunPlan = {
    run_id: optionalString(source.run_id) ?? fallbackRunId,
  };

  const profile = optionalString(source.profile);
  if (profile !== undefined) {
    safePlan.profile = profile;
  }

  if (isPlainObject(source.sandbox)) {
    const sandbox: StatusRunPlan["sandbox"] = {};
    const image = optionalString(source.sandbox.image);
    const name = optionalString(source.sandbox.name);
    const forwardPorts = isOptionalPortList(source.sandbox.forward_ports)
      ? source.sandbox.forward_ports
      : undefined;
    if (image !== undefined) {
      sandbox.image = image;
    }
    if (name !== undefined) {
      sandbox.name = name;
    }
    if (forwardPorts !== undefined) {
      sandbox.forward_ports = forwardPorts;
    }
    if (Object.keys(sandbox).length > 0) {
      safePlan.sandbox = sandbox;
    }
  }

  const sandboxName = optionalString(source.sandbox_name);
  if (sandboxName !== undefined) {
    safePlan.sandbox_name = sandboxName;
  }
  if (typeof source.sandbox_created_by_apply === "boolean") {
    safePlan.sandbox_created_by_apply = source.sandbox_created_by_apply;
  }
  if (typeof source.inference_provider_created_by_apply === "boolean") {
    safePlan.inference_provider_created_by_apply = source.inference_provider_created_by_apply;
  }

  if (isPolicyAdditions(source.policy_additions)) {
    safePlan.policy_additions = source.policy_additions;
  }

  if (isPlainObject(source.inference)) {
    safePlan.inference = buildSafeInferencePlan(source.inference);
  }

  if (isRuntimeIdentityReceipt(source.identity)) {
    safePlan.identity = source.identity;
  }

  if (isPlainObject(source.router)) {
    const router: StatusRunPlan["router"] = {};
    if (typeof source.router.enabled === "boolean") {
      router.enabled = source.router.enabled;
    }
    if (isValidPort(source.router.port)) {
      router.port = source.router.port;
    }
    const poolConfigPath = optionalString(source.router.pool_config_path);
    if (poolConfigPath !== undefined) {
      router.pool_config_path = poolConfigPath;
    }
    if (Object.keys(router).length > 0) {
      safePlan.router = router;
    }
  }

  const timestamp = optionalString(source.timestamp);
  if (timestamp !== undefined) {
    safePlan.timestamp = timestamp;
  }
  if (typeof source.dry_run === "boolean") {
    safePlan.dry_run = source.dry_run;
  }

  return safePlan;
}
