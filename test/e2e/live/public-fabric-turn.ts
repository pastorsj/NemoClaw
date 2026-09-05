// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  type FabricHarnessE2eContract,
  validateFabricHarnessE2eContract,
} from "../../../tools/e2e/fabric-contract.mts";

import type { ArtifactSink } from "../fixtures/artifacts.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

export const PUBLIC_FABRIC_TURN_PROMPT = "Reply with exactly one word: PONG";
export const PUBLIC_FABRIC_TURN_RESPONSE = "PONG";
export const PUBLIC_FABRIC_RUNNER_IDENTITY = "nemoclaw-fabric 0.1.2 (nemo-fabric 0.2.0)";

export type PublicFabricAgent = "hermes" | "openclaw";
export type PublicFabricLifecyclePhase =
  | "after-gateway-restart"
  | "after-inference-switch"
  | "after-onboard"
  | "after-rebuild"
  | "after-sandbox-restart"
  | "after-shields-down"
  | "after-shields-up"
  | "before-gateway-restart";

export type PublicFabricHarnessContract = FabricHarnessE2eContract;

const PUBLIC_FABRIC_AGENT_CONTRACTS: Record<PublicFabricAgent, PublicFabricHarnessContract> = {
  hermes: {
    packageId: "hermes",
    adapterId: "nvidia.nemoclaw.hermes",
    artifactRoot: "/sandbox/.hermes/fabric-artifacts",
    configPath: "/sandbox/.hermes/fabric.json",
    descriptorGlob: "/usr/local/share/nemoclaw/hermes.fabric-adapter.json",
    descriptorPathPrefix: "/usr/local/share/nemoclaw",
    descriptorRunnerModule: "nemoclaw_hermes_fabric.adapter",
    processMarkers: ["nemo_fabric_adapters.hermes"],
  },
  openclaw: {
    packageId: "openclaw",
    adapterId: "nvidia.nemoclaw.openclaw",
    artifactRoot: "/sandbox/.openclaw/fabric-artifacts",
    configPath: "/sandbox/.openclaw/fabric.json",
    descriptorGlob: "/usr/local/share/nemoclaw/openclaw.fabric-adapter.json",
    descriptorPathPrefix: "/usr/local/share/nemoclaw",
    descriptorRunnerModule: "nemoclaw_openclaw_fabric.adapter",
    processMarkers: ["nemoclaw-fabric-", ".nemoclaw-openclaw-prompt-"],
  },
};

const CONFIG_PROBE_SCRIPT = String.raw`
import grp
import glob
import hashlib
import json
import os
import pwd
import stat
import sys

(
    config_path,
    expected_artifact_root,
    expected_adapter_id,
    descriptor_glob,
    descriptor_path_prefix,
    expected_runner_module,
    fingerprint_json,
) = sys.argv[1:]
fingerprints = json.loads(fingerprint_json)
config_stat = os.lstat(config_path)
config_bytes = open(config_path, "rb").read()
config = json.loads(config_bytes.decode("utf-8"))
descriptor_paths = glob.glob(descriptor_glob)
if len(descriptor_paths) != 1:
    raise RuntimeError("Fabric adapter descriptor identity is not singular")
descriptor_path = descriptor_paths[0]
descriptor_stat = os.lstat(descriptor_path)
descriptor = json.loads(open(descriptor_path, "r", encoding="utf-8").read())

def has_fingerprint(payload, fingerprint):
    length = fingerprint.get("length")
    digest = fingerprint.get("sha256")
    if not isinstance(length, int) or length <= 0 or not isinstance(digest, str):
        return True
    if length > len(payload):
        return False
    return any(
        hashlib.sha256(payload[offset:offset + length]).hexdigest() == digest
        for offset in range(0, len(payload) - length + 1)
    )

def is_beneath(candidate, parent):
    try:
        return os.path.commonpath((candidate, parent)) == parent
    except ValueError:
        return False

state_root = os.path.dirname(config_path)
resolved_state_root = os.path.realpath(state_root)
runtime_artifacts = config.get("runtime", {}).get("artifacts")
environment_artifacts = config.get("environment", {}).get("artifacts")
artifact_exists = os.path.lexists(expected_artifact_root)
artifact_tree_bounded = True
artifact_entry_count = 0
artifact_scan_complete = True

if os.path.realpath(expected_artifact_root) != expected_artifact_root:
    artifact_tree_bounded = False
if not is_beneath(expected_artifact_root, resolved_state_root):
    artifact_tree_bounded = False

if artifact_exists:
    artifact_stat = os.lstat(expected_artifact_root)
    if stat.S_ISLNK(artifact_stat.st_mode) or not stat.S_ISDIR(artifact_stat.st_mode):
        artifact_tree_bounded = False
    else:
        for root, directories, files in os.walk(expected_artifact_root, followlinks=False):
            for name in directories + files:
                artifact_entry_count += 1
                if artifact_entry_count > 4096:
                    artifact_scan_complete = False
                    artifact_tree_bounded = False
                    directories[:] = []
                    break
                candidate = os.path.join(root, name)
                candidate_stat = os.lstat(candidate)
                if stat.S_ISLNK(candidate_stat.st_mode):
                    artifact_tree_bounded = False
                if not is_beneath(os.path.realpath(candidate), expected_artifact_root):
                    artifact_tree_bounded = False
            if not artifact_scan_complete:
                break

owner_user = pwd.getpwuid(config_stat.st_uid).pw_name
owner_group = grp.getgrgid(config_stat.st_gid).gr_name
print(json.dumps({
    "adapterId": config.get("harness", {}).get("adapter_id"),
    "artifactEntryCount": artifact_entry_count,
    "artifactRoot": expected_artifact_root,
    "artifactRootExists": artifact_exists,
    "artifactScanComplete": artifact_scan_complete,
    "artifactTreeBounded": artifact_tree_bounded,
    "configCredentialFree": not any(has_fingerprint(config_bytes, item) for item in fingerprints),
    "configMode": format(stat.S_IMODE(config_stat.st_mode), "04o"),
    "configOwner": f"{owner_user}:{owner_group}",
    "configPath": config_path,
    "configRegularFile": stat.S_ISREG(config_stat.st_mode) and not stat.S_ISLNK(config_stat.st_mode),
    "configuredArtifactRootsExact": runtime_artifacts == expected_artifact_root and environment_artifacts == expected_artifact_root,
    "descriptorAdapterId": descriptor.get("adapter_id"),
    "descriptorContractVersion": descriptor.get("contract_version"),
    "descriptorPath": descriptor_path,
    "descriptorPathBounded": is_beneath(os.path.realpath(descriptor_path), os.path.realpath(descriptor_path_prefix)),
    "descriptorRegularFile": stat.S_ISREG(descriptor_stat.st_mode) and not stat.S_ISLNK(descriptor_stat.st_mode),
    "descriptorRunnerModule": descriptor.get("runner", {}).get("module"),
    "expectedAdapterId": expected_adapter_id,
    "expectedRunnerModule": expected_runner_module,
    "schemaVersion": config.get("schema_version"),
}, sort_keys=True))
`;

const PROCESS_PROBE_SCRIPT = String.raw`
import json
import os
import sys

tokens = json.loads(sys.argv[1])
if (
    not isinstance(tokens, list)
    or not tokens
    or len(tokens) > 32
    or any(not isinstance(token, str) or not token for token in tokens)
):
    raise ValueError("invalid Fabric process markers")

def parent_process_id(process_id):
    text = open(f"/proc/{process_id}/stat", "r", encoding="ascii").read()
    fields = text[text.rfind(")") + 2:].split()
    if len(fields) < 2:
        raise ValueError("incomplete process stat")
    return int(fields[1])

excluded = set()
current = os.getpid()
while current > 0 and current not in excluded:
    excluded.add(current)
    try:
        current = parent_process_id(current)
    except (FileNotFoundError, PermissionError, ValueError, OSError):
        break

# The runner's deterministic process-group tests own arbitrary child cleanup. This live
# boundary owns only named Fabric and harness processes; OpenShell transport processes
# can legitimately appear between independent sandbox exec calls.
matches = []
unreadable = []
for entry in os.scandir("/proc"):
    if not entry.name.isdecimal():
        continue
    process_id = int(entry.name)
    if process_id in excluded:
        continue
    try:
        command = open(f"/proc/{process_id}/cmdline", "rb").read().replace(b"\0", b" ").decode("utf-8", "replace")
    except FileNotFoundError:
        continue
    except (PermissionError, OSError):
        unreadable.append(process_id)
        continue
    if command and any(token in command for token in tokens):
        matches.append(process_id)

print(json.dumps({
    "inspectionComplete": not unreadable,
    "matchingPids": sorted(matches),
    "unreadablePids": sorted(unreadable),
}, sort_keys=True))
`;

interface FabricConfigProbe {
  readonly adapterId: string;
  readonly artifactEntryCount: number;
  readonly artifactRoot: string;
  readonly artifactRootExists: boolean;
  readonly artifactScanComplete: boolean;
  readonly artifactTreeBounded: boolean;
  readonly configCredentialFree: boolean;
  readonly configMode: string;
  readonly configOwner: string;
  readonly configPath: string;
  readonly configRegularFile: boolean;
  readonly configuredArtifactRootsExact: boolean;
  readonly descriptorAdapterId: string;
  readonly descriptorContractVersion: string;
  readonly descriptorPath: string;
  readonly descriptorPathBounded: boolean;
  readonly descriptorRegularFile: boolean;
  readonly descriptorRunnerModule: string;
  readonly expectedAdapterId: string;
  readonly expectedRunnerModule: string;
  readonly schemaVersion: string;
}

interface FabricProcessProbe {
  readonly inspectionComplete: boolean;
  readonly matchingPids: number[];
  readonly unreadablePids: number[];
}

export interface PublicFabricTurnProof {
  readonly schemaVersion: 1;
  readonly adapterId: string;
  readonly agent: string;
  readonly artifactEntryCount: number;
  readonly artifactRoot: string;
  readonly artifactRootExists: boolean;
  readonly command: "nemoclaw sandbox agent <sandbox> <plain prompt>";
  readonly configMode: "0444" | "0600";
  readonly configOwner: "root:root" | "sandbox:sandbox";
  readonly configPath: string;
  readonly descriptorPath: string;
  readonly descriptorRunnerModule: string;
  readonly doctorStatus: "pass" | "warn";
  readonly lifecyclePhase: PublicFabricLifecyclePhase;
  readonly noLingeringProcesses: true;
  readonly outcome: "succeeded";
  readonly responseSha256: string;
  readonly runnerIdentity: typeof PUBLIC_FABRIC_RUNNER_IDENTITY;
  readonly sandboxName: string;
}

interface PublicFabricTurnBaseOptions {
  readonly artifacts: Pick<ArtifactSink, "writeJson">;
  readonly env: NodeJS.ProcessEnv;
  readonly host: Pick<HostCliClient, "nemoclaw">;
  readonly lifecyclePhase: PublicFabricLifecyclePhase;
  readonly redactionValues: readonly string[];
  readonly sandbox: SandboxClient;
  readonly sandboxName: string;
  readonly timeoutMs?: number;
}

export type PublicFabricTurnOptions = PublicFabricTurnBaseOptions &
  (
    | {
        readonly agent: PublicFabricAgent;
        readonly contract?: never;
      }
    | {
        readonly agent?: never;
        readonly contract: PublicFabricHarnessContract;
      }
  );

function resolveFabricHarnessContract(options: PublicFabricTurnOptions): {
  readonly agent: string;
  readonly contract: PublicFabricHarnessContract;
} {
  const provided = options.contract;
  const agent = provided?.packageId ?? options.agent ?? "";
  const candidate = provided ?? PUBLIC_FABRIC_AGENT_CONTRACTS[options.agent as PublicFabricAgent];
  if (
    !candidate ||
    (provided !== undefined && options.agent !== undefined) ||
    (provided !== undefined && Object.hasOwn(PUBLIC_FABRIC_AGENT_CONTRACTS, agent))
  ) {
    throw new Error("public Fabric proof contract is invalid");
  }
  let contract: FabricHarnessE2eContract;
  try {
    contract = validateFabricHarnessE2eContract({
      packageId: candidate.packageId,
      adapterId: candidate.adapterId,
      artifactRoot: candidate.artifactRoot,
      configPath: candidate.configPath,
      descriptorGlob: candidate.descriptorGlob,
      descriptorPathPrefix: candidate.descriptorPathPrefix,
      descriptorRunnerModule: candidate.descriptorRunnerModule,
      ...(candidate.processMarkers ? { processMarkers: candidate.processMarkers } : {}),
    });
  } catch {
    throw new Error("public Fabric proof contract is invalid");
  }

  return Object.freeze({
    agent,
    contract,
  });
}

function fabricProcessMarkers(contract: PublicFabricHarnessContract): readonly string[] {
  const descriptorName = contract.descriptorGlob.slice(
    contract.descriptorGlob.lastIndexOf("/") + 1,
  );
  return Object.freeze(
    [
      "nemoclaw-fabric",
      "nemoclaw_fabric",
      PUBLIC_FABRIC_TURN_PROMPT,
      contract.adapterId,
      contract.descriptorRunnerModule,
      descriptorName,
      ...(contract.processMarkers ?? []),
    ].filter((marker, index, markers) => markers.indexOf(marker) === index),
  );
}

function outputRetainedCredential(
  result: ShellProbeResult,
  redactionValues: readonly string[],
): boolean {
  const output = `${result.stdout}\n${result.stderr}`;
  return (
    output.includes("[REDACTED]") ||
    redactionValues.filter(Boolean).some((value) => output.includes(value))
  );
}

function requireSuccessfulProbe(
  result: ShellProbeResult,
  label: string,
  redactionValues: readonly string[],
): void {
  if (outputRetainedCredential(result, redactionValues)) {
    throw new Error(`${label} retained a credential`);
  }
  if (result.timedOut || result.exitCode !== 0) {
    const outcome = result.timedOut ? "timed out" : "failed";
    throw new Error(`${label} ${outcome}; inspect its redacted artifact`);
  }
}

function parseProbeRecord(result: ShellProbeResult, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid record`);
  }
  return value as Record<string, unknown>;
}

function credentialFingerprints(redactionValues: readonly string[]): Array<{
  length: number;
  sha256: string;
}> {
  return [...new Set(redactionValues.filter(Boolean))].map((value) => {
    const bytes = Buffer.from(value, "utf8");
    return {
      length: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
}

function requireConfigProbe(
  value: Record<string, unknown>,
  contract: PublicFabricHarnessContract,
): FabricConfigProbe {
  const securePosture =
    (value.configOwner === "sandbox:sandbox" && value.configMode === "0600") ||
    (value.configOwner === "root:root" && value.configMode === "0444");
  if (
    value.adapterId !== contract.adapterId ||
    value.expectedAdapterId !== contract.adapterId ||
    value.artifactRoot !== contract.artifactRoot ||
    value.configPath !== contract.configPath ||
    value.schemaVersion !== "fabric.agent/v1alpha1" ||
    value.configRegularFile !== true ||
    value.configCredentialFree !== true ||
    value.configuredArtifactRootsExact !== true ||
    value.descriptorAdapterId !== contract.adapterId ||
    value.descriptorContractVersion !== "fabric.adapter/v1alpha2" ||
    typeof value.descriptorPath !== "string" ||
    value.descriptorPathBounded !== true ||
    value.descriptorRegularFile !== true ||
    value.descriptorRunnerModule !== contract.descriptorRunnerModule ||
    value.expectedRunnerModule !== contract.descriptorRunnerModule ||
    value.artifactScanComplete !== true ||
    value.artifactTreeBounded !== true ||
    value.artifactRootExists !== true ||
    value.artifactEntryCount !== 0 ||
    !securePosture
  ) {
    throw new Error("public Fabric config or artifact-root integrity check failed");
  }
  return value as unknown as FabricConfigProbe;
}

function requireProcessProbe(
  value: Record<string, unknown>,
  phase: "baseline" | "verify",
): FabricProcessProbe {
  const validPidList = (candidate: unknown): candidate is number[] =>
    Array.isArray(candidate) &&
    candidate.every((processId) => Number.isSafeInteger(processId) && processId > 0);
  if (
    value.inspectionComplete !== true ||
    !validPidList(value.matchingPids) ||
    value.matchingPids.length !== 0 ||
    !validPidList(value.unreadablePids) ||
    value.unreadablePids.length !== 0
  ) {
    throw new Error(
      phase === "baseline"
        ? "public Fabric process baseline was not clean"
        : "public Fabric turn left a known runner, adapter, or harness process",
    );
  }
  return value as unknown as FabricProcessProbe;
}

export async function runPublicFabricTurn(
  options: PublicFabricTurnOptions,
): Promise<PublicFabricTurnProof> {
  const {
    artifacts,
    env,
    host,
    lifecyclePhase,
    redactionValues,
    sandbox,
    sandboxName,
    timeoutMs = 3 * 60_000,
  } = options;
  const { agent, contract } = resolveFabricHarnessContract(options);
  const processMarkers = fabricProcessMarkers(contract);
  const baselineResult = await sandbox.exec(
    sandboxName,
    [
      "/opt/nemoclaw-fabric-venv/bin/python3",
      "-I",
      "-c",
      PROCESS_PROBE_SCRIPT,
      JSON.stringify(processMarkers),
    ],
    {
      artifactName: `fabric-${agent}-${lifecyclePhase}-process-baseline`,
      env,
      redactionValues: [...redactionValues],
      timeoutMs: 30_000,
    },
  );
  requireSuccessfulProbe(
    baselineResult,
    `public ${agent} Fabric process baseline`,
    redactionValues,
  );
  requireProcessProbe(
    parseProbeRecord(baselineResult, `public ${agent} Fabric process baseline`),
    "baseline",
  );

  const turn = await host.nemoclaw(["sandbox", "agent", sandboxName, PUBLIC_FABRIC_TURN_PROMPT], {
    artifactName: `fabric-${agent}-${lifecyclePhase}-public-agent-turn`,
    env,
    redactionValues: [...redactionValues],
    timeoutMs,
  });
  requireSuccessfulProbe(turn, `public ${agent} Fabric turn`, redactionValues);
  if (turn.stdout.trim() !== PUBLIC_FABRIC_TURN_RESPONSE) {
    throw new Error(`public ${agent} Fabric turn returned an unexpected response`);
  }

  const version = await sandbox.exec(sandboxName, ["/usr/local/bin/nemoclaw-fabric", "--version"], {
    artifactName: `fabric-${agent}-${lifecyclePhase}-runner-version`,
    env,
    redactionValues: [...redactionValues],
    timeoutMs: 30_000,
  });
  requireSuccessfulProbe(version, `public ${agent} Fabric version probe`, redactionValues);
  if (version.stdout.trim() !== PUBLIC_FABRIC_RUNNER_IDENTITY) {
    throw new Error(`public ${agent} Fabric runner identity did not match the pinned package`);
  }

  const doctor = await sandbox.exec(
    sandboxName,
    [
      "/bin/bash",
      "-lc",
      'set -eu; . /tmp/nemoclaw-proxy-env.sh; exec /usr/local/bin/nemoclaw-fabric doctor --config "$1" --json',
      "nemoclaw-fabric-doctor",
      contract.configPath,
    ],
    {
      artifactName: `fabric-${agent}-${lifecyclePhase}-doctor`,
      env,
      redactionValues: [...redactionValues],
      timeoutMs: 60_000,
    },
  );
  requireSuccessfulProbe(doctor, `public ${agent} Fabric doctor`, redactionValues);
  const doctorStatus = parseProbeRecord(doctor, `public ${agent} Fabric doctor`).status;
  if (doctorStatus !== "pass" && doctorStatus !== "warn") {
    throw new Error(`public ${agent} Fabric doctor returned an unhealthy status`);
  }

  const fingerprints = credentialFingerprints(redactionValues);
  const fingerprintDigests = fingerprints.map((fingerprint) => fingerprint.sha256);
  const configResult = await sandbox.exec(
    sandboxName,
    [
      "/opt/nemoclaw-fabric-venv/bin/python3",
      "-I",
      "-c",
      CONFIG_PROBE_SCRIPT,
      contract.configPath,
      contract.artifactRoot,
      contract.adapterId,
      contract.descriptorGlob,
      contract.descriptorPathPrefix,
      contract.descriptorRunnerModule,
      JSON.stringify(fingerprints),
    ],
    {
      artifactName: `fabric-${agent}-${lifecyclePhase}-config-integrity`,
      env,
      redactionValues: [...redactionValues, ...fingerprintDigests],
      timeoutMs: 30_000,
    },
  );
  requireSuccessfulProbe(configResult, `public ${agent} Fabric config probe`, redactionValues);
  const configProbe = requireConfigProbe(
    parseProbeRecord(configResult, `public ${agent} Fabric config probe`),
    contract,
  );

  const processResult = await sandbox.exec(
    sandboxName,
    [
      "/opt/nemoclaw-fabric-venv/bin/python3",
      "-I",
      "-c",
      PROCESS_PROBE_SCRIPT,
      JSON.stringify(processMarkers),
    ],
    {
      artifactName: `fabric-${agent}-${lifecyclePhase}-process-cleanup`,
      env,
      redactionValues: [...redactionValues],
      timeoutMs: 30_000,
    },
  );
  requireSuccessfulProbe(processResult, `public ${agent} Fabric process probe`, redactionValues);
  requireProcessProbe(
    parseProbeRecord(processResult, `public ${agent} Fabric process probe`),
    "verify",
  );

  const proof: PublicFabricTurnProof = {
    schemaVersion: 1,
    adapterId: contract.adapterId,
    agent,
    artifactEntryCount: configProbe.artifactEntryCount,
    artifactRoot: contract.artifactRoot,
    artifactRootExists: configProbe.artifactRootExists,
    command: "nemoclaw sandbox agent <sandbox> <plain prompt>",
    configMode: configProbe.configMode as PublicFabricTurnProof["configMode"],
    configOwner: configProbe.configOwner as PublicFabricTurnProof["configOwner"],
    configPath: contract.configPath,
    descriptorPath: configProbe.descriptorPath,
    descriptorRunnerModule: contract.descriptorRunnerModule,
    doctorStatus,
    lifecyclePhase,
    noLingeringProcesses: true,
    outcome: "succeeded",
    responseSha256: createHash("sha256").update(PUBLIC_FABRIC_TURN_RESPONSE).digest("hex"),
    runnerIdentity: PUBLIC_FABRIC_RUNNER_IDENTITY,
    sandboxName,
  };
  await artifacts.writeJson(`fabric-${agent}-${lifecyclePhase}-proof.json`, proof);
  return proof;
}
