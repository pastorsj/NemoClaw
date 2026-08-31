// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const SANDBOX_RLIMITS = path.resolve(PACKAGE_ROOT, "../../scripts/lib/sandbox-rlimits.sh");

export function copyRlimitFixture(rlimitLib: string): void {
  // TEST-ONLY OVERRIDE: production remains 512 in scripts/lib/sandbox-rlimits.sh.
  // RLIMIT_NPROC is shared by the real user, so that default can starve this
  // test's own shell when Vitest runs many workers concurrently.
  copyRlimitFixtureWithNprocLimit(rlimitLib, 4096);
}

function copyRlimitFixtureWithNprocLimit(rlimitLib: string, limit: number): void {
  fs.writeFileSync(
    rlimitLib,
    fs
      .readFileSync(SANDBOX_RLIMITS, "utf-8")
      .replace(/^NEMOCLAW_SANDBOX_NPROC_LIMIT=512$/m, `NEMOCLAW_SANDBOX_NPROC_LIMIT=${limit}`),
  );
}

export function rlimitShim(rlimitLib: string): string {
  return `[ -f ${rlimitLib} ] && . ${rlimitLib} && harden_resource_limits --quiet && verify_resource_limits --quiet || true`;
}

type ProbeValues = Record<string, string | undefined>;

function parseProbeOutput(stdout: string): ProbeValues {
  return Object.fromEntries(
    stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line): [string, string] => {
        const [key, value = ""] = line.split("=", 2);
        return [key, value];
      }),
  ) as ProbeValues;
}

export function expectSystemRlimitHookEnforcesLimits(hookPath: string): void {
  const probe = [
    "set -euo pipefail",
    'source "$1"',
    'nproc_limit="$(builtin ulimit -u)"',
    'nofile_limit="$(builtin ulimit -n)"',
    "set +e",
    "(builtin ulimit -Su 5000) >/dev/null 2>&1",
    'raise_nproc="$?"',
    "(builtin ulimit -Sn 1048576) >/dev/null 2>&1",
    'raise_nofile="$?"',
    "set -e",
    'printf "nproc=%s\\n" "$nproc_limit"',
    'printf "nofile=%s\\n" "$nofile_limit"',
    'printf "raise_nproc=%s\\n" "$raise_nproc"',
    'printf "raise_nofile=%s\\n" "$raise_nofile"',
  ].join("\n");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-s", "--", hookPath], {
    encoding: "utf-8",
    input: probe,
    timeout: 5000,
  });

  expect(result.status, result.stderr).toBe(0);
  const values = parseProbeOutput(result.stdout);
  const nproc = Number(values.nproc);
  const nofile = Number(values.nofile);
  expect(Number.isInteger(nproc)).toBe(true);
  expect(nproc).toBeLessThanOrEqual(4096);
  expect(Number.isInteger(nofile)).toBe(true);
  expect(nofile).toBeLessThanOrEqual(65536);
  expect(Number(values.raise_nproc)).not.toBe(0);
  expect(Number(values.raise_nofile)).not.toBe(0);
}

export function expectSystemRlimitHookBypassesShadowedUlimit(hookPath: string): void {
  const probe = [
    "set -euo pipefail",
    "ulimit() {",
    '  case "$1:$#" in',
    "    -Su:2 | -Hu:2 | -Sn:2 | -Hn:2) return 0 ;;",
    "    -Su:1 | -Hu:1 | -Sn:1 | -Hn:1) printf '%s\\n' 999999; return 0 ;;",
    "  esac",
    "  return 0",
    "}",
    'source "$1"',
    'printf "shadow=%s\\n" "$(type -t ulimit)"',
    'printf "nproc=%s\\n" "$(builtin ulimit -u)"',
    'printf "nofile=%s\\n" "$(builtin ulimit -n)"',
  ].join("\n");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-s", "--", hookPath], {
    encoding: "utf-8",
    input: probe,
    timeout: 5000,
  });

  expect(result.status, result.stderr).toBe(0);
  const values = parseProbeOutput(result.stdout);
  expect(values.shadow).toBe("function");
  expect(Number(values.nproc)).toBeLessThanOrEqual(4096);
  expect(Number(values.nofile)).toBeLessThanOrEqual(65536);
}

export function expectSystemRlimitHookIsSilentWhenVerificationFails(
  hookPath: string,
  rlimitLib: string,
): void {
  fs.chmodSync(rlimitLib, 0o644);
  fs.writeFileSync(
    rlimitLib,
    [
      "harden_resource_limits() { :; }",
      "verify_resource_limits() {",
      '  if [ "${1:-}" != "--quiet" ]; then',
      '    echo "[SECURITY] noisy verification failure" >&2',
      "  fi",
      "  return 1",
      "}",
    ].join("\n"),
  );
  const probe = ["set -euo pipefail", 'source "$1"', 'printf "OK\\n"'].join("\n");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-s", "--", hookPath], {
    encoding: "utf-8",
    input: probe,
    timeout: 5000,
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toBe("OK\n");
  expect(result.stderr).toBe("");
}
