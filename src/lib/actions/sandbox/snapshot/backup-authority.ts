// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { dockerSpawnSync } from "../../../adapters/docker/exec";
import type { AgentDefinition } from "../../../agent/defs";
import { cloneAndDeepFreeze } from "../../../core/immutable";
import {
  harnessPackageIdentitiesEqual,
  inspectHarnessPackageState,
  type HarnessPackageIdentity,
} from "../../../agent-runtime/package/identity";
import {
  resolvePinnedHarnessPackage,
  type InstalledHarnessPackage,
} from "../../../agent-runtime/package/store";
import { resolveSandboxAgent, type ResolvedSandboxAgent } from "../../../onboard/sandbox-agent";
import type { RuntimeProviderBundle } from "../../../onboard/runtime-provider/contract";
import { CURRENT_RUNTIME_PROVIDER_BUNDLES } from "../../../onboard/runtime-provider/current";
import {
  confirmHostLocalInferenceAuthority,
  prepareSandboxHostLocalInferenceAuthority,
} from "../../../onboard/runtime-provider/host-local-inference-lifecycle";
import { requireRuntimeProviderBundleForSandbox } from "../../../onboard/runtime-provider/registry";
import type { SandboxEntry } from "../../../state/registry/types";
import * as sandboxState from "../../../state/sandbox";
import {
  executePrivilegedSandboxCommand,
  withPrivilegedSandboxExecutionLease,
} from "../../../sandbox/privileged-exec";
import { sanitizeReadinessText } from "../../../readiness/sanitize";
import { readManagedSnapshotProfileAuthority } from "./managed-profile";
import { captureSandboxRuntimeSnapshot } from "./provider-lifecycle";

type SnapshotBackupAuthority = Pick<
  sandboxState.BackupOptions,
  | "runtimeSnapshot"
  | "workload"
  | "agentDefinition"
  | "harnessPackage"
  | "hostLocalInferenceReceipt"
  | "hostLocalInferenceProvenance"
  | "validateBeforePublish"
>;

interface SnapshotBackupAuthorityDependencies {
  readonly getSandbox: (sandboxName: string) => SandboxEntry | null;
  readonly resolveAgent: (entry: SandboxEntry) => ResolvedSandboxAgent;
  readonly resolvePinnedPackage: (identity: HarnessPackageIdentity) => InstalledHarnessPackage;
  readonly requireProvider: (sandbox: SandboxEntry) => RuntimeProviderBundle;
  readonly captureRuntime: typeof captureSandboxRuntimeSnapshot;
  readonly prepareHostLocalInference: typeof prepareSandboxHostLocalInferenceAuthority;
  readonly confirmHostLocalInference: typeof confirmHostLocalInferenceAuthority;
  readonly backup: typeof sandboxState.backupSandboxState;
  readonly captureOpenClawStateFile: typeof captureOpenClawStateFile;
}

interface CapturedManagedAuthority {
  readonly runtimeSnapshot: NonNullable<sandboxState.BackupOptions["runtimeSnapshot"]>;
  readonly workload: NonNullable<sandboxState.BackupOptions["workload"]>;
  readonly validateCurrent: (current: SandboxEntry) => void;
}

interface CapturedHostLocalInferenceAuthority {
  readonly hostLocalInferenceReceipt: string;
  readonly hostLocalInferenceProvenance?: NonNullable<
    sandboxState.BackupOptions["hostLocalInferenceProvenance"]
  >;
  readonly validateCurrent: (current: SandboxEntry) => void;
}

const MAX_OPENCLAW_CONFIG_BYTES = 16 * 1024 * 1024;
const OPENCLAW_CONFIG_CAPTURE_MAX_BUFFER = MAX_OPENCLAW_CONFIG_BYTES + 1024 * 1024;
const OPENCLAW_CONFIG_CAPTURE_TIMEOUT_MS = 30_000;
const OPENCLAW_CONFIG_CAPTURE_PROTOCOL_PREFIX = "nemoclaw-openclaw-config-capture:";
const OPENCLAW_CONFIG_CAPTURE_PROTOCOL_MAX_BYTES = 128;
const OPENCLAW_CONFIG_CAPTURE_DIAGNOSTIC_MAX_BYTES = 1024;
const OPENCLAW_CONFIG_DIRECTORY = "/sandbox/.openclaw";
const OPENCLAW_CONFIG_NAME = "openclaw.json";
export const OPENCLAW_CONFIG_CAPTURE_SCRIPT = `import os, stat, sys
maximum = ${MAX_OPENCLAW_CONFIG_BYTES}
directory = sys.argv[1]
name = sys.argv[2]
protocol = "${OPENCLAW_CONFIG_CAPTURE_PROTOCOL_PREFIX}"
def fail(status, reason):
    print(protocol + reason, file=sys.stderr)
    raise SystemExit(status)
directory_flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
file_flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
try:
    directory_fd = os.open(directory, directory_flags)
except OSError:
    fail(10, "directory-unavailable")
try:
    directory_before = os.fstat(directory_fd)
    try:
        file_fd = os.open(name, file_flags, dir_fd=directory_fd)
    except FileNotFoundError:
        fail(2, "missing")
    except OSError:
        fail(10, "file-unavailable")
    try:
        before = os.fstat(file_fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            fail(11, "unsafe-file-metadata")
        if before.st_size > maximum:
            fail(12, "size-limit-exceeded")
        chunks = []
        total = 0
        while True:
            chunk = os.read(file_fd, min(64 * 1024, maximum + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > maximum:
                fail(12, "size-limit-exceeded")
        after = os.fstat(file_fd)
        current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns, value.st_nlink)
        if identity(before) != identity(after) or identity(before) != identity(current) or not stat.S_ISREG(current.st_mode):
            fail(13, "file-changed-during-read")
        directory_current = os.stat(directory, follow_symlinks=False)
        if (directory_before.st_dev, directory_before.st_ino) != (directory_current.st_dev, directory_current.st_ino) or not stat.S_ISDIR(directory_current.st_mode):
            fail(13, "directory-changed-during-read")
        sys.stdout.buffer.write(b"".join(chunks))
    finally:
        os.close(file_fd)
finally:
    os.close(directory_fd)
`;

type OpenClawConfigCaptureFailure =
  | "missing"
  | "directory-unavailable"
  | "file-unavailable"
  | "unsafe-file-metadata"
  | "size-limit-exceeded"
  | "file-changed-during-read"
  | "directory-changed-during-read";

function captureFailureProtocol(stderr: unknown): OpenClawConfigCaptureFailure | null {
  if (
    (Buffer.isBuffer(stderr) && stderr.length > OPENCLAW_CONFIG_CAPTURE_PROTOCOL_MAX_BYTES) ||
    (typeof stderr === "string" &&
      Buffer.byteLength(stderr) > OPENCLAW_CONFIG_CAPTURE_PROTOCOL_MAX_BYTES)
  ) {
    return null;
  }
  const value = Buffer.isBuffer(stderr)
    ? stderr.toString("utf8")
    : typeof stderr === "string"
      ? stderr
      : "";
  const line = value.endsWith("\n") ? value.slice(0, -1) : value;
  if (!line.startsWith(OPENCLAW_CONFIG_CAPTURE_PROTOCOL_PREFIX) || /[\r\n]/.test(line)) {
    return null;
  }
  const reason = line.slice(OPENCLAW_CONFIG_CAPTURE_PROTOCOL_PREFIX.length);
  switch (reason) {
    case "missing":
    case "directory-unavailable":
    case "file-unavailable":
    case "unsafe-file-metadata":
    case "size-limit-exceeded":
    case "file-changed-during-read":
    case "directory-changed-during-read":
      return reason;
    default:
      return null;
  }
}

function captureFailureDiagnostic(stderr: unknown): string | null {
  const value = Buffer.isBuffer(stderr)
    ? stderr.subarray(0, OPENCLAW_CONFIG_CAPTURE_DIAGNOSTIC_MAX_BYTES).toString("utf8")
    : typeof stderr === "string"
      ? Buffer.from(stderr)
          .subarray(0, OPENCLAW_CONFIG_CAPTURE_DIAGNOSTIC_MAX_BYTES)
          .toString("utf8")
      : "";
  const sanitized = sanitizeReadinessText(value, 240).replace(/\s+/g, " ").trim();
  return sanitized || null;
}

export function captureOpenClawStateFile(
  sandboxName: string,
  request: sandboxState.StateFileCaptureRequest,
): sandboxState.StateFileCaptureResult | null {
  if (
    request.dir !== "/sandbox/.openclaw" ||
    request.spec.path !== "openclaw.json" ||
    request.spec.strategy !== "copy"
  ) {
    return null;
  }
  try {
    return withPrivilegedSandboxExecutionLease(
      sandboxName,
      "OpenClaw config snapshot capture",
      () => {
        const result = executePrivilegedSandboxCommand(
          sandboxName,
          [
            "/usr/bin/python3",
            "-I",
            "-S",
            "-c",
            OPENCLAW_CONFIG_CAPTURE_SCRIPT,
            OPENCLAW_CONFIG_DIRECTORY,
            OPENCLAW_CONFIG_NAME,
          ],
          {
            sanitizeEnvironment: true,
            timeout: OPENCLAW_CONFIG_CAPTURE_TIMEOUT_MS,
            maxOutputBytes: OPENCLAW_CONFIG_CAPTURE_MAX_BUFFER,
          },
        );
        const protocolFailure = captureFailureProtocol(result.stderr);
        if (
          result.status === 2 &&
          result.signal === null &&
          !result.error &&
          protocolFailure === "missing"
        ) {
          return { outcome: "missing" };
        }
        if (
          result.status !== 0 ||
          result.signal !== null ||
          result.error ||
          !Buffer.isBuffer(result.stdout)
        ) {
          const primaryDetail =
            result.error?.message ??
            (result.signal ? `signal ${result.signal}` : `exit ${String(result.status)}`);
          const stderrDetail = protocolFailure
            ? `reason ${protocolFailure}`
            : captureFailureDiagnostic(result.stderr);
          const detail = stderrDetail ? `${primaryDetail}; ${stderrDetail}` : primaryDetail;
          return { outcome: "failed", error: `privileged config capture failed: ${detail}` };
        }
        return { outcome: "backed_up", data: result.stdout };
      },
    );
  } catch (error) {
    return {
      outcome: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const defaultDependencies: Omit<SnapshotBackupAuthorityDependencies, "getSandbox"> = {
  resolveAgent: (entry) => resolveSandboxAgent(entry),
  resolvePinnedPackage: (identity) => resolvePinnedHarnessPackage(identity),
  requireProvider: (sandbox) =>
    requireRuntimeProviderBundleForSandbox(sandbox, CURRENT_RUNTIME_PROVIDER_BUNDLES),
  captureRuntime: captureSandboxRuntimeSnapshot,
  prepareHostLocalInference: prepareSandboxHostLocalInferenceAuthority,
  confirmHostLocalInference: confirmHostLocalInferenceAuthority,
  // Keep the call late-bound so tests and alternative state stores can replace
  // the module export without this adapter retaining an import-time reference.
  backup: (...args) => sandboxState.backupSandboxState(...args),
  captureOpenClawStateFile,
};

function failure(error: unknown): sandboxState.BackupResult {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    success: false,
    backedUpDirs: [],
    failedDirs: [],
    backedUpFiles: [],
    failedFiles: [],
    error: `Cannot capture snapshot authority: ${detail}.`,
  };
}

export interface SnapshotBackupAgentAuthority {
  readonly agentDefinition: AgentDefinition;
  readonly harnessPackage: HarnessPackageIdentity | null;
  readonly registryEntry: SandboxEntry;
}

type ResolveSnapshotBackupAgentDependencies = Pick<
  SnapshotBackupAuthorityDependencies,
  "getSandbox" | "resolveAgent"
>;

/** Materialize derived definition getters into immutable data for exact later comparison. */
function captureAgentDefinitionSnapshot(definition: AgentDefinition): AgentDefinition {
  try {
    return cloneAndDeepFreeze(structuredClone(definition));
  } catch (error) {
    throw new Error(
      `cannot capture agent definition: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function captureAuthorityValue<T>(label: string, value: T): T {
  try {
    return cloneAndDeepFreeze(value);
  } catch (error) {
    throw new Error(
      `cannot capture ${label}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** Resolve one definition before maintenance can start a container or open Shields. */
export function resolveSnapshotBackupAgentAuthority(
  sandboxName: string,
  overrides: Pick<SnapshotBackupAuthorityDependencies, "getSandbox"> &
    Partial<Pick<SnapshotBackupAuthorityDependencies, "resolveAgent">>,
): SnapshotBackupAgentAuthority {
  const dependencies: ResolveSnapshotBackupAgentDependencies = {
    getSandbox: overrides.getSandbox,
    resolveAgent: overrides.resolveAgent ?? defaultDependencies.resolveAgent,
  };
  const entry = dependencies.getSandbox(sandboxName);
  if (!entry) throw new Error(`sandbox '${sandboxName}' is no longer registered`);
  const resolved = dependencies.resolveAgent(entry);
  return Object.freeze({
    agentDefinition: captureAgentDefinitionSnapshot(resolved.definition),
    harnessPackage:
      resolved.harnessPackage === null
        ? null
        : captureAuthorityValue("harness package identity", resolved.harnessPackage),
    registryEntry: captureAuthorityValue("sandbox registry entry", entry),
  });
}

/** Confirm pinned package authority after the sandbox mutation lock is held. */
export function confirmSnapshotBackupAgentAuthority(
  sandboxName: string,
  authority: SnapshotBackupAgentAuthority,
  overrides: Pick<SnapshotBackupAuthorityDependencies, "getSandbox"> &
    Partial<Omit<SnapshotBackupAuthorityDependencies, "getSandbox">>,
): void {
  const dependencies = { ...defaultDependencies, ...overrides };
  const entry = dependencies.getSandbox(sandboxName);
  if (!entry) throw new Error(`sandbox '${sandboxName}' is no longer registered`);
  assertSnapshotBackupAgentAuthority(entry, authority, dependencies);
  assertSnapshotBackupRegistryAuthority(entry, authority);
}

function assertSnapshotBackupRegistryAuthority(
  entry: SandboxEntry,
  authority: SnapshotBackupAgentAuthority,
): void {
  if (!isDeepStrictEqual(entry, authority.registryEntry)) {
    throw new Error(`sandbox '${entry.name}' registry authority changed during backup`);
  }
}

function assertSnapshotBackupAgentAuthority(
  entry: SandboxEntry,
  authority: SnapshotBackupAgentAuthority,
  dependencies: SnapshotBackupAuthorityDependencies,
): void {
  const effectiveAgent = entry.agent || "openclaw";
  if (authority.agentDefinition.name !== effectiveAgent) {
    throw new Error(`sandbox authority changed during backup: '${entry.name}' changed agent`);
  }

  if (authority.harnessPackage === null) {
    const resolved = dependencies.resolveAgent(entry);
    if (
      resolved.harnessPackage !== null ||
      !isDeepStrictEqual(
        captureAgentDefinitionSnapshot(resolved.definition),
        authority.agentDefinition,
      )
    ) {
      throw new Error(`sandbox '${entry.name}' candidate agent authority changed during backup`);
    }
    return;
  }

  const recorded = inspectHarnessPackageState(entry.harnessPackage, entry.harnessPackageMigration);
  if (
    recorded.status !== "valid" ||
    !harnessPackageIdentitiesEqual(recorded.harnessPackage, authority.harnessPackage)
  ) {
    throw new Error(`sandbox '${entry.name}' harness package changed during backup`);
  }
  const installed = dependencies.resolvePinnedPackage(authority.harnessPackage);
  const resolved = dependencies.resolveAgent(entry);
  const currentDefinition = captureAgentDefinitionSnapshot(resolved.definition);
  if (
    !harnessPackageIdentitiesEqual(installed.identity, authority.harnessPackage) ||
    resolved.harnessPackage === null ||
    !harnessPackageIdentitiesEqual(resolved.harnessPackage, authority.harnessPackage) ||
    !isDeepStrictEqual(currentDefinition, authority.agentDefinition) ||
    installed.packageRoot !== authority.agentDefinition.packageRoot ||
    installed.packageManifest.manifestPath !== authority.agentDefinition.manifestPath
  ) {
    throw new Error(`sandbox '${entry.name}' pinned harness package changed during backup`);
  }
}

function backupStateOnly(
  dependencies: SnapshotBackupAuthorityDependencies,
  sandboxName: string,
  options: Pick<sandboxState.BackupOptions, "name" | "captureStateFile">,
): sandboxState.BackupResult {
  return options.name === undefined && options.captureStateFile === undefined
    ? dependencies.backup(sandboxName)
    : dependencies.backup(sandboxName, options);
}

function readAuthority(entry: SandboxEntry) {
  return readManagedSnapshotProfileAuthority({
    sandboxName: entry.name,
    agentType: entry.agent ?? "",
    imageTag: entry.imageTag,
    fromDockerfile: entry.fromDockerfile,
    workload: entry.workload,
  });
}

function captureManagedAuthority(
  entry: SandboxEntry,
  dependencies: SnapshotBackupAuthorityDependencies,
): CapturedManagedAuthority | null {
  const authority = readAuthority(entry);
  if (!authority) return null;
  const provider = dependencies.requireProvider(entry);
  if (!provider.workload.acceptsReceipt(authority.receipt)) {
    throw new Error(
      `runtime provider '${provider.identity.id}' does not accept the managed workload receipt`,
    );
  }
  const runtimeSnapshot = dependencies.captureRuntime(provider, entry);
  const workload = authority.receipt;

  return {
    runtimeSnapshot,
    workload,
    validateCurrent: (current) => {
      const currentAuthority = readAuthority(current);
      if (!currentAuthority || !isDeepStrictEqual(currentAuthority.receipt, workload)) {
        throw new Error(`sandbox '${entry.name}' managed workload changed during backup`);
      }
      const currentProvider = dependencies.requireProvider(current);
      if (
        currentProvider.identity.id !== provider.identity.id ||
        !currentProvider.workload.acceptsReceipt(currentAuthority.receipt)
      ) {
        throw new Error(`sandbox '${entry.name}' runtime provider changed during backup`);
      }
      const currentRuntime = dependencies.captureRuntime(currentProvider, current);
      if (!isDeepStrictEqual(currentRuntime, runtimeSnapshot)) {
        throw new Error(`sandbox '${entry.name}' runtime changed during backup`);
      }
    },
  };
}

function captureHostLocalInferenceAuthority(
  entry: SandboxEntry,
  dependencies: SnapshotBackupAuthorityDependencies,
): CapturedHostLocalInferenceAuthority | null {
  const receipt = entry.hostLocalInferenceReceipt;
  if (typeof receipt !== "string") return null;
  const provider = dependencies.requireProvider(entry);
  const prepared = dependencies.prepareHostLocalInference(provider, entry);
  if (!prepared) {
    if (entry.hostLocalInferenceProvenance) {
      throw new Error("explicit host-local inference lifecycle authority cannot be reconstructed");
    }
    return null;
  }
  return {
    hostLocalInferenceReceipt: prepared.serializedReceipt,
    ...(entry.hostLocalInferenceProvenance
      ? { hostLocalInferenceProvenance: entry.hostLocalInferenceProvenance }
      : {}),
    validateCurrent: (current) => {
      if (current.hostLocalInferenceReceipt !== receipt) {
        throw new Error(`sandbox '${entry.name}' host-local inference changed during backup`);
      }
      if (
        !isDeepStrictEqual(current.hostLocalInferenceProvenance, entry.hostLocalInferenceProvenance)
      ) {
        throw new Error(
          `sandbox '${entry.name}' host-local inference provenance changed during backup`,
        );
      }
      const currentProvider = dependencies.requireProvider(current);
      if (currentProvider.identity.id !== provider.identity.id) {
        throw new Error(`sandbox '${entry.name}' runtime provider changed during backup`);
      }
      dependencies.confirmHostLocalInference(currentProvider, current, prepared);
    },
  };
}

function captureSnapshotAuthority(
  entry: SandboxEntry,
  agentAuthority: SnapshotBackupAgentAuthority,
  dependencies: SnapshotBackupAuthorityDependencies,
): SnapshotBackupAuthority {
  assertSnapshotBackupAgentAuthority(entry, agentAuthority, dependencies);
  assertSnapshotBackupRegistryAuthority(entry, agentAuthority);
  const managed = captureManagedAuthority(entry, dependencies);
  const hostLocal = captureHostLocalInferenceAuthority(entry, dependencies);
  return {
    agentDefinition: agentAuthority.agentDefinition,
    harnessPackage: agentAuthority.harnessPackage,
    ...(managed?.runtimeSnapshot === undefined ? {} : { runtimeSnapshot: managed.runtimeSnapshot }),
    ...(managed?.workload === undefined ? {} : { workload: managed.workload }),
    ...(hostLocal?.hostLocalInferenceReceipt === undefined
      ? {}
      : { hostLocalInferenceReceipt: hostLocal.hostLocalInferenceReceipt }),
    ...(hostLocal?.hostLocalInferenceProvenance === undefined
      ? {}
      : { hostLocalInferenceProvenance: hostLocal.hostLocalInferenceProvenance }),
    validateBeforePublish: () => {
      const current = dependencies.getSandbox(entry.name);
      if (!current) throw new Error(`sandbox '${entry.name}' is no longer registered`);
      assertSnapshotBackupAgentAuthority(current, agentAuthority, dependencies);
      managed?.validateCurrent(current);
      hostLocal?.validateCurrent(current);
      assertSnapshotBackupRegistryAuthority(current, agentAuthority);
    },
  };
}

/**
 * Capture the provider-owned workload, runtime, and host-local inference
 * authority around the complete filesystem copy. The state layer publishes
 * the manifest only after the final callback confirms the same full sandbox
 * binding and provider proof remain live.
 */
export function backupSandboxStateWithManagedAuthority(
  sandboxName: string,
  options: Pick<sandboxState.BackupOptions, "name" | "agentDefinition" | "harnessPackage"> &
    Partial<Pick<SnapshotBackupAgentAuthority, "registryEntry">> = {},
  overrides: Pick<SnapshotBackupAuthorityDependencies, "getSandbox"> &
    Partial<Omit<SnapshotBackupAuthorityDependencies, "getSandbox">>,
): sandboxState.BackupResult {
  const dependencies = { ...defaultDependencies, ...overrides };
  const hasDefinition = options.agentDefinition !== undefined;
  const hasHarnessPackage = Object.prototype.hasOwnProperty.call(options, "harnessPackage");
  if (hasDefinition !== hasHarnessPackage) {
    return failure(
      new Error("snapshot agent definition and harness package must be supplied together"),
    );
  }
  const entry = dependencies.getSandbox(sandboxName);
  if (!entry) {
    if (hasDefinition) {
      return failure(new Error(`sandbox '${sandboxName}' is no longer registered`));
    }
    return backupStateOnly(dependencies, sandboxName, { name: options.name });
  }

  let agentAuthority: SnapshotBackupAgentAuthority;
  try {
    agentAuthority = hasDefinition
      ? {
          agentDefinition: captureAgentDefinitionSnapshot(
            options.agentDefinition as AgentDefinition,
          ),
          harnessPackage: options.harnessPackage ?? null,
          registryEntry: captureAuthorityValue(
            "sandbox registry entry",
            options.registryEntry ?? entry,
          ),
        }
      : (() => {
          const resolved = dependencies.resolveAgent(entry);
          return {
            agentDefinition: captureAgentDefinitionSnapshot(resolved.definition),
            harnessPackage: resolved.harnessPackage,
            registryEntry: captureAuthorityValue("sandbox registry entry", entry),
          };
        })();
  } catch (error) {
    return failure(error);
  }

  const stateFileOptions: Pick<sandboxState.BackupOptions, "captureStateFile"> =
    agentAuthority.agentDefinition.name === "openclaw"
      ? {
          captureStateFile: (request) =>
            dependencies.captureOpenClawStateFile(sandboxName, request),
        }
      : {};
  const { registryEntry: _registryEntry, ...publicOptions } = options;
  const backupOptions = {
    ...publicOptions,
    agentDefinition: agentAuthority.agentDefinition,
    harnessPackage: agentAuthority.harnessPackage,
    ...stateFileOptions,
  };

  let authority: SnapshotBackupAuthority;
  try {
    authority = captureSnapshotAuthority(entry, agentAuthority, dependencies);
  } catch (error) {
    return failure(error);
  }
  return dependencies.backup(sandboxName, { ...backupOptions, ...authority });
}
