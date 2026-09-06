// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type LegacyDiagnosticSession = {
  readonly harnessPackage?: unknown;
  readonly harnessPackageMigration?: unknown;
} | null;

type CaptureSandboxOutput = (
  args: string[],
  opts?: { ignoreError?: boolean; includeStderr?: boolean; timeout?: number },
) => string | null;

const HERMES_TIRITH_MARKER_ABSENT = "tirith marker: absent";
const HERMES_STARTUP_DIAGNOSTICS_SCRIPT = `
set +e
marker=/sandbox/.hermes/.tirith-install-failed
if [ ! -e "$marker" ]; then
  echo "${HERMES_TIRITH_MARKER_ABSENT}"
  exit 0
fi
if [ -L "$marker" ]; then
  echo "tirith marker: symlink (not read)"
else
  printf "tirith marker: "
  head -c 200 "$marker" 2>/dev/null || printf "unreadable"
  printf "\\n"
fi

tirith=/sandbox/.hermes/bin/tirith
if [ -x "$tirith" ] && [ ! -L "$tirith" ]; then
  echo "tirith binary: present executable ($tirith)"
elif [ -e "$tirith" ]; then
  echo "tirith binary: present but not executable ($tirith)"
else
  echo "tirith binary: missing ($tirith)"
fi

for log in /tmp/nemoclaw-start.log /tmp/gateway.log; do
  if [ -f "$log" ] && [ ! -L "$log" ]; then
    echo "--- tail: $log ---"
    tail -n 40 "$log" 2>/dev/null || echo "(tail unavailable)"
  elif [ -L "$log" ]; then
    echo "--- tail: $log skipped (symlink) ---"
  else
    echo "--- tail: $log unavailable ---"
  fi
done
`.trim();

/** Collect read-only diagnostics for a historical no-receipt Hermes sandbox. */
export function collectHermesStartupDiagnostics(
  sandboxName: string,
  runCaptureOpenshell: CaptureSandboxOutput,
  redactOutput: (value: string) => string,
): string[] {
  const output = runCaptureOpenshell(
    ["sandbox", "exec", "-n", sandboxName, "--", "sh", "-lc", HERMES_STARTUP_DIAGNOSTICS_SCRIPT],
    { ignoreError: true },
  );
  const lines = String(redactOutput(output ?? ""))
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  const markerLine = lines.find((line) => line.startsWith("tirith marker:"));
  if (!markerLine || markerLine === HERMES_TIRITH_MARKER_ABSENT) return [];
  return ["Hermes startup diagnostics:", ...lines.slice(0, 140)];
}

/**
 * Keep exact historical diagnostics behind an explicit absence-of-package
 * proof. Receipt-backed packages own their startup behavior and diagnostics.
 */
export function collectLegacyAgentStartupDiagnostics(
  agentName: string,
  session: LegacyDiagnosticSession,
  sandboxName: string,
  runCaptureOpenshell: CaptureSandboxOutput,
  redactOutput: (value: string) => string,
): string[] {
  if (
    session?.harnessPackage != null ||
    session?.harnessPackageMigration != null ||
    agentName !== "hermes"
  ) {
    return [];
  }
  return collectHermesStartupDiagnostics(sandboxName, runCaptureOpenshell, redactOutput);
}
