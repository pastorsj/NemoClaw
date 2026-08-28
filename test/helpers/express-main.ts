// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { onTestFinished } from "vitest";

import { runInstallerSourced } from "./installer-express-prompt-harness";

function quoteShellValue(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function runAcceptedStationMain(
  extraEnvironment: Record<string, string>,
  entrypointArguments: string[],
) {
  const exports = Object.entries(extraEnvironment)
    .map(([name, value]) => `export ${name}=${quoteShellValue(value)}`)
    .join("\n");
  const argumentsText = entrypointArguments.map(quoteShellValue).join(" ");
  const run = runInstallerSourced(`
set -e
${exports}
record() { printf '%s\n' "$1" >> "$HOME/calls.log"; }
node() { ${quoteShellValue(process.execPath)} "$@"; }
detect_express_platform() { record express-selection; printf '%s' 'DGX Station'; }
print_banner() { :; }
install_nodejs() { :; }
ensure_supported_runtime() { :; }
resolve_pending_express_wsl_provider() { record resolve-wsl; }
ensure_station_express_pair() { record station-pair; }
fix_npm_permissions() { :; }
prepare_current_cli_for_preupgrade_backup() { record prepare-current-cli; }
resolve_prepared_cli_runner() { printf '%s' installer_test_cli; }
installer_test_cli() {
  if [[ "$1" == "internal" && "$2" == "installer" && "$3" == "reconcile-harnesses" && "$4" == "--json" ]]; then
    record harness-reconcile
    printf '%s\n' '{"schemaVersion":1,"outcome":"ready"}'
    return 0
  fi
  if [[ "$1" == "harness" && "$2" == "install" ]]; then
    record "harness-install-$3"
    return 0
  fi
  return 99
}
bash() { record setup-jetson; }
classify_dgx_station_release() { printf '%s' "\${EXPRESS_RELEASE_STATE:-generic-ubuntu}"; }
station_installer_revision() { printf '%s' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; }
station_express_resume_generation() { printf '%s' '0123456789abcdef0123456789abcdef'; }
express_prompt_can_read_tty() { return 0; }
ensure_station_express_host() { record station-host-prep; }
prepare_portable_experimental_runtime_override() { :; }
ensure_docker() {
  record ensure-docker
  printf 'RESULT PROVIDER=%s MODEL=%s\n' "\${NEMOCLAW_PROVIDER:-}" "\${NEMOCLAW_MODEL:-}"
  exit 0
}
function [ {
  if [[ "$#" -eq 3 && "$1" == "-t" && "$2" == "0" && "$3" == "]" ]]; then return 0; fi
  builtin [ "$@"
}
main ${argumentsText} <<< $'\n'
`);
  onTestFinished(() => fs.rmSync(run.home, { recursive: true, force: true }));
  const callLog = path.join(run.home, "calls.log");
  const calls = fs.existsSync(callLog)
    ? fs.readFileSync(callLog, "utf-8").trim().split(/\r?\n/).filter(Boolean)
    : [];
  return { ...run, calls };
}
