// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildGatewayGuardRecoveryLines, GATEWAY_PRELOAD_GUARDS } from "./recovery-preload";

const [SAFETY_NET_GUARD, CIAO_GUARD] = GATEWAY_PRELOAD_GUARDS;

function writeStub(dir: string, name: string, body: string): string {
  const stub = path.join(dir, name);
  fs.writeFileSync(stub, `#!/usr/bin/env sh\n${body}\n`, { mode: 0o755 });
  return stub;
}

function makeRecoveryHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-recovery-preload-"));
  const sourceDir = path.join(root, "usr-local-lib-nemoclaw-preloads");
  const workDir = path.join(root, "tmp");
  const stubsDir = path.join(root, "bin");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(stubsDir, { recursive: true });

  const paths = {
    root,
    stubsDir,
    sourceSafetyNet: path.join(sourceDir, "sandbox-safety-net.js"),
    sourceCiao: path.join(sourceDir, "ciao-network-guard.js"),
    tmpSafetyNet: path.join(workDir, "nemoclaw-sandbox-safety-net.js"),
    tmpCiao: path.join(workDir, "nemoclaw-ciao-network-guard.js"),
    proxyEnv: path.join(workDir, "nemoclaw-proxy-env.sh"),
    recoverySourceEnv: path.join(workDir, "nemoclaw-recovered-proxy-env.sh"),
    gatewayLog: path.join(workDir, "gateway.log"),
    hostileMarker: path.join(root, "hostile-proxy-env-sourced"),
  };

  fs.writeFileSync(paths.sourceSafetyNet, "module.exports = 'trusted safety net';\n", {
    mode: 0o644,
  });
  fs.writeFileSync(paths.sourceCiao, "module.exports = 'trusted ciao guard';\n", {
    mode: 0o644,
  });

  return paths;
}

export type RecoveryHarnessPaths = ReturnType<typeof makeRecoveryHarness>;

function rewriteRuntimePaths(script: string, paths: RecoveryHarnessPaths): string {
  return script
    .replaceAll(SAFETY_NET_GUARD.tmpPath, paths.tmpSafetyNet)
    .replaceAll(SAFETY_NET_GUARD.sourcePath, paths.sourceSafetyNet)
    .replaceAll(CIAO_GUARD.tmpPath, paths.tmpCiao)
    .replaceAll(CIAO_GUARD.sourcePath, paths.sourceCiao)
    .replaceAll("/tmp/nemoclaw-proxy-env.sh", paths.proxyEnv)
    .replaceAll("/tmp/nemoclaw-recovered-proxy-env.sh", paths.recoverySourceEnv);
}

function installFakeRootStubs(paths: RecoveryHarnessPaths): void {
  writeStub(
    paths.stubsDir,
    "id",
    '[ "$1" = "-u" ] && { printf "0\\n"; exit 0; }\n/usr/bin/id "$@"',
  );
  writeStub(paths.stubsDir, "chown", "exit 0");
  writeStub(
    paths.stubsDir,
    "stat",
    '[ "$1" = "-c" ] && [ "$2" = "%u" ] && { printf "0\\n"; exit 0; }\n/usr/bin/stat "$@"',
  );
}

function readTextIfPresent(pathname: string): string | null {
  try {
    return fs.readFileSync(pathname, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") return null;
    throw error;
  }
}

function readModeIfPresent(pathname: string): number | null {
  try {
    return fs.statSync(pathname).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function readSymlinkStateIfPresent(pathname: string): boolean | null {
  try {
    return fs.lstatSync(pathname).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function runGuardRecovery(options: {
  proxyEnvContent?: string | ((paths: RecoveryHarnessPaths) => string);
  beforeScript?: (paths: RecoveryHarnessPaths) => void;
  fakeRoot?: boolean;
  shell?: "bash" | "sh";
}) {
  const paths = makeRecoveryHarness();
  if (options.fakeRoot) installFakeRootStubs(paths);
  options.beforeScript?.(paths);

  const rawProxyEnvContent =
    typeof options.proxyEnvContent === "function"
      ? options.proxyEnvContent(paths)
      : options.proxyEnvContent;
  const proxyEnvContent = rawProxyEnvContent
    ? rewriteRuntimePaths(rawProxyEnvContent, paths)
    : undefined;
  const writeProxyEnv = proxyEnvContent
    ? [
        `cat > ${JSON.stringify(paths.proxyEnv)} <<'PROXYENV'`,
        proxyEnvContent,
        "PROXYENV",
        `chmod 444 ${JSON.stringify(paths.proxyEnv)}`,
      ]
    : [];

  const recoveryLines = rewriteRuntimePaths(buildGatewayGuardRecoveryLines().join("\n"), paths);
  const script = [
    "set -u",
    `export _GATEWAY_LOG=${JSON.stringify(paths.gatewayLog)}`,
    ': > "$_GATEWAY_LOG"',
    ...writeProxyEnv,
    recoveryLines,
    'if [ "$_GUARDS_MISSING" = "1" ]; then echo GUARDS_MISSING; exit 17; fi',
    'printf "PE_MISSING=%s\\n" "$_PE_MISSING"',
    'printf "NODE_OPTIONS=%s\\n" "$NODE_OPTIONS"',
  ].join("\n");

  try {
    const result = spawnSync(options.shell ?? "sh", ["-c", script], {
      encoding: "utf-8",
      timeout: 10000,
      env: {
        PATH: `${paths.stubsDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        HOME: paths.root,
      },
    });
    return {
      ...result,
      paths,
      files: {
        gatewayLog: readTextIfPresent(paths.gatewayLog) ?? "",
        proxyEnv: readTextIfPresent(paths.proxyEnv),
        recoverySourceEnv: readTextIfPresent(paths.recoverySourceEnv),
        tmpSafetyNet: readTextIfPresent(paths.tmpSafetyNet),
        tmpCiao: readTextIfPresent(paths.tmpCiao),
        tmpSafetyNetMode: readModeIfPresent(paths.tmpSafetyNet),
        tmpCiaoMode: readModeIfPresent(paths.tmpCiao),
        proxyEnvMode: readModeIfPresent(paths.proxyEnv),
        tmpSafetyNetIsSymlink: readSymlinkStateIfPresent(paths.tmpSafetyNet),
        proxyEnvIsSymlink: readSymlinkStateIfPresent(paths.proxyEnv),
        hostileProxyEnvSourced: fs.existsSync(paths.hostileMarker),
      },
    };
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
}
