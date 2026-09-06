#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Refuse a snapshot while DCode can still be mutating its durable state. Exit
# 75 means busy; any other non-zero result means the process state could not be
# proved. NemoClaw treats both as fail-closed and retains archive authority.

emit_state() {
  printf 'NEMOCLAW_STATE_BACKUP=%s\n' "$1"
  exit "$2"
}

has_runtime=0
[ -d /sandbox/.deepagents ] && has_runtime=1
[ -n "${HOME:-}" ] && [ -d "$HOME/.deepagents" ] && has_runtime=1
command -v dcode >/dev/null 2>&1 && has_runtime=1
command -v deepagents-code >/dev/null 2>&1 && has_runtime=1

detect_active_process() {
  awk '
/^[[:space:]]*[0-9]+[[:space:]]+([^[:space:]]*\/)?python[0-9.]*[[:space:]]+(-I[[:space:]]+)?-m[[:space:]]+deepagents[_]code([[:space:]]|$)/ { found = 1 }
/^[[:space:]]*[0-9]+[[:space:]]+([^[:space:]]*\/)?[d]code([[:space:]]|$)/ { found = 1 }
/^[[:space:]]*[0-9]+[[:space:]]+([^[:space:]]*\/)?deepagents[-_]code([[:space:]]|$)/ { found = 1 }
END { exit found ? 0 : 1 }
'
}

if processes="$(ps -eo pid=,args= 2>/dev/null)"; then
  printf '%s\n' "$processes" | detect_active_process && emit_state busy 75
  [ "$?" -eq 1 ] || emit_state unverifiable 1
  [ "$has_runtime" -eq 1 ] && emit_state ready 0
  emit_state ready 0
fi

processes=""
saw_process=0
scan_incomplete=0
for cmdline in /proc/[0-9]*/cmdline; do
  [ -e "$cmdline" ] || continue
  [ -r "$cmdline" ] || {
    scan_incomplete=1
    continue
  }
  pid="$(basename "$(dirname "$cmdline")")"
  command_line="$(tr '\000\n\r' '   ' <"$cmdline" 2>/dev/null)" || {
    scan_incomplete=1
    continue
  }
  [ -n "$command_line" ] || {
    scan_incomplete=1
    continue
  }
  saw_process=1
  processes="$processes$pid $command_line
"
done

if [ "$scan_incomplete" -ne 0 ] || [ "$saw_process" -ne 1 ]; then
  [ "$has_runtime" -eq 1 ] && emit_state unverifiable 1
  emit_state ready 0
fi
printf '%s\n' "$processes" | detect_active_process && emit_state busy 75
[ "$?" -eq 1 ] || emit_state unverifiable 1
[ "$has_runtime" -eq 1 ] && emit_state ready 0
emit_state ready 0
