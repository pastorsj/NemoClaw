// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import {
  CURRENT_REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSION,
  dockerRunCommandBetween,
  runDockerfilePatchBlock,
  runFetchGuardPatchBlock,
} from "./fetch-guard";

export const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
export const REPOSITORY_ROOT = path.resolve(PACKAGE_ROOT, "../..");
export const DOCKERFILE = path.join(PACKAGE_ROOT, "Dockerfile");
export const DOCKERFILE_BASE = path.join(PACKAGE_ROOT, "Dockerfile.base");
export const OPENCLAW_MANIFEST = path.join(PACKAGE_ROOT, "manifest.yaml");
export const BLUEPRINT = path.join(REPOSITORY_ROOT, "nemoclaw-blueprint", "blueprint.yaml");
export const REVIEWED_NPM_AUDIT_HELPER = path.join(
  REPOSITORY_ROOT,
  "scripts",
  "lib",
  "reviewed-npm-audit.mts",
);
export const REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSIONS = [
  "2026.4.24",
  "2026.5.18",
  "2026.5.22",
  "2026.5.27",
  "2026.7.1",
] as const;
export const EXPECTED_OPENCLAW_INTEGRITY =
  "sha512-ge/Xss99CHAjPL/ikmH/UFoiOrjcxDB4sW3y9mhyCD+dYW3wzV7TKbAVdkrXFgAG2d2BjpJofP97zUZ+umxo8g==";
export const REVIEWED_OPENCLAW_2026_7_1_WEB_FETCH_SHAPE = [
  "async function fetchWithWebToolsNetworkGuard(params) {",
  "  const { timeoutSeconds, useEnvProxy, ...rest } = params;",
  "  const resolved = {",
  "    ...rest,",
  "    timeoutMs: resolveTimeoutMs({",
  "      timeoutMs: rest.timeoutMs,",
  "      timeoutSeconds",
  "    })",
  "  };",
  "  return fetchWithSsrFGuard(useEnvProxy ? withTrustedEnvProxyGuardedFetchMode(resolved) : withStrictGuardedFetchMode(resolved));",
  "}",
].join("\n");
export const REVIEWED_OPENCLAW_2026_7_1_MANAGED_PROXY_SHAPE =
  "const isStrictManagedProxyActive = mode === GUARDED_FETCH_MODE.STRICT && isManagedProxyActive();";
export function readRequiredMatch(file: string, pattern: RegExp, description: string): string {
  const match = fs.readFileSync(file, "utf-8").match(pattern);
  if (!match?.[1]) {
    throw new Error(`Expected ${description} in ${path.basename(file)}`);
  }
  return match[1];
}

export function compareDotVersions(left: string, right: string): number {
  const lhs = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rhs = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(lhs.length, rhs.length);
  for (let index = 0; index < length; index += 1) {
    const a = lhs[index] ?? 0;
    const b = rhs[index] ?? 0;
    if (a !== b) return a - b;
  }
  return 0;
}

export function expectVersionAtLeast(actual: string, minimum: string, message: string) {
  expect(compareDotVersions(actual, minimum), message).toBeGreaterThanOrEqual(0);
}

export function readBlueprintMinOpenClawVersion(): string {
  return readRequiredMatch(BLUEPRINT, /min_openclaw_version:\s*"([^"]+)"/, "OpenClaw minimum");
}

export function readDockerfileBaseOpenClawVersion(): string {
  return readRequiredMatch(
    DOCKERFILE_BASE,
    /^ARG OPENCLAW_VERSION=([^\s]+)/m,
    "OpenClaw base image version",
  );
}

export function readDockerfileOpenClawVersion(): string {
  return readRequiredMatch(
    DOCKERFILE,
    /^ARG OPENCLAW_VERSION=([^\s]+)/m,
    "OpenClaw runtime version",
  );
}

export function readDockerfileMcporterVersions(): { runtime: string; base: string } {
  const pattern = /^ARG MCPORTER_VERSION=([^\s]+)/m;
  return {
    runtime: readRequiredMatch(DOCKERFILE, pattern, "mcporter runtime version"),
    base: readRequiredMatch(DOCKERFILE_BASE, pattern, "mcporter base image version"),
  };
}

export function readDockerfileMcporterVersion(): string {
  const versions = readDockerfileMcporterVersions();
  expect(versions.base, "mcporter base image version").toBe(versions.runtime);
  return versions.runtime;
}

export function readDockerfileMcporterIntegrity(): string {
  const pattern = /^ARG MCPORTER_0_7_3_INTEGRITY=([^\s]+)/m;
  const runtime = readRequiredMatch(DOCKERFILE, pattern, "mcporter runtime integrity");
  const base = readRequiredMatch(DOCKERFILE_BASE, pattern, "mcporter base image integrity");
  expect(base, "mcporter base image integrity").toBe(runtime);
  return runtime;
}

export function readDockerfileBaseOpenClawIntegrity(): string {
  return readRequiredMatch(
    DOCKERFILE_BASE,
    /^ARG OPENCLAW_2026_7_1_INTEGRITY=([^\s]+)/m,
    "OpenClaw base image integrity",
  );
}

export function readDockerfileOpenClawIntegrity(): string {
  return readRequiredMatch(
    DOCKERFILE,
    /^ARG OPENCLAW_2026_7_1_INTEGRITY=([^\s]+)/m,
    "OpenClaw runtime integrity",
  );
}

export function readDockerfileOpenClawTarball(): string {
  return readRequiredMatch(
    DOCKERFILE,
    /^ARG OPENCLAW_2026_7_1_TARBALL=([^\s]+)/m,
    "OpenClaw runtime tarball",
  );
}

export function runOpenClawUpgradeBlock(currentVersion: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-upgrade-"));
  const manifest = path.join(tmp, "manifest.yaml");
  const log = path.join(tmp, "calls.log");
  const openclawInstall = path.join(tmp, "openclaw-global");
  const openclawRuntime = path.join(tmp, "openclaw-runtime");
  const openclawShim = path.join(tmp, "openclaw-bin");
  const mcporterInstall = path.join(tmp, "mcporter-runtime");
  const mcporterShim = path.join(tmp, "mcporter-bin");
  const auditExceptions = path.join(tmp, "npm-audit-exceptions.json");
  const openclawVersion = readDockerfileOpenClawVersion();
  const reviewedArchiveDir = path.join(tmp, "reviewed-pack");
  const reviewedArchive = path.join(reviewedArchiveDir, `openclaw-${openclawVersion}.tgz`);
  const expectedMcporterVersion = readDockerfileMcporterVersion();
  const openclawIntegrity = readDockerfileOpenClawIntegrity();
  const openclawTarball = readDockerfileOpenClawTarball();
  const mcporterIntegrity = readDockerfileMcporterIntegrity();
  const mcporterTarball = readRequiredMatch(
    DOCKERFILE,
    /^ARG MCPORTER_0_7_3_TARBALL=([^\s]+)/m,
    "mcporter runtime tarball",
  );
  fs.copyFileSync(OPENCLAW_MANIFEST, manifest);
  fs.mkdirSync(openclawInstall, { recursive: true });
  fs.mkdirSync(openclawRuntime, { recursive: true });
  fs.mkdirSync(mcporterInstall, { recursive: true });
  fs.mkdirSync(reviewedArchiveDir);
  fs.writeFileSync(path.join(mcporterInstall, "package-lock.json"), "{}");
  fs.copyFileSync(
    path.join(PACKAGE_ROOT, "runtime", "openclaw", "npm-shrinkwrap.json"),
    path.join(openclawRuntime, "package-lock.json"),
  );
  fs.writeFileSync(openclawShim, "");
  fs.writeFileSync(mcporterShim, "");
  fs.writeFileSync(auditExceptions, '{"schemaVersion":1,"exceptions":[]}\n');
  fs.writeFileSync(reviewedArchive, "fake reviewed OpenClaw archive");
  const command = dockerRunCommandBetween(
    "# OPENCLAW_VERSION is the NemoClaw runtime build target",
    "# Patch OpenClaw media fetch",
  )
    .replaceAll("/packages/nemoclaw-openclaw/manifest.yaml", manifest)
    .replaceAll("/usr/local/lib/node_modules/openclaw", openclawInstall)
    .replaceAll(
      "mkdir -p /usr/local/lib/node_modules",
      `mkdir -p ${JSON.stringify(path.dirname(openclawInstall))}`,
    )
    .replaceAll("/usr/local/lib/nemoclaw/openclaw-runtime", openclawRuntime)
    .replaceAll("/usr/local/bin/openclaw", openclawShim)
    .replaceAll("/usr/local/lib/node_modules/mcporter", mcporterInstall)
    .replaceAll("/usr/local/lib/nemoclaw/mcporter-runtime", mcporterInstall)
    .replaceAll("/usr/local/bin/mcporter", mcporterShim)
    .replaceAll(
      'from "/scripts/lib/reviewed-npm-audit.mts"',
      `from ${JSON.stringify(REVIEWED_NPM_AUDIT_HELPER)}`,
    )
    .replaceAll("/scripts/npm-audit-exceptions.json", auditExceptions);
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `call_log=${JSON.stringify(log)}`,
    `real_node=${JSON.stringify(process.execPath)}`,
    `audit_exceptions=${JSON.stringify(auditExceptions)}`,
    `mcporter_install=${JSON.stringify(mcporterInstall)}`,
    `postinstall_path=${JSON.stringify(path.join(openclawRuntime, "node_modules/openclaw/scripts/postinstall-bundled-plugins.mjs"))}`,
    `reviewed_archive=${JSON.stringify(reviewedArchive)}`,
    `OPENCLAW_VERSION=${JSON.stringify(openclawVersion)}`,
    `BASE_IMAGE=${JSON.stringify("registry.example/nemoclaw-test-base:latest")}`,
    `MCPORTER_VERSION=${JSON.stringify(expectedMcporterVersion)}`,
    `OPENCLAW_2026_7_1_INTEGRITY=${JSON.stringify(openclawIntegrity)}`,
    `OPENCLAW_2026_7_1_TARBALL=${JSON.stringify(openclawTarball)}`,
    `MCPORTER_0_7_3_INTEGRITY=${JSON.stringify(mcporterIntegrity)}`,
    `MCPORTER_0_7_3_TARBALL=${JSON.stringify(mcporterTarball)}`,
    "node() {",
    '  if [ "${1:-}" = "$postinstall_path" ]; then printf "node %s\\n" "$*" >> "$call_log"; return 0; fi',
    '  if [ "${1:-}" = "--input-type=module" ] && [ "${2:-}" = "-e" ] && printf "%s\\n" "${3:-}" | grep -q "StreamableHTTPServerTransport"; then printf "node %s\\n" "$*" >> "$call_log"; return 0; fi',
    '  if [ "${2:-}" = "/scripts/lib/reviewed-npm-audit.mts" ]; then',
    '    [ "$#" -eq 10 ] && [ "${1:-}" = "--experimental-strip-types" ] || return 87;',
    '    [ "${3:-}" = "--directory" ] && [ "${4:-}" = "$mcporter_install" ] || return 88;',
    '    [ "${5:-}" = "--exceptions" ] && [ "${6:-}" = "$audit_exceptions" ] || return 89;',
    '    [ "${7:-}" = "--graph" ] && [ "${8:-}" = "mcporter-runtime" ] || return 90;',
    '    [ "${9:-}" = "--threshold" ] && [ "${10:-}" = "high" ] || return 99;',
    '    printf "node %s\\n" "$*" >> "$call_log"; return 0;',
    "  fi",
    '  if [ "${2:-}" = "/scripts/lib/reviewed-npm-archive.mts" ]; then',
    '    if [ "${3:-}" = "--verify-lock" ] || [ "${3:-}" = "--verify-installed-lock" ]; then return 0; fi',
    '    if [ "${3:-}" = "--verify-only" ]; then',
    '      [ "$#" -eq 11 ] && [ "${4:-}" = "--package-spec" ] && [ "${5:-}" = "mcporter@${MCPORTER_VERSION}" ] || return 91;',
    '      [ "${6:-}" = "--integrity" ] && [ "${7:-}" = "$MCPORTER_0_7_3_INTEGRITY" ] || return 92;',
    '      [ "${8:-}" = "--tarball-url" ] && [ "${9:-}" = "$MCPORTER_0_7_3_TARBALL" ] || return 93;',
    '      [ "${10:-}" = "--label" ] && [ "${11:-}" = "mcporter ${MCPORTER_VERSION}" ] || return 94;',
    "      return 0;",
    "    fi",
    '    [ "$#" -eq 10 ] && [ "${3:-}" = "--package-spec" ] && [ "${4:-}" = "openclaw@${OPENCLAW_VERSION}" ] || return 95;',
    '    [ "${5:-}" = "--integrity" ] && [ "${6:-}" = "$OPENCLAW_2026_7_1_INTEGRITY" ] || return 96;',
    '    [ "${7:-}" = "--tarball-url" ] && [ "${8:-}" = "$OPENCLAW_2026_7_1_TARBALL" ] || return 97;',
    '    [ "${9:-}" = "--label" ] && [ "${10:-}" = "OpenClaw ${OPENCLAW_VERSION}" ] || return 98;',
    '    printf "npm pack %s --pack-destination reviewed-temp\\n" "${8:-}" >> "$call_log";',
    '    printf "%s\\n" "$reviewed_archive"; return 0;',
    "  fi",
    '  "$real_node" "$@"',
    "}",
    `openclaw() { if [ "\${1:-}" = "--version" ]; then printf 'openclaw ${currentVersion}\\n'; else return 127; fi; }`,
    `mcporter() { if [ "\${1:-}" = "--version" ]; then printf '${expectedMcporterVersion}\\n'; else return 127; fi; }`,
    "npm() {",
    '  printf "npm %s\\n" "$*" >> "$call_log";',
    '  if [ "${1:-}" = "view" ] && [ "${2:-}" = "openclaw@${OPENCLAW_VERSION}" ] && [ "${3:-}" = "dist.integrity" ]; then',
    '    printf "%s\\n" "$OPENCLAW_2026_7_1_INTEGRITY";',
    "    return 0",
    "  fi",
    '  if [ "${1:-}" = "view" ] && [ "${2:-}" = "mcporter@${MCPORTER_VERSION}" ] && [ "${3:-}" = "dist.integrity" ]; then',
    '    printf "%s\\n" "$MCPORTER_0_7_3_INTEGRITY";',
    "    return 0",
    "  fi",
    '  if [ "${1:-}" = "view" ] && [ "${2:-}" = "openclaw@${OPENCLAW_VERSION}" ] && [ "${3:-}" = "dist.tarball" ]; then',
    '    printf "%s\\n" "$OPENCLAW_2026_7_1_TARBALL";',
    "    return 0",
    "  fi",
    '  if [ "${1:-}" = "pack" ]; then',
    '    pack_dir="";',
    '    while [ "$#" -gt 0 ]; do',
    '      if [ "${1:-}" = "--pack-destination" ]; then pack_dir="${2:-}"; shift 2; continue; fi',
    "      shift",
    "    done",
    '    test -n "$pack_dir";',
    '    pack_file="openclaw-${OPENCLAW_VERSION}.tgz";',
    '    printf "fake openclaw tarball" > "$pack_dir/$pack_file";',
    '    printf \'[{"filename":"%s","integrity":"%s"}]\\n\' "$pack_file" "$OPENCLAW_2026_7_1_INTEGRITY";',
    "    return 0",
    "  fi",
    '  if [ "${1:-}" = "install" ]; then return 0; fi',
    '  if [ "${1:-}" = "--prefix" ]; then return 0; fi',
    "  return 1",
    "}",
    'command() { if [ "${1:-}" = "-v" ] && [ "${2:-}" = "codex-acp" ]; then return 0; fi; builtin command "$@"; }',
    command,
  ].join("\n");
  const scriptPath = path.join(tmp, "run.sh");
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 10000 });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf-8") : "";
  fs.rmSync(tmp, { recursive: true, force: true });
  return { result, calls };
}

export function webGuardedFetchFixtureSource(): string {
  return [
    "const withStrictGuardedFetchMode = (params) => ({ ...params, mode: 'strict' });",
    "const withTrustedEnvProxyGuardedFetchMode = (params) => ({ ...params, mode: 'trusted_env_proxy' });",
    "globalThis.hostnameChecks = [];",
    "function normalizeHostname(value) { return String(value || '').toLowerCase().replace(/\\.+$/, ''); }",
    "function resolveHostnamePolicyChecks(hostname, policy) {",
    "  const normalized = normalizeHostname(hostname);",
    "  globalThis.hostnameChecks.push({ normalized, policy });",
    "  const allowedHostnames = new Set((policy?.allowedHostnames ?? []).map(normalizeHostname));",
    "  if (normalized === 'host.openshell.internal' && allowedHostnames.has(normalized)) return { normalized, skipPrivateNetworkChecks: true };",
    "  if (normalized === 'host.openshell.internal' || normalized.endsWith('.internal') || normalized === '169.254.169.254' || normalized === '10.0.0.1') throw new Error('blocked ' + normalized);",
    "  return { normalized, skipPrivateNetworkChecks: false };",
    "}",
    "function assertHostnameAllowedWithPolicy(hostname, policy) { return resolveHostnamePolicyChecks(hostname, policy).normalized; }",
    "async function resolvePinnedHostnameWithPolicy(hostname, params = {}) { return { hostname: resolveHostnamePolicyChecks(hostname, params.policy).normalized }; }",
    "async function fetchWithSsrFGuard(params) {",
    "  const parsed = new URL(params.url);",
    "  if (params.mode === 'trusted_env_proxy') return { hostname: assertHostnameAllowedWithPolicy(parsed.hostname, params.policy), mode: params.mode, policy: params.policy };",
    "  return { hostname: (await resolvePinnedHostnameWithPolicy(parsed.hostname, { policy: params.policy })).hostname, mode: params.mode, policy: params.policy };",
    "}",
    "async function fetchWithWebToolsNetworkGuard(params) {",
    "  const { timeoutSeconds, useEnvProxy, ...rest } = params;",
    "  const resolved = { ...rest, timeoutMs: rest.timeoutMs ?? timeoutSeconds * 1000 };",
    "  return fetchWithSsrFGuard(useEnvProxy ? withTrustedEnvProxyGuardedFetchMode(resolved) : withStrictGuardedFetchMode(resolved));",
    "}",
    "globalThis.assertHostnameAllowedWithPolicy = assertHostnameAllowedWithPolicy;",
    "globalThis.fetchWithWebToolsNetworkGuard = fetchWithWebToolsNetworkGuard;",
    "export { withStrictGuardedFetchMode as a, withTrustedEnvProxyGuardedFetchMode as b, fetchWithWebToolsNetworkGuard as c };",
    "",
  ].join("\n");
}

export {
  CURRENT_REVIEWED_OPENCLAW_PATCH_CLASSIFIER_VERSION,
  dockerRunCommandBetween,
  runDockerfilePatchBlock,
  runFetchGuardPatchBlock,
};
