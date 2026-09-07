// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import type { CaptureOpenshellResult } from "./adapters/openshell/client";
import { captureOpenshellCommand } from "./adapters/openshell/client";
import { resolveOpenshell } from "./adapters/openshell/resolve";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "./adapters/openshell/timeouts";
import { isObjectRecord } from "./core/json-types";
import { GATEWAY_PORT } from "./core/ports";
import { getNamedGatewayLifecycleState } from "./gateway-runtime-action";
import { getLiveGatewayInference } from "./inference/live";
import type {
  GatewayHealth,
  MessagingBridgeHealth,
  MessagingOverlap,
  ShowStatusCommandDeps,
} from "./inventory";
import {
  createBuiltInChannelManifestRegistry,
  createBuiltInMessagingHookRegistry,
  findAllOverlaps,
  hydrateMessagingRegistryEntriesForAuthority,
  listLegacyMessagingChannels,
  listMessagingChannelsForProfile,
  resolveSandboxMessagingProfileAuthority,
  runMessagingStatusHooks,
  type ChannelManifest,
  type MessagingAgentId,
  type MessagingStatusHookRunResult,
} from "./messaging/status";
import { resolveGatewayName } from "./onboard/gateway-binding";
import { defaultPortableDemoStateDir } from "./onboard/experimental/portable-runtime-receipt-readiness";
import { getQualifiedHermesPortablePhase } from "./actions/sandbox/portable-status";
import * as policy from "./policy";
import { summarizeForDebug } from "./state/onboard-session";
import * as registry from "./state/registry";
import { getHermesPortableHostAuthorityEntryCount } from "./state/portable-uninstall-retirement";
import { createSystemDeps, parseSshProcesses } from "./state/sandbox-session";
import { getServiceStatuses, showStatus as showServiceStatus } from "./tunnel/services";

const INVENTORY_POLICY_PROBE_TIMEOUT_MS = 2_000;
const statusChannelManifestRegistry = createBuiltInChannelManifestRegistry();

type MessagingStatusProfile = Readonly<{
  key: string;
  agent: MessagingAgentId;
  manifests: readonly ChannelManifest[];
}>;

function hasRecordedHarnessPackageAuthority(entry: registry.SandboxEntry): boolean {
  return (
    Object.prototype.hasOwnProperty.call(entry, "harnessPackage") ||
    Object.prototype.hasOwnProperty.call(entry, "harnessPackageMigration")
  );
}

/** Keep source manifests confined to explicit no-receipt compatibility rows. */
function resolveMessagingStatusProfile(
  entry: registry.SandboxEntry | null | undefined,
  legacyAgent?: string | null,
): MessagingStatusProfile {
  if (!entry || !hasRecordedHarnessPackageAuthority(entry)) {
    const agent = normalizeMessagingAgentId(entry?.agent ?? legacyAgent);
    return Object.freeze({
      key: `legacy:${agent}`,
      agent,
      manifests: listLegacyMessagingChannels(agent, statusChannelManifestRegistry),
    });
  }

  const authority = resolveSandboxMessagingProfileAuthority(entry);
  const identity = authority.packageAuthority.harnessPackage;
  if (!identity) {
    throw new Error("Receipt-backed messaging status requires exact harness package authority");
  }
  return Object.freeze({
    key: `package:${identity.id}:${identity.packageVersion}:${identity.contentDigest}`,
    agent: authority.agent.name,
    manifests: listMessagingChannelsForProfile(authority, statusChannelManifestRegistry),
  });
}

function captureOpenshell(
  rootDir: string,
  args: string[],
  opts: { timeout?: number } = {},
): CaptureOpenshellResult {
  const openshell = resolveOpenshell();
  if (!openshell) {
    return { status: 1, output: "" };
  }
  return captureOpenshellCommand(openshell, args, {
    cwd: rootDir,
    ignoreError: true,
    timeout: opts.timeout,
  });
}

function checkMessagingBridgeHealth(
  rootDir: string,
  sandboxName: string,
  channels: string[],
  agent: string | null | undefined = "openclaw",
): MessagingBridgeHealth[] {
  const channelSet = new Set(Array.isArray(channels) ? channels : []);
  // Validate receipt authority even when the runtime probe is unavailable. A
  // missing OpenShell binary can suppress a hook, but must not make a damaged
  // package receipt look like a healthy no-op.
  const profile = resolveMessagingStatusProfile(registry.getSandbox(sandboxName), agent);
  const openshell = resolveOpenshell();
  if (!openshell) return [];

  return runMessagingStatusHooks({
    agent: profile.agent,
    channels: channelSet,
    currentSandbox: sandboxName,
    registryEntries: safeListRegistryEntries(),
    hookRegistry: createBuiltInMessagingHookRegistry({
      telegram: {
        gatewayConflictStatus: {
          executeSandboxCommand: (name, command, timeoutMs) =>
            executeSandboxCommand(rootDir, openshell, name, command, timeoutMs),
        },
      },
    }),
    manifests: profile.manifests,
  }).flatMap(readBridgeHealthOutputs);
}

function findMessagingOverlaps() {
  const { sandboxes: storedSandboxes } = registry.listSandboxes();
  // Receipt and profile resolution is an authority boundary, not an advisory
  // hook. Let it fail the command instead of turning invalid package state into
  // an empty (apparently healthy) overlap report.
  const profiles = uniqueMessagingStatusProfiles(storedSandboxes);
  const sandboxes = hydrateMessagingRegistryEntriesForAuthority(storedSandboxes);
  // Hook execution and overlap classification remain non-critical after exact
  // authority has been established, so those advisory failures yield no rows.
  try {
    // Report both conflict axes independently and without deduping. They are
    // distinct, both-true facts: a shared messaging credential conflicts on any
    // gateway, while channel-owned status hooks can report non-credential
    // runtime exclusivity such as Slack Socket Mode on one gateway.
    const credentialOverlaps = findAllOverlaps({
      listSandboxes: () => ({ sandboxes }),
    });
    const statusOverlaps = profiles.flatMap((profile) =>
      runMessagingStatusHooks({
        agent: profile.agent,
        manifests: profile.manifests,
        registryEntries: sandboxes,
      }).flatMap(readOverlapOutputs),
    );
    return [...credentialOverlaps, ...statusOverlaps];
  } catch {
    return [];
  }
}

function normalizeMessagingAgentId(agent: string | null | undefined): MessagingAgentId {
  const normalized = agent?.trim().toLowerCase();
  return normalized || "openclaw";
}

function executeSandboxCommand(
  rootDir: string,
  openshell: string,
  sandboxName: string,
  command: string,
  timeoutMs: number,
): {
  readonly status?: number | null;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
} | null {
  try {
    const result = spawnSync(
      openshell,
      ["sandbox", "exec", "-n", sandboxName, "--", "sh", "-c", command],
      { cwd: rootDir, encoding: "utf-8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] },
    );
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch {
    return null;
  }
}

function safeListRegistryEntries(): readonly registry.SandboxEntry[] {
  let entries: readonly registry.SandboxEntry[];
  try {
    entries = registry.listSandboxes().sandboxes;
  } catch {
    return [];
  }
  return hydrateMessagingRegistryEntriesForAuthority(entries);
}

function uniqueMessagingStatusProfiles(
  entries: readonly registry.SandboxEntry[],
): MessagingStatusProfile[] {
  const profiles = new Map<string, MessagingStatusProfile>();
  for (const entry of entries) {
    const profile = resolveMessagingStatusProfile(entry);
    if (!profiles.has(profile.key)) profiles.set(profile.key, profile);
  }
  if (profiles.size === 0) {
    const profile = resolveMessagingStatusProfile(null, "openclaw");
    profiles.set(profile.key, profile);
  }
  return [...profiles.values()];
}

function readBridgeHealthOutputs(result: MessagingStatusHookRunResult): MessagingBridgeHealth[] {
  return Object.values(result.outputs).flatMap((output) => {
    if (output.kind !== "status" || !isObjectRecord(output.value)) return [];
    if (output.value.type !== "messaging-bridge-health") return [];
    const channel = stringField(output.value.channel) ?? result.channelId;
    const conflicts = numberField(output.value.conflicts);
    return conflicts > 0 ? [{ channel, conflicts }] : [];
  });
}

function readOverlapOutputs(result: MessagingStatusHookRunResult): MessagingOverlap[] {
  return Object.values(result.outputs).flatMap((output) => {
    if (output.kind !== "status" || !isObjectRecord(output.value)) return [];
    if (output.value.type !== "messaging-overlaps" || !Array.isArray(output.value.overlaps)) {
      return [];
    }
    return output.value.overlaps.flatMap((entry) => {
      if (!isObjectRecord(entry) || !isStringPair(entry.sandboxes)) return [];
      return [
        {
          channel: stringField(entry.channel) ?? result.channelId,
          sandboxes: entry.sandboxes,
          ...(typeof entry.reason === "string" ? { reason: entry.reason } : {}),
          ...(typeof entry.message === "string" ? { message: entry.message } : {}),
          ...(typeof entry.port === "number" ? { port: entry.port } : {}),
        },
      ];
    });
  });
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isStringPair(value: unknown): value is [string, string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "string"
  );
}

function readGatewayLog(rootDir: string, sandboxName: string): string | null {
  const openshell = resolveOpenshell();
  if (!openshell) return null;
  try {
    const result = spawnSync(
      openshell,
      [
        "sandbox",
        "exec",
        "-n",
        sandboxName,
        "--",
        "sh",
        "-c",
        "tail -n 10 /tmp/gateway.log 2>/dev/null",
      ],
      { cwd: rootDir, encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] },
    );
    const output = (result.stdout || "").trim();
    return output || null;
  } catch {
    return null;
  }
}

function probeGatewayHealth(): GatewayHealth {
  try {
    const expectedGateway = resolveGatewayName(GATEWAY_PORT);
    const lifecycle = getNamedGatewayLifecycleState(expectedGateway);
    if (lifecycle.state === "healthy_named") {
      return { healthy: true, state: lifecycle.state };
    }
    const reasonByState: Record<string, string> = {
      named_unreachable: "host port held or container not running",
      named_unhealthy: "named gateway present but not Connected",
      connected_other: `connected to '${lifecycle.activeGateway ?? "unknown"}', not '${expectedGateway}'`,
      missing_named: "named gateway not configured",
    };
    return {
      healthy: false,
      state: lifecycle.state,
      reason: reasonByState[lifecycle.state],
    };
  } catch {
    // A transient probe failure must not mask a real gateway problem, but
    // we also can't claim it's unhealthy when we genuinely couldn't tell.
    // Report it as a soft degraded state so the user still sees a hint.
    return { healthy: false, state: "probe_error", reason: "could not reach OpenShell CLI" };
  }
}

export function buildStatusCommandDeps(rootDir: string): ShowStatusCommandDeps {
  const opsBin = resolveOpenshell();
  const sessionDeps = opsBin ? createSystemDeps(opsBin) : null;
  const onboardSummary = summarizeForDebug();
  // Cache the SSH process probe once per command invocation — avoids
  // spawning ps per sandbox row. #2604; mirrors buildListCommandDeps.
  let cachedSshOutput: string | null | undefined;

  // Resolving a sandbox ID costs one OpenShell call, so only pay it when the
  // process list actually contains a proxied connection that needs one (#9316).
  const resolveSandboxIdForSessions = (sshOutput: string, name: string): string | null =>
    sshOutput.includes("--sandbox-id") ? (sessionDeps?.resolveSandboxId?.(name) ?? null) : null;

  const getCachedSshOutput = (): string | null => {
    if (cachedSshOutput === undefined && sessionDeps) {
      try {
        cachedSshOutput = sessionDeps.getSshProcesses();
      } catch {
        cachedSshOutput = null;
      }
    }
    return cachedSshOutput ?? null;
  };

  return {
    listSandboxes: () => registry.listSandboxes(),
    getPolicyPresets: (sandboxName) => {
      try {
        return policy.getAppliedPresets(sandboxName, INVENTORY_POLICY_PROBE_TIMEOUT_MS);
      } catch {
        return [];
      }
    },
    getLiveInference: () =>
      getLiveGatewayInference(
        (args, opts) =>
          captureOpenshell(rootDir, args, {
            timeout: opts?.timeout,
          }),
        {
          gatewayName: resolveGatewayName(GATEWAY_PORT),
          timeout: OPENSHELL_PROBE_TIMEOUT_MS,
        },
      ).inference,
    showServiceStatus,
    getServiceStatuses,
    getGatewayHealth: probeGatewayHealth,
    getGatewayAuthority: () => onboardSummary?.gatewayAuthority ?? null,
    loadLastSession: () => onboardSummary,
    getActiveSessionCount: sessionDeps
      ? (name) => {
          try {
            const sshOutput = getCachedSshOutput();
            if (sshOutput === null) return null;
            return parseSshProcesses(sshOutput, name, resolveSandboxIdForSessions(sshOutput, name))
              .length;
          } catch {
            return null;
          }
        }
      : undefined,
    checkMessagingBridgeHealth: (sandboxName, channels, agent) =>
      checkMessagingBridgeHealth(rootDir, sandboxName, channels, agent),
    findMessagingOverlaps,
    readGatewayLog: (sandboxName) => readGatewayLog(rootDir, sandboxName),
    getHermesPortablePhase: getQualifiedHermesPortablePhase,
    getHermesPortableHostAuthorityCount: () =>
      getHermesPortableHostAuthorityEntryCount(defaultPortableDemoStateDir(process.env)),
    log: console.log,
  };
}
