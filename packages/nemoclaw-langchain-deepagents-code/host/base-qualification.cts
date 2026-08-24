// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const DCODE_AGENT_NAME = "langchain-deepagents-code";
const DEEPAGENTS_CODE_DISTRIBUTION = "deepagents-code";
const DEEPAGENTS_CODE_DOS2UNIX_PROBE_OK = "nemoclaw-dcode-dos2unix-ok";
const DEEPAGENTS_CODE_BASE_IMAGE_PROBE_GUARDS = [
  "--network",
  "none",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--read-only",
];
const DCODE_PROBE_PREFIX = "NEMOCLAW_DCODE_PROBE=";
const DCODE_PROBE_STATE = {
  active: "active",
  idleDcodeRuntime: "idle",
  unverifiableDcodeRuntime: "unverifiable",
  noDcodeRuntime: "no-runtime",
};
const DCODE_MANAGED_EXEC_LAUNCHER = "/usr/local/lib/nemoclaw/dcode-managed-exec";
const DCODE_MANAGED_EXEC_MISSING_DETAIL =
  "trusted Deep Agents Code route-probe helper is missing; rebuild this sandbox with the updated NemoClaw image before retrying connect, status, or doctor";

const DCODE_BUSY_PROBE_SCRIPT = String.raw`emit_dcode_probe_state() {
  printf 'NEMOCLAW_DCODE_PROBE=%s\n' "$1"
  exit 0
}
has_dcode_runtime=0
dc_bin="$(printf 'd%s' code)"
da_bin="$(printf 'deepagents-%s' code)"
home_dir="$HOME"
[ -n "$home_dir" ] || home_dir=/sandbox
[ -d /sandbox/.deepagents ] && has_dcode_runtime=1
[ -d "$home_dir/.deepagents" ] && has_dcode_runtime=1
command -v "$dc_bin" >/dev/null 2>&1 && has_dcode_runtime=1
command -v "$da_bin" >/dev/null 2>&1 && has_dcode_runtime=1
detect_dcode_processes() {
  awk '
/^[[:space:]]*[0-9]+[[:space:]]+([^[:space:]]*\/)?python[0-9.]*[[:space:]]+(-I[[:space:]]+)?-m[[:space:]]+deepagents[_]code([[:space:]]|$)/ {
  found = 1
}
/^[[:space:]]*[0-9]+[[:space:]]+([^[:space:]]*\/)?[d]code([[:space:]]|$)/ {
  found = 1
}
/^[[:space:]]*[0-9]+[[:space:]]+([^[:space:]]*\/)?deepagents[-_]code([[:space:]]|$)/ {
  found = 1
}
END { exit found ? 0 : 1 }
'
}
proc_root=/proc
processes="$(ps -eo pid=,args= 2>/dev/null)" || {
  processes=""
  saw_proc_process=0
  proc_scan_incomplete=0
  for cmdline in "$proc_root"/[0-9]*/cmdline; do
    [ -e "$cmdline" ] || continue
    [ -r "$cmdline" ] || {
      proc_scan_incomplete=1
      continue
    }
    pid="$(basename "$(dirname "$cmdline")")"
    command_line="$(tr '\000\n\r' '   ' < "$cmdline" 2>/dev/null)" || {
      proc_scan_incomplete=1
      continue
    }
    [ -n "$command_line" ] || {
      proc_scan_incomplete=1
      continue
    }
    saw_proc_process=1
    processes="$processes$pid $command_line
"
  done
  [ "$proc_scan_incomplete" -eq 0 ] || {
    [ "$has_dcode_runtime" -eq 1 ] && emit_dcode_probe_state unverifiable
    emit_dcode_probe_state no-runtime
  }
  [ "$saw_proc_process" -eq 1 ] || {
    [ "$has_dcode_runtime" -eq 1 ] && emit_dcode_probe_state unverifiable
    emit_dcode_probe_state no-runtime
  }
}
printf '%s\n' "$processes" | detect_dcode_processes
matched=$?
[ "$matched" -eq 0 ] && emit_dcode_probe_state active
[ "$matched" -ne 1 ] && {
  [ "$has_dcode_runtime" -eq 1 ] && emit_dcode_probe_state unverifiable
  emit_dcode_probe_state no-runtime
}
[ "$has_dcode_runtime" -eq 1 ] && emit_dcode_probe_state idle
emit_dcode_probe_state no-runtime
`;

function createDeepAgentsCodeVersionProbe(imageRef) {
  return {
    args: [
      "run",
      "--rm",
      ...DEEPAGENTS_CODE_BASE_IMAGE_PROBE_GUARDS,
      "--entrypoint",
      "/opt/venv/bin/python3",
      imageRef,
      "-I",
      "-c",
      `import importlib.metadata; print(importlib.metadata.version("${DEEPAGENTS_CODE_DISTRIBUTION}"))`,
    ],
    distribution: DEEPAGENTS_CODE_DISTRIBUTION,
  };
}

function getDeepAgentsCodeDistribution() {
  return DEEPAGENTS_CODE_DISTRIBUTION;
}

function getDeepAgentsCodeBaseImageInputPaths() {
  return ["manifest.yaml", "runtime/requirements.lock"];
}

function createDeepAgentsCodeDos2UnixProbe(imageRef) {
  return {
    args: [
      "run",
      "--rm",
      ...DEEPAGENTS_CODE_BASE_IMAGE_PROBE_GUARDS,
      "--user",
      "999:999",
      "--entrypoint",
      "/bin/sh",
      imageRef,
      "-eu",
      "-c",
      [
        "test -x /usr/bin/dos2unix",
        'test "$(command -v dos2unix)" = /usr/bin/dos2unix',
        "dos2unix --version >/dev/null",
        `printf '%s\\n' "${DEEPAGENTS_CODE_DOS2UNIX_PROBE_OK}"`,
      ].join("; "),
    ],
    expectedOutput: DEEPAGENTS_CODE_DOS2UNIX_PROBE_OK,
  };
}

function getDcodeActivityProbe() {
  return {
    agentName: DCODE_AGENT_NAME,
    prefix: DCODE_PROBE_PREFIX,
    states: { ...DCODE_PROBE_STATE },
    script: DCODE_BUSY_PROBE_SCRIPT,
  };
}

function getDcodeManagedExec() {
  return {
    agentName: DCODE_AGENT_NAME,
    launcher: DCODE_MANAGED_EXEC_LAUNCHER,
    missingDetail: DCODE_MANAGED_EXEC_MISSING_DETAIL,
  };
}

function buildDcodeManagedExecLaunchArgs(commandArgs) {
  return [
    "--no-tty",
    "--env",
    "HOME=/usr/local/lib/nemoclaw",
    "--env",
    "BASH_ENV=",
    "--env",
    "ENV=",
    "--",
    DCODE_MANAGED_EXEC_LAUNCHER,
    ...commandArgs,
  ];
}

module.exports = {
  buildDcodeManagedExecLaunchArgs,
  createDeepAgentsCodeDos2UnixProbe,
  createDeepAgentsCodeVersionProbe,
  getDeepAgentsCodeBaseImageInputPaths,
  getDeepAgentsCodeDistribution,
  getDcodeActivityProbe,
  getDcodeManagedExec,
};
