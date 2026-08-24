#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
installed_package_root="${HOME:?HOME must be set}/.nemoclaw/harnesses/nemoclaw-openclaw"
bundled_package_root="${script_dir}/../packages/nemoclaw-openclaw"
package_root="${bundled_package_root}"
registry_module="${script_dir}/../dist/lib/harness/package-registry.js"

if [[ -e "${installed_package_root}" || -L "${installed_package_root}" ]]; then
  if [[ ! -d "${installed_package_root}" || -L "${installed_package_root}" ]]; then
    printf 'Installed OpenClaw harness package is not a regular directory: %s\n' \
      "${installed_package_root}" >&2
    exit 1
  fi
  if [[ ! -f "${registry_module}" || -L "${registry_module}" ]]; then
    printf 'NemoClaw CLI build is unavailable for installed harness validation: %s\n' \
      "${registry_module}" >&2
    exit 1
  fi
  package_root="$({
    node - "${registry_module}" "${installed_package_root}" <<'NODE'
const path = require("node:path");

try {
  const registry = require(process.argv[2]);
  const expectedRoot = path.resolve(process.argv[3]);
  const harnessPackage = registry.resolveHarnessPackage("openclaw", process.env);
  if (
    !harnessPackage ||
    harnessPackage.source !== "installed" ||
    path.resolve(harnessPackage.rootDir) !== expectedRoot
  ) {
    throw new Error("installed OpenClaw harness package did not resolve to its canonical root");
  }
  process.stdout.write(harnessPackage.rootDir);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
NODE
  } || {
    printf 'Installed OpenClaw harness package failed validation: %s\n' \
      "${installed_package_root}" >&2
    exit 1
  })"
fi

backup_script="${package_root}/runtime/backup-workspace.sh"
if [[ ! -f "${backup_script}" || -L "${backup_script}" || ! -x "${backup_script}" ]]; then
  printf 'OpenClaw harness backup helper is unavailable: %s\n' "${backup_script}" >&2
  exit 1
fi

exec "${backup_script}" "$@"
