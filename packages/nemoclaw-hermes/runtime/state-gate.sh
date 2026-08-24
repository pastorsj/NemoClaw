# shellcheck shell=bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Authenticate runtime state mutation admission before startup continues.

# The provider gate is a fixed root-owned file beneath a search-only directory
# outside /sandbox, so the sandbox identity cannot rename either the gate or
# its parent.  Run the immutable validator as this shell's direct child before
# sourcing helpers or reading mutable state; its permit is bound to this exact
# process identity.  Invalid or uninspectable gate state is a hold, never an
# availability-to-integrity downgrade.
readonly NEMOCLAW_RUNTIME_STATE_MUTATION_GATE_PYTHON="/opt/hermes/.venv/bin/python3"
readonly NEMOCLAW_RUNTIME_STATE_MUTATION_GATE_HELPER="/usr/local/lib/nemoclaw/runtime-state-mutation-startup-gate.py"
readonly NEMOCLAW_RUNTIME_STATE_MUTATION_GATE_SETPRIV="/usr/bin/setpriv"

if [ ! -x "$NEMOCLAW_RUNTIME_STATE_MUTATION_GATE_PYTHON" ] \
  || [ ! -f "$NEMOCLAW_RUNTIME_STATE_MUTATION_GATE_HELPER" ] \
  || [ -L "$NEMOCLAW_RUNTIME_STATE_MUTATION_GATE_HELPER" ] \
  || { [ "$EUID" -eq 0 ] && [ ! -x "$NEMOCLAW_RUNTIME_STATE_MUTATION_GATE_SETPRIV" ]; }; then
  printf '%s\n' '[SECURITY] Required runtime state mutation startup gate is unavailable.' >&2
  exit 1
fi

nemoclaw_runtime_state_mutation_gate() {
  local action="$1"
  if [ "$EUID" -eq 0 ]; then
    "$NEMOCLAW_RUNTIME_STATE_MUTATION_GATE_SETPRIV" \
      --reuid=sandbox --regid=sandbox --init-groups -- \
      "$NEMOCLAW_RUNTIME_STATE_MUTATION_GATE_PYTHON" -I \
      "$NEMOCLAW_RUNTIME_STATE_MUTATION_GATE_HELPER" "$action" >/dev/null
    return
  fi
  "$NEMOCLAW_RUNTIME_STATE_MUTATION_GATE_PYTHON" -I \
    "$NEMOCLAW_RUNTIME_STATE_MUTATION_GATE_HELPER" "$action" >/dev/null
}

nemoclaw_runtime_state_mutation_retry_exec() {
  local status
  if nemoclaw_runtime_state_mutation_gate restart; then
    status=0
  else
    status=$?
  fi
  if [ "$status" -eq 12 ]; then
    exec /usr/local/bin/nemoclaw-start \
      "${NEMOCLAW_RUNTIME_STATE_MUTATION_RETRY_ARGV[@]}"
  fi
  printf '%s\n' '[SECURITY] Runtime state mutation retry was not authenticated; holding startup.' >&2
  kill -STOP "$$"
}
trap nemoclaw_runtime_state_mutation_retry_exec USR2

while :; do
  if nemoclaw_runtime_state_mutation_gate admit; then
    break
  else
    _nemoclaw_runtime_state_mutation_gate_status=$?
  fi
  case "$_nemoclaw_runtime_state_mutation_gate_status" in
    10) break ;;
    75)
      printf '%s\n' '[SECURITY] Hermes startup held by an active runtime state mutation.' >&2
      /bin/sleep 1 || true
      ;;
    *)
      printf '%s\n' '[SECURITY] Runtime state mutation startup gate failed.' >&2
      exit 1
      ;;
  esac
done
unset _nemoclaw_runtime_state_mutation_gate_status

# Publish a candidate only after the complete gateway topology is healthy.
# The shell then stops itself until the root controller has independently
# authenticated the candidate, frozen the exact process tree, and published a
# release receipt.  Calling this with no active mutation is a cheap no-op.
nemoclaw_runtime_state_mutation_checkpoint() {
  local status
  if nemoclaw_runtime_state_mutation_gate checkpoint; then
    return 0
  else
    status=$?
  fi
  if [ "$status" -ne 11 ]; then
    printf '%s\n' '[SECURITY] Runtime state mutation startup checkpoint was refused; holding startup.' >&2
    kill -STOP "$$"
    return 1
  fi
  kill -STOP "$$"
  if nemoclaw_runtime_state_mutation_gate resume; then
    return 0
  else
    status=$?
  fi
  if [ "$status" -eq 12 ]; then
    exec /usr/local/bin/nemoclaw-start \
      "${NEMOCLAW_RUNTIME_STATE_MUTATION_RETRY_ARGV[@]}"
  fi
  printf '%s\n' '[SECURITY] Runtime state mutation release receipt was not authenticated; holding startup.' >&2
  kill -STOP "$$"
  return 1
}
