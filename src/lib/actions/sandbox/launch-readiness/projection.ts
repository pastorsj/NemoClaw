// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";

import type { AgentDefinition } from "../../../agent/defs";
import { normalizeInferenceSelection } from "../../../inference/selection";
import { parseServingProfileProvenance } from "../../../inference/serving/profile-provenance";
import { resolveGatewayName } from "../../../onboard/gateway-binding";
import {
  CURRENT_RUNTIME_PROVIDER_BUNDLES,
  resolveRuntimeProviderBundle,
} from "../../../onboard/runtime-provider/access";
import { normalizeSandboxAgentName } from "../../../onboard/sandbox-agent/naming";
import type { SandboxEntry, SandboxWorkloadReceipt } from "../../../state/registry";
import { normalizeSandboxMcpState } from "../../../state/registry-mcp";
import {
  cloneSandboxMessagingState,
  serializeSandboxMessagingStateForDisk,
} from "../../../state/registry-messaging";
import {
  LaunchReadinessEvidenceError,
  LaunchReadinessObservationError as ObservationError,
  resolveLaunchInteractiveCommand,
} from "./health";

export function normalizeLaunchReadinessString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

/** Resolve the gateway identity used by every readiness observation. */
export function resolveLaunchReadinessGatewayName(gatewayPort: number): string {
  return resolveGatewayName(gatewayPort);
}

function exactNonemptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function canonicalize(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  throw new ObservationError("config");
}

export function launchReadinessDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function exactContentDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function projectHostMounts(entry: SandboxEntry): unknown[] {
  return (entry.hostMounts ?? []).map((mount) => {
    const source = exactNonemptyString(mount.source);
    const target = exactNonemptyString(mount.target);
    const device = exactNonemptyString(mount.sourceIdentity?.device);
    const inode = exactNonemptyString(mount.sourceIdentity?.inode);
    if (!source || !target || mount.readOnly !== true || !device || !inode) {
      throw new ObservationError("config");
    }
    return {
      sourceSha256: exactContentDigest(source),
      target,
      readOnly: true,
      sourceIdentity: { device, inode },
    };
  });
}

function projectServingProfile(entry: SandboxEntry): unknown {
  if (entry.servingProfileProvenance === undefined) return null;
  const provenance = parseServingProfileProvenance(entry.servingProfileProvenance);
  if (!provenance) throw new ObservationError("config");
  return {
    schemaVersion: provenance.schemaVersion,
    catalogDigest: provenance.catalogDigest,
    preset: {
      id: provenance.preset.id,
      digest: provenance.preset.digest,
      displayName: provenance.preset.displayName,
      supportState: provenance.preset.supportState,
    },
    recipe: {
      id: provenance.recipe.id,
      digest: provenance.recipe.digest,
      backend: provenance.recipe.backend,
    },
    model: {
      id: provenance.model.id,
      revision: provenance.model.revision,
    },
    runtimeImage: provenance.runtimeImage,
    estimatedImageDownloadBytes: provenance.estimatedImageDownloadBytes,
    estimatedModelDownloadBytes: provenance.estimatedModelDownloadBytes,
  };
}

function projectOptionalBoolean(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new ObservationError("config");
  return value;
}

function projectWorkload(workload: SandboxWorkloadReceipt | undefined): unknown {
  if (!workload) return null;
  if (workload.kind === "legacy-dockerfile") {
    return {
      schemaVersion: workload.schemaVersion,
      kind: workload.kind,
      reference: workload.reference,
      shared: workload.shared,
    };
  }
  if (workload.kind === "managed-image") {
    return {
      schemaVersion: workload.schemaVersion,
      kind: workload.kind,
      reference: workload.reference,
      platform: workload.platform ?? null,
      release: workload.release,
      sourceRevision: workload.sourceRevision,
      sourceCohort: workload.sourceCohort,
      capabilityContractVersion: workload.capabilityContractVersion,
      startupProfileContractVersion: workload.startupProfileContractVersion,
      startupProfileSha256: workload.startupProfileSha256,
      credentialProxyReplayRequired: workload.credentialProxyReplayRequired,
      corporateCaSha256: workload.corporateCaB64
        ? exactContentDigest(workload.corporateCaB64)
        : null,
      shared: workload.shared,
    };
  }
  return {
    schemaVersion: workload.schemaVersion,
    kind: workload.kind,
    contractVersion: workload.contractVersion,
    agent: workload.agent,
    platform: workload.platform,
    artifact: {
      digest: workload.artifact.digest,
      version: workload.artifact.version,
      sourceRepository: workload.artifact.source.repository,
      sourceRevision: workload.artifact.source.revision,
    },
    launch: {
      executableRelativePath: workload.launch.executable.relativePath,
      executableDigest: workload.launch.executable.digest,
      arguments: [...workload.launch.arguments],
      workingDirectory: workload.launch.workingDirectory,
      environmentNames: [...workload.launch.environmentNames],
    },
    startupProfileContractVersion: workload.startupProfileContractVersion,
    startupProfileSha256: workload.startupProfileSha256,
    credentialProxyReplayRequired: workload.credentialProxyReplayRequired,
    shared: workload.shared,
  };
}

function projectMcpState(value: unknown): unknown {
  const state = normalizeSandboxMcpState(value);
  if (!state) return null;
  if (state.destroyPreparedAt || state.destroyPendingAt) throw new ObservationError("config");
  return {
    bridges: Object.values(state.bridges)
      .map((bridge) => {
        if (bridge.addState) throw new ObservationError("config");
        const endpoint = new URL(bridge.url);
        if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
          throw new ObservationError("config");
        }
        return {
          server: bridge.server,
          agent: bridge.agent,
          adapter: bridge.adapter ?? null,
          url: bridge.url,
          env: [...bridge.env],
          trustedPrivateHost: bridge.trustedPrivateHost ?? null,
          allowedIps: bridge.allowedIps ? [...bridge.allowedIps] : null,
          providerName: bridge.providerName ?? null,
          providerId: bridge.providerId ?? null,
          policyName: bridge.policyName,
        };
      })
      .sort((left, right) => left.server.localeCompare(right.server)),
    managedServerNames: [...(state.managedServerNames ?? [])].sort(),
  };
}

function projectMessagingState(entry: SandboxEntry): unknown {
  const state = cloneSandboxMessagingState(entry.messaging);
  const persisted = serializeSandboxMessagingStateForDisk(entry.messaging);
  if (!state || !persisted) return null;
  const originalChannels = new Map(
    state.plan.channels.map((channel) => [channel.channelId, channel]),
  );
  return {
    schemaVersion: persisted.schemaVersion,
    plan: {
      schemaVersion: persisted.plan.schemaVersion,
      sandboxName: persisted.plan.sandboxName,
      agent: persisted.plan.agent,
      workflow: persisted.plan.workflow,
      disabledChannels: [...persisted.plan.disabledChannels],
      channels: persisted.plan.channels.map((channel) => {
        const originalInputs = new Map(
          (originalChannels.get(channel.channelId)?.inputs ?? []).map((input) => [
            input.inputId,
            input,
          ]),
        );
        return {
          channelId: channel.channelId,
          active: channel.active ?? null,
          configured: channel.configured,
          disabled: channel.disabled,
          inputs: (channel.inputs ?? []).map((input) => ({
            inputId: input.inputId,
            credentialAvailable: input.credentialAvailable ?? null,
            value:
              originalInputs.get(input.inputId)?.kind === "config" ? (input.value ?? null) : null,
          })),
          hooks: channel.hooks ?? [],
        };
      }),
      credentialBindings: (persisted.plan.credentialBindings ?? []).map((binding) => ({
        channelId: binding.channelId,
        providerEnvKey: binding.providerEnvKey,
        credentialAvailable: binding.credentialAvailable,
      })),
    },
  };
}

export function projectLaunchReadinessAgent(agent: AgentDefinition): unknown {
  let manifestSha256: string;
  try {
    manifestSha256 = exactContentDigest(fs.readFileSync(agent.manifestPath, "utf8"));
  } catch {
    throw new LaunchReadinessEvidenceError();
  }
  return {
    version: 1,
    manifestSha256,
    name: agent.name,
    binaryPath: agent.binary_path ?? null,
    versionCommand: agent.versionCommand,
    expectedVersion: agent.expectedVersion,
    versionScheme: agent.versionScheme ?? null,
    gatewayCommand: agent.gateway_command ?? null,
    runtime: {
      kind: agent.runtime?.kind ?? "gateway",
      interactiveCommand: agent.runtime?.interactive_command ?? null,
      headlessCommand: agent.runtime?.headless_command ?? null,
      smokeCommands: [...(agent.runtime?.smoke_commands ?? [])],
    },
    forwardPorts: [...(agent.forward_ports ?? [])],
    devicePairing: agent.hasDevicePairing,
    phoneHomeHosts: [...agent.phoneHomeHosts],
    healthProbe: agent.healthProbe
      ? {
          url: agent.healthProbe.url,
          port: agent.healthProbe.port,
          timeoutSeconds: agent.healthProbe.timeout_seconds,
        }
      : null,
    dashboard: {
      kind: agent.dashboard.kind,
      path: agent.dashboard.path,
      healthPath: agent.dashboard.healthPath,
      auth: agent.dashboard.auth,
    },
    webAuth: {
      method: agent.webAuth.method,
      env: agent.webAuth.env,
    },
    dashboardUi: agent.dashboardUi
      ? {
          label: agent.dashboardUi.label,
          port: agent.dashboardUi.port,
          path: agent.dashboardUi.path,
          enableEnv: agent.dashboardUi.enableEnv,
          portEnv: agent.dashboardUi.portEnv,
          tuiEnv: agent.dashboardUi.tuiEnv,
        }
      : null,
    configPaths: {
      dir: agent.configPaths.dir,
      configFile: agent.configPaths.configFile,
      envFile: agent.configPaths.envFile,
      format: agent.configPaths.format,
    },
    inference: {
      providerType: agent.inference?.provider_type ?? null,
      providerOptions: [...agent.inferenceProviderOptions],
      defaultModel: agent.inference?.default_model ?? null,
    },
    mcp: {
      support: agent.mcpCapability.support,
      adapter: agent.mcpCapability.adapter ?? null,
      reason: agent.mcpCapability.reason ?? null,
    },
  };
}

export function resolveLaunchHarnessPackageAuthority(
  entry: SandboxEntry,
  agent: AgentDefinition,
):
  | { readonly status: "absent" }
  | {
      readonly status: "valid";
      readonly harnessPackage: NonNullable<SandboxEntry["harnessPackage"]>;
      readonly harnessPackageMigration: SandboxEntry["harnessPackageMigration"] | null;
    } {
  // The trusted-agent resolver validates the complete receipt and installed
  // package. This projection binds that definition to the same registry
  // identity without adding a second package-resolution path.
  const harnessPackage = entry.harnessPackage;
  if (!harnessPackage) {
    if (entry.harnessPackageMigration) throw new ObservationError("config");
    return { status: "absent" };
  }
  if (
    normalizeSandboxAgentName(entry.agent) !== harnessPackage.id ||
    agent.name !== harnessPackage.id
  ) {
    throw new ObservationError("config");
  }
  return {
    status: "valid",
    harnessPackage,
    harnessPackageMigration: entry.harnessPackageMigration ?? null,
  };
}

/** Build the canonical, secret-free registry evidence covered by a readiness lease. */
export function buildLaunchReadinessRegistryProjection(
  entry: SandboxEntry,
  agent: AgentDefinition,
  portableRuntimeAuthoritySha256: string | null = null,
): unknown {
  const driver = normalizeLaunchReadinessString(entry.openshellDriver)?.toLowerCase() ?? null;
  if (!driver || !resolveRuntimeProviderBundle(driver, CURRENT_RUNTIME_PROVIDER_BUNDLES)) {
    throw new ObservationError("config");
  }
  const openshellVersion = normalizeLaunchReadinessString(entry.openshellVersion);
  const gatewayPort = entry.gatewayPort;
  if (!openshellVersion || openshellVersion.length > 128) throw new ObservationError("config");
  if (!Number.isInteger(gatewayPort) || (gatewayPort ?? 0) < 1 || (gatewayPort ?? 0) > 65535) {
    throw new ObservationError("config");
  }
  const gatewayName = resolveLaunchReadinessGatewayName(gatewayPort as number);
  if (entry.gatewayName !== gatewayName) throw new ObservationError("config");
  const lifecycleGeneration = normalizeLaunchReadinessString(entry.lifecycleGeneration);
  const liveIdentityFingerprint = normalizeLaunchReadinessString(
    entry.lifecycleLiveIdentityFingerprint,
  );
  if (!lifecycleGeneration || !liveIdentityFingerprint) throw new ObservationError("identity");
  if (entry.pendingRouteReservation === true) throw new ObservationError("config");

  const inference = normalizeInferenceSelection(entry);
  if (
    inference.credentialEnv !== null &&
    !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(inference.credentialEnv)
  ) {
    throw new ObservationError("config");
  }
  if (inference.endpointUrl !== null) {
    let endpoint: URL;
    try {
      endpoint = new URL(inference.endpointUrl);
    } catch {
      throw new ObservationError("config");
    }
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    ) {
      throw new ObservationError("config");
    }
  }

  const agentName = normalizeLaunchReadinessString(entry.agent) ?? "openclaw";
  const interactiveCommand = resolveLaunchInteractiveCommand(agent, agentName);
  const sandboxGpuMode = entry.sandboxGpuMode ?? null;
  const sandboxGpuDevice = entry.sandboxGpuDevice ?? null;
  if (sandboxGpuMode !== null && typeof sandboxGpuMode !== "string") {
    throw new ObservationError("config");
  }
  if (sandboxGpuDevice !== null && typeof sandboxGpuDevice !== "string") {
    throw new ObservationError("config");
  }
  const hermesAuthMethod = entry.hermesAuthMethod ?? null;
  if (hermesAuthMethod !== null && hermesAuthMethod !== "oauth" && hermesAuthMethod !== "api_key") {
    throw new ObservationError("config");
  }
  if (
    portableRuntimeAuthoritySha256 !== null &&
    !/^[a-f0-9]{64}$/.test(portableRuntimeAuthoritySha256)
  ) {
    throw new ObservationError("config");
  }
  const packageAuthority = resolveLaunchHarnessPackageAuthority(entry, agent);

  return {
    version: 3,
    name: entry.name,
    openshellDriver: driver,
    openshellVersion,
    gatewayName,
    gatewayPort,
    lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: liveIdentityFingerprint,
    agent: agentName,
    harnessPackage: packageAuthority.status === "valid" ? packageAuthority.harnessPackage : null,
    harnessPackageMigration:
      packageAuthority.status === "valid" ? packageAuthority.harnessPackageMigration : null,
    agentVersion: normalizeLaunchReadinessString(entry.agentVersion),
    nemoclawVersion: normalizeLaunchReadinessString(entry.nemoclawVersion),
    imageTag: normalizeLaunchReadinessString(entry.imageTag),
    workloadIdentitySha256: launchReadinessDigest(projectWorkload(entry.workload)),
    fromDockerfile: normalizeLaunchReadinessString(entry.fromDockerfile),
    servingProfileProvenance: projectServingProfile(entry),
    hostMounts: projectHostMounts(entry),
    gpuEnabled: projectOptionalBoolean(entry.gpuEnabled),
    hostGpuDetected: projectOptionalBoolean(entry.hostGpuDetected),
    sandboxGpuEnabled: projectOptionalBoolean(entry.sandboxGpuEnabled),
    sandboxGpuMode,
    sandboxGpuDevice,
    interactiveCommand,
    sandboxGpuProof: entry.sandboxGpuProof
      ? {
          status: entry.sandboxGpuProof.status,
          cudaVerified: entry.sandboxGpuProof.cudaVerified,
          label: entry.sandboxGpuProof.label ?? null,
        }
      : null,
    inference,
    ...(portableRuntimeAuthoritySha256
      ? { portableLifecycleReceipt: "current", portableRuntimeAuthoritySha256 }
      : {}),
    webSearchEnabled: entry.webSearchEnabled === true,
    webSearchProvider: entry.webSearchProvider ?? null,
    toolDisclosure: entry.toolDisclosure ?? null,
    observabilityEnabled: entry.observabilityEnabled === true,
    dcodeAutoApprovalMode: entry.dcodeAutoApprovalMode ?? null,
    messagingSha256: launchReadinessDigest(projectMessagingState(entry)),
    mcpSha256: launchReadinessDigest(projectMcpState(entry.mcp)),
    hermesToolGateways: [...(entry.hermesToolGateways ?? [])],
    hermesInferenceProvider: normalizeLaunchReadinessString(entry.hermesInferenceProvider),
    hermesAuthMethod,
    hermesDashboardEnabled: entry.hermesDashboardEnabled === true,
    hermesDashboardPort: entry.hermesDashboardPort ?? null,
    hermesDashboardInternalPort: entry.hermesDashboardInternalPort ?? null,
    hermesDashboardTui: entry.hermesDashboardTui === true,
    dashboardPort: entry.dashboardPort ?? null,
    dashboardRemoteBindPrepared: entry.dashboardRemoteBindPrepared === true,
    openclawImagePluginInstalls: (entry.openclawImagePluginInstalls ?? []).map((install) => ({
      id: install.id,
      installPath: install.installPath,
      loadPaths: install.loadPaths ? [...install.loadPaths] : null,
    })),
  };
}
