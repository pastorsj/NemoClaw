// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessExitZeroCommand,
  HarnessMutableConfigPlan,
} from "../agent-runtime/config-module";
import { validateName } from "../runner";
import { withMcpLifecycleLockSync } from "../state/mcp-lifecycle-lock-acquisition";
import { resolveAgentConfig, type AgentConfigTarget } from "./agent-config";
import { loadInstalledConfigAdapter, toHarnessConfigTarget } from "./package-config";
import {
  capturePrivilegedSandboxCommand,
  executePrivilegedSandboxCommand,
  resolvePrivilegedSandboxTarget,
} from "./privileged-exec";

export const MUTABLE_OPENCLAW_DIR_MODE = "2770";
export const MUTABLE_OPENCLAW_FILE_MODE = "660";
export const MUTABLE_OPENCLAW_OWNER = "sandbox:sandbox";

export interface MutableHermesConfigVerification {
  readonly verified: boolean;
  readonly errors: readonly string[];
}

export type MutableConfigPermsInspection =
  | { applies: false; skipReason: "agent" | "unavailable"; reason: string }
  | {
      applies: true;
      ok: boolean;
      inspectionMethod?: "stat";
      dirMode: string;
      dirOwner: string;
      fileMode: string;
      fileOwner: string;
      configDir: string;
      configFile: string;
      issues: string[];
    }
  | {
      applies: true;
      ok: boolean;
      inspectionMethod: "probe";
      configDir: string;
      configFile: string;
      issues: string[];
      dirMode?: never;
      dirOwner?: never;
      fileMode?: never;
      fileOwner?: never;
    };

export type MutableConfigRepairResult =
  | { applied: false; skipReason: "agent"; reason: string }
  | { applied: true; verified: boolean; errors: string[] };

export interface MutableConfigPermsDependencies {
  readonly resolveConfigTarget: typeof resolveAgentConfig;
  readonly loadConfigAdapter: typeof loadInstalledConfigAdapter;
  readonly resolveResourceHandle: (sandboxName: string) => string;
  readonly captureSandboxCommand: typeof capturePrivilegedSandboxCommand;
  readonly executeSandboxCommand: typeof executePrivilegedSandboxCommand;
  readonly withMutationLock: <T>(sandboxName: string, operation: () => T) => T;
}

const DEFAULT_MUTABLE_CONFIG_DEPENDENCIES: MutableConfigPermsDependencies = Object.freeze({
  resolveConfigTarget: resolveAgentConfig,
  loadConfigAdapter: loadInstalledConfigAdapter,
  resolveResourceHandle: (sandboxName: string) =>
    resolvePrivilegedSandboxTarget(sandboxName).resourceHandle,
  captureSandboxCommand: capturePrivilegedSandboxCommand,
  executeSandboxCommand: executePrivilegedSandboxCommand,
  withMutationLock: <T>(sandboxName: string, operation: () => T): T =>
    withMcpLifecycleLockSync(sandboxName, operation),
});

function mutableConfigDependencies(
  overrides: Partial<MutableConfigPermsDependencies>,
): MutableConfigPermsDependencies {
  return { ...DEFAULT_MUTABLE_CONFIG_DEPENDENCIES, ...overrides };
}

export function parseStatModeOwner(raw: string): { mode: string; owner: string } {
  const [mode, owner] = raw.trim().split(/\s+/);
  return { mode: mode || "", owner: owner || "" };
}

export function dirSatisfiesMutableContract(mode: string): boolean {
  return (
    /^[0-7]{3,4}$/.test(mode) &&
    mode.padStart(4, "0") === MUTABLE_OPENCLAW_DIR_MODE.padStart(4, "0")
  );
}

export function fileSatisfiesMutableContract(mode: string): boolean {
  return (
    /^[0-7]{3,4}$/.test(mode) &&
    mode.padStart(4, "0") === MUTABLE_OPENCLAW_FILE_MODE.padStart(4, "0")
  );
}

export function inspectMutableConfigPermsForTarget(
  target: AgentConfigTarget,
  statModeOwner: (path: string) => string,
): MutableConfigPermsInspection {
  if (target.agentName !== "openclaw") {
    return {
      applies: false,
      skipReason: "agent",
      reason: `agent ${target.agentName} does not use the mutable OpenClaw config contract`,
    };
  }
  let dir: { mode: string; owner: string };
  let file: { mode: string; owner: string };
  try {
    dir = parseStatModeOwner(statModeOwner(target.configDir));
    file = parseStatModeOwner(statModeOwner(target.configPath));
  } catch (error) {
    return {
      applies: false,
      skipReason: "unavailable",
      reason: `could not stat config (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const issues: string[] = [];
  if (!dirSatisfiesMutableContract(dir.mode)) {
    issues.push(
      `${target.configDir} mode ${dir.mode} (expected ${MUTABLE_OPENCLAW_DIR_MODE} setgid+group-writable)`,
    );
  }
  if (dir.owner !== MUTABLE_OPENCLAW_OWNER) {
    issues.push(`${target.configDir} owner ${dir.owner} (expected ${MUTABLE_OPENCLAW_OWNER})`);
  }
  if (!fileSatisfiesMutableContract(file.mode)) {
    issues.push(
      `${target.configFile} mode ${file.mode} (expected ${MUTABLE_OPENCLAW_FILE_MODE} group-writable)`,
    );
  }
  if (file.owner !== MUTABLE_OPENCLAW_OWNER) {
    issues.push(`${target.configFile} owner ${file.owner} (expected ${MUTABLE_OPENCLAW_OWNER})`);
  }
  for (const sensitivePath of target.sensitiveFiles ?? []) {
    let sensitive: { mode: string; owner: string };
    try {
      sensitive = parseStatModeOwner(statModeOwner(sensitivePath));
    } catch {
      continue;
    }
    if (!fileSatisfiesMutableContract(sensitive.mode)) {
      issues.push(
        `${sensitivePath} mode ${sensitive.mode} (expected ${MUTABLE_OPENCLAW_FILE_MODE} group-writable)`,
      );
    }
    if (sensitive.owner !== MUTABLE_OPENCLAW_OWNER) {
      issues.push(`${sensitivePath} owner ${sensitive.owner} (expected ${MUTABLE_OPENCLAW_OWNER})`);
    }
  }
  return {
    applies: true,
    ok: issues.length === 0,
    inspectionMethod: "stat",
    dirMode: dir.mode,
    dirOwner: dir.owner,
    fileMode: file.mode,
    fileOwner: file.owner,
    configDir: target.configDir,
    configFile: target.configFile,
    issues,
  };
}

function inspectMutableConfigStatPlan(
  target: AgentConfigTarget,
  plan: Extract<HarnessMutableConfigPlan, { kind: "stat" }>,
  statModeOwner: (path: string) => string,
): MutableConfigPermsInspection {
  let dir: { mode: string; owner: string };
  let file: { mode: string; owner: string };
  try {
    dir = parseStatModeOwner(statModeOwner(target.configDir));
    file = parseStatModeOwner(statModeOwner(target.configPath));
  } catch (error) {
    return {
      applies: false,
      skipReason: "unavailable",
      reason: `could not stat config (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const issues: string[] = [];
  if (dir.mode.padStart(4, "0") !== plan.directoryMode.padStart(4, "0")) {
    issues.push(`${target.configDir} mode ${dir.mode} (expected ${plan.directoryMode})`);
  }
  if (dir.owner !== plan.directoryOwner) {
    issues.push(`${target.configDir} owner ${dir.owner} (expected ${plan.directoryOwner})`);
  }
  const filePaths = [target.configPath, ...(target.sensitiveFiles ?? [])];
  for (const filePath of filePaths) {
    let actual: { mode: string; owner: string };
    try {
      actual = filePath === target.configPath ? file : parseStatModeOwner(statModeOwner(filePath));
    } catch {
      continue;
    }
    if (actual.mode.padStart(4, "0") !== plan.fileMode.padStart(4, "0")) {
      issues.push(`${filePath} mode ${actual.mode} (expected ${plan.fileMode})`);
    }
    if (actual.owner !== plan.fileOwner) {
      issues.push(`${filePath} owner ${actual.owner} (expected ${plan.fileOwner})`);
    }
  }
  return {
    applies: true,
    ok: issues.length === 0,
    inspectionMethod: "stat",
    dirMode: dir.mode,
    dirOwner: dir.owner,
    fileMode: file.mode,
    fileOwner: file.owner,
    configDir: target.configDir,
    configFile: target.configPath,
    issues,
  };
}

function inspectMutableConfigProbePlan(
  target: AgentConfigTarget,
  plan: Extract<HarnessMutableConfigPlan, { kind: "probe" }>,
  executeProbe: (command: HarnessExitZeroCommand) => void,
): Extract<MutableConfigPermsInspection, { inspectionMethod: "probe" }> {
  try {
    executeProbe(plan.probe);
    return {
      applies: true,
      ok: true,
      inspectionMethod: "probe",
      configDir: target.configDir,
      configFile: target.configFile,
      issues: [],
    };
  } catch (error) {
    return {
      applies: true,
      ok: false,
      inspectionMethod: "probe",
      configDir: target.configDir,
      configFile: target.configFile,
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function inspectPackageMutableConfigPlan(
  target: AgentConfigTarget,
  plan: HarnessMutableConfigPlan,
  statModeOwner: (path: string) => string,
  executeProbe: (command: HarnessExitZeroCommand) => void,
): MutableConfigPermsInspection {
  switch (plan.kind) {
    case "not-required":
      return { applies: false, skipReason: "agent", reason: plan.reason };
    case "stat":
      return inspectMutableConfigStatPlan(target, plan, statModeOwner);
    case "probe":
      return inspectMutableConfigProbePlan(target, plan, executeProbe);
  }
}

export function repairMutableConfigPermsForTarget(
  target: AgentConfigTarget,
  applyMutableContract: () => void,
): MutableConfigRepairResult {
  if (target.agentName !== "openclaw") {
    return {
      applied: false,
      skipReason: "agent",
      reason: `agent ${target.agentName} does not use the mutable OpenClaw config contract`,
    };
  }
  try {
    applyMutableContract();
    return { applied: true, verified: true, errors: [] };
  } catch (error) {
    return {
      applied: true,
      verified: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

const MUTABLE_CONFIG_NORMALIZER = "/usr/local/lib/nemoclaw/normalize_mutable_config_perms.py";
const MUTABLE_CONFIG_NORMALIZER_HOST_TIMEOUT_MS = 25_000;
const MUTABLE_CONFIG_NORMALIZER_WATCHDOG = [
  "/usr/bin/timeout",
  "--signal=TERM",
  "--kill-after=5s",
  "15s",
] as const;
const MUTABLE_HERMES_CONFIG_PROBE_TIMEOUT_MS = 20_000;
const MUTABLE_HERMES_CONFIG_PROBE = String.raw`
import os
import stat
import sys
import uuid

config_dir = os.path.normpath(sys.argv[1])
config_paths = [os.path.normpath(value) for value in sys.argv[2:]]
if not os.path.isabs(config_dir) or not config_paths:
    raise RuntimeError("Hermes mutable config probe requires absolute paths")

directory_flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_DIRECTORY
file_flags = os.O_WRONLY | os.O_APPEND | os.O_CLOEXEC | os.O_NOFOLLOW
directory_fd = os.open(config_dir, directory_flags)
try:
    directory = os.fstat(directory_fd)
    if not stat.S_ISDIR(directory.st_mode):
        raise RuntimeError("Hermes config root is not a directory")
    if directory.st_uid != os.geteuid() or directory.st_gid != os.getegid():
        raise RuntimeError("Hermes config root is not owned by the sandbox identity")
    if stat.S_IMODE(directory.st_mode) != 0o3770:
        raise RuntimeError("Hermes config root does not have mode 3770")

    for config_path in config_paths:
        if os.path.dirname(config_path) != config_dir:
            raise RuntimeError("Hermes config artifact escaped the config root")
        descriptor = os.open(os.path.basename(config_path), file_flags, dir_fd=directory_fd)
        try:
            artifact = os.fstat(descriptor)
            if not stat.S_ISREG(artifact.st_mode) or artifact.st_nlink != 1:
                raise RuntimeError("Hermes config artifact is not a singly linked regular file")
            if artifact.st_uid != os.geteuid() or artifact.st_gid != os.getegid():
                raise RuntimeError("Hermes config artifact is not owned by the sandbox identity")
            if stat.S_IMODE(artifact.st_mode) != 0o640:
                raise RuntimeError("Hermes config artifact does not have mode 0640")
        finally:
            os.close(descriptor)

    probe_name = ".nemoclaw-mutable-posture-" + uuid.uuid4().hex
    created = False
    try:
        os.mkdir(probe_name, 0o700, dir_fd=directory_fd)
        created = True
    finally:
        if created:
            os.rmdir(probe_name, dir_fd=directory_fd)
finally:
    os.close(directory_fd)
`;

export function mutableHermesConfigProbeCommand(target: AgentConfigTarget): readonly string[] {
  if (target.agentName !== "hermes") {
    throw new Error(`agent ${target.agentName} does not use the mutable Hermes config contract`);
  }
  return [
    "/usr/bin/setpriv",
    "--reuid=sandbox",
    "--regid=sandbox",
    "--init-groups",
    "--",
    "/usr/bin/python3",
    "-I",
    "-c",
    MUTABLE_HERMES_CONFIG_PROBE,
    target.configDir,
    target.configPath,
    ...(target.sensitiveFiles ?? []),
  ];
}

export function verifyMutableHermesConfigForTarget(
  target: AgentConfigTarget,
  executeProbe: (command: readonly string[]) => void,
): MutableHermesConfigVerification {
  try {
    executeProbe(mutableHermesConfigProbeCommand(target));
    return { verified: true, errors: [] };
  } catch (error) {
    return {
      verified: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function privilegedExecCapture(
  sandboxName: string,
  command: readonly string[],
  expectedResourceHandle: () => string,
  dependencies: MutableConfigPermsDependencies,
): string {
  return dependencies
    .captureSandboxCommand(sandboxName, command, {
      sanitizeEnvironment: true,
      expectedResourceHandle: expectedResourceHandle(),
      timeout: 15_000,
      maxOutputBytes: 8 * 1024,
    })
    .toString("utf8")
    .trim();
}

function executePackageMutableConfigCommand(
  sandboxName: string,
  command: HarnessExitZeroCommand,
  expectedResourceHandle: () => string,
  dependencies: MutableConfigPermsDependencies,
): void {
  let result: ReturnType<typeof executePrivilegedSandboxCommand>;
  try {
    result = dependencies.executeSandboxCommand(sandboxName, command.command, {
      sanitizeEnvironment: true,
      expectedResourceHandle: expectedResourceHandle(),
      timeout: command.timeoutSeconds * 1000,
      maxOutputBytes: 8 * 1024,
    });
  } catch (error) {
    throw new Error(command.failureMessage, { cause: error });
  }
  if (result.status !== 0 || result.signal !== null || result.error) {
    throw new Error(command.failureMessage, {
      ...(result.error ? { cause: result.error } : {}),
    });
  }
}

function sandboxIdentityId(
  sandboxName: string,
  flag: "-u" | "-g",
  expectedResourceHandle: () => string,
  dependencies: MutableConfigPermsDependencies,
): string {
  const id = privilegedExecCapture(
    sandboxName,
    ["/usr/bin/id", flag, "sandbox"],
    expectedResourceHandle,
    dependencies,
  );
  if (!/^[1-9][0-9]*$/.test(id)) {
    throw new Error(`sandbox identity lookup returned an invalid ${flag === "-u" ? "UID" : "GID"}`);
  }
  return id;
}

function normalizeMutableOpenClawConfig(
  sandboxName: string,
  configDir: string,
  expectedResourceHandle: () => string,
  dependencies: MutableConfigPermsDependencies,
): void {
  const sandboxUid = sandboxIdentityId(sandboxName, "-u", expectedResourceHandle, dependencies);
  const sandboxGid = sandboxIdentityId(sandboxName, "-g", expectedResourceHandle, dependencies);
  const result = dependencies.executeSandboxCommand(
    sandboxName,
    [
      ...MUTABLE_CONFIG_NORMALIZER_WATCHDOG,
      "/usr/bin/python3",
      "-I",
      MUTABLE_CONFIG_NORMALIZER,
      configDir,
      sandboxUid,
      sandboxGid,
    ],
    {
      sanitizeEnvironment: true,
      expectedResourceHandle: expectedResourceHandle(),
      timeout: MUTABLE_CONFIG_NORMALIZER_HOST_TIMEOUT_MS,
      maxOutputBytes: 8 * 1024,
    },
  );
  if (result.status !== 0 || result.signal !== null || result.error) {
    throw new Error("OpenClaw mutable configuration permissions could not be repaired.", {
      ...(result.error ? { cause: result.error } : {}),
    });
  }
}

export function inspectMutableConfigPerms(
  sandboxName: string,
  dependencyOverrides: Partial<MutableConfigPermsDependencies> = {},
): MutableConfigPermsInspection {
  validateName(sandboxName, "sandbox name");
  const dependencies = mutableConfigDependencies(dependencyOverrides);
  return dependencies.withMutationLock(sandboxName, () => {
    const target = dependencies.resolveConfigTarget(sandboxName);
    const selection = dependencies.loadConfigAdapter(sandboxName, target);
    let resourceHandle: string | undefined;
    const expectedResourceHandle = () =>
      (resourceHandle ??= dependencies.resolveResourceHandle(sandboxName));
    const statModeOwner = (configPath: string) =>
      privilegedExecCapture(
        sandboxName,
        ["stat", "-c", "%a %U:%G", configPath],
        expectedResourceHandle,
        dependencies,
      );
    if (selection) {
      const plan = selection.adapter.describeMutableConfig({
        target: toHarnessConfigTarget(target),
        sandboxUid: null,
        sandboxGid: null,
      });
      return inspectPackageMutableConfigPlan(target, plan, statModeOwner, (command) =>
        executePackageMutableConfigCommand(
          sandboxName,
          command,
          expectedResourceHandle,
          dependencies,
        ),
      );
    }
    return inspectMutableConfigPermsForTarget(target, statModeOwner);
  });
}

export function repairMutableConfigPerms(
  sandboxName: string,
  dependencyOverrides: Partial<MutableConfigPermsDependencies> = {},
): MutableConfigRepairResult {
  validateName(sandboxName, "sandbox name");
  const dependencies = mutableConfigDependencies(dependencyOverrides);
  return dependencies.withMutationLock(sandboxName, () => {
    const target = dependencies.resolveConfigTarget(sandboxName);
    const selection = dependencies.loadConfigAdapter(sandboxName, target);
    let resourceHandle: string | undefined;
    const expectedResourceHandle = () =>
      (resourceHandle ??= dependencies.resolveResourceHandle(sandboxName));
    if (selection) {
      const initialPlan = selection.adapter.describeMutableConfig({
        target: toHarnessConfigTarget(target),
        sandboxUid: null,
        sandboxGid: null,
      });
      if (initialPlan.kind === "not-required") {
        return { applied: false, skipReason: "agent", reason: initialPlan.reason };
      }
      if (initialPlan.kind !== "stat") {
        return {
          applied: false,
          skipReason: "agent",
          reason: "the installed package does not define mutable configuration repair",
        };
      }
      try {
        const sandboxUid = sandboxIdentityId(
          sandboxName,
          "-u",
          expectedResourceHandle,
          dependencies,
        );
        const sandboxGid = sandboxIdentityId(
          sandboxName,
          "-g",
          expectedResourceHandle,
          dependencies,
        );
        const plan = selection.adapter.describeMutableConfig({
          target: toHarnessConfigTarget(target),
          sandboxUid,
          sandboxGid,
        });
        if (plan.kind !== "stat" || !plan.repair) {
          return {
            applied: false,
            skipReason: "agent",
            reason: "the installed package does not define mutable configuration repair",
          };
        }
        executePackageMutableConfigCommand(
          sandboxName,
          plan.repair,
          expectedResourceHandle,
          dependencies,
        );
        const verificationPlan = selection.adapter.describeMutableConfig({
          target: toHarnessConfigTarget(target),
          sandboxUid: null,
          sandboxGid: null,
        });
        const verification = inspectPackageMutableConfigPlan(
          target,
          verificationPlan,
          (configPath) =>
            privilegedExecCapture(
              sandboxName,
              ["stat", "-c", "%a %U:%G", configPath],
              expectedResourceHandle,
              dependencies,
            ),
          (command) =>
            executePackageMutableConfigCommand(
              sandboxName,
              command,
              expectedResourceHandle,
              dependencies,
            ),
        );
        return {
          applied: true,
          verified: verification.applies && verification.ok,
          errors:
            verification.applies && !verification.ok
              ? [...verification.issues]
              : verification.applies
                ? []
                : [
                    `mutable configuration posture could not be verified after repair: ${verification.reason}`,
                  ],
        };
      } catch (error) {
        return {
          applied: true,
          verified: false,
          errors: [error instanceof Error ? error.message : String(error)],
        };
      }
    }
    return repairMutableConfigPermsForTarget(target, () =>
      normalizeMutableOpenClawConfig(
        sandboxName,
        target.configDir,
        expectedResourceHandle,
        dependencies,
      ),
    );
  });
}

export function inspectMutableHermesConfigPerms(
  sandboxName: string,
  dependencyOverrides: Partial<MutableConfigPermsDependencies> = {},
): MutableHermesConfigVerification {
  validateName(sandboxName, "sandbox name");
  const dependencies = mutableConfigDependencies(dependencyOverrides);
  return dependencies.withMutationLock(sandboxName, () => {
    const target = dependencies.resolveConfigTarget(sandboxName);
    const selection = dependencies.loadConfigAdapter(sandboxName, target);
    let resourceHandle: string | undefined;
    const expectedResourceHandle = () =>
      (resourceHandle ??= dependencies.resolveResourceHandle(sandboxName));
    if (selection) {
      const plan = selection.adapter.describeMutableConfig({
        target: toHarnessConfigTarget(target),
        sandboxUid: null,
        sandboxGid: null,
      });
      if (plan.kind === "not-required") return { verified: true, errors: [] };
      if (plan.kind !== "probe") {
        return {
          verified: false,
          errors: ["installed package does not define a mutable configuration probe"],
        };
      }
      const inspection = inspectMutableConfigProbePlan(target, plan, (command) =>
        executePackageMutableConfigCommand(
          sandboxName,
          command,
          expectedResourceHandle,
          dependencies,
        ),
      );
      return { verified: inspection.ok, errors: inspection.issues };
    }
    return verifyMutableHermesConfigForTarget(target, (command) => {
      const result = dependencies.executeSandboxCommand(sandboxName, command, {
        sanitizeEnvironment: true,
        expectedResourceHandle: expectedResourceHandle(),
        timeout: MUTABLE_HERMES_CONFIG_PROBE_TIMEOUT_MS,
        maxOutputBytes: 8 * 1024,
      });
      if (result.status !== 0 || result.signal !== null || result.error) {
        throw new Error("Hermes mutable configuration probe failed.", {
          ...(result.error ? { cause: result.error } : {}),
        });
      }
    });
  });
}
