// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shellQuote } from "../../src/lib/core/shell-quote";

const HERMES_PACKAGE_ROOT = path.join(
  import.meta.dirname,
  "..",
  "..",
  "packages",
  "nemoclaw-hermes",
);
export const hermesStartPath = path.join(HERMES_PACKAGE_ROOT, "start.sh");
export const hermesStartupModuleNames = [
  "state-gate",
  "config-setup",
  "service-control",
  "runtime-integrity",
  "gateway-control",
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function bashPrintfQ(value: string): string {
  const result = spawnSync("bash", ["-c", "printf '%q' \"$1\"", "bash-printf-q", value], {
    encoding: "utf-8",
    timeout: 5000,
    env: process.env,
  });
  if (result.status !== 0) throw new Error(`bash printf %q failed: ${result.stderr}`);
  return result.stdout;
}

export function extractShellFunction(source: string, name: string): string {
  const match = source.match(new RegExp(`${escapeRegExp(name)}\\(\\) \\{([\\s\\S]*?)^\\}`, "m"));
  if (!match) throw new Error(`Expected shell function ${name}`);
  return `${name}() {${match[1]}\n}`;
}

/** Read the package startup workflow with its package-owned modules inlined. */
export function readHermesStartupSource(startScript = hermesStartPath): string {
  let source = fs.readFileSync(startScript, "utf-8");
  for (const moduleName of hermesStartupModuleNames) {
    const begin = `# hermes-startup-module ${moduleName} begin`;
    const end = `# hermes-startup-module ${moduleName} end`;
    const beginIndex = source.indexOf(begin);
    const endIndex = source.indexOf(end, beginIndex);
    if (beginIndex < 0 || endIndex < 0) {
      throw new Error(`Hermes startup module marker is missing: ${moduleName}`);
    }
    const moduleSource = fs.readFileSync(
      path.join(HERMES_PACKAGE_ROOT, "runtime", `${moduleName}.sh`),
      "utf-8",
    );
    source =
      source.slice(0, beginIndex) + moduleSource.trimEnd() + source.slice(endIndex + end.length);
  }
  const resolverStart = source.indexOf("# Runtime modules hold the package-owned implementation.");
  const resolverEndMarker = "unset _HERMES_START_SOURCE _HERMES_START_DIR";
  const resolverEnd = source.indexOf(resolverEndMarker, resolverStart);
  if (resolverStart < 0 || resolverEnd < 0) {
    throw new Error("Hermes startup module resolver is missing");
  }
  source =
    source.slice(0, resolverStart) +
    source.slice(resolverEnd + resolverEndMarker.length).replace(/^\n+/, "");
  return source;
}

function readHermesModuleLoaderSource(): string {
  const source = fs.readFileSync(hermesStartPath, "utf8");
  const resolverStart = source.indexOf("# Runtime modules hold the package-owned implementation.");
  const resolverEndMarker = "unset _HERMES_START_SOURCE _HERMES_START_DIR";
  const resolverEnd = source.indexOf(resolverEndMarker, resolverStart);
  assert(resolverStart >= 0 && resolverEnd > resolverStart, "Hermes module resolver is missing");

  const moduleLoaders = hermesStartupModuleNames.map((moduleName) => {
    const beginMarker = `# hermes-startup-module ${moduleName} begin`;
    const endMarker = `# hermes-startup-module ${moduleName} end`;
    const begin = source.indexOf(beginMarker);
    const end = source.indexOf(endMarker, begin);
    assert(begin >= 0 && end > begin, `Hermes ${moduleName} loader is missing`);
    return source.slice(begin, end + endMarker.length);
  });
  const gatewayEndMarker = "# hermes-startup-module gateway-control end";
  const gatewayEnd = source.indexOf(gatewayEndMarker, resolverEnd);
  const mainStart = source.indexOf("# ── Main", gatewayEnd);
  assert(gatewayEnd > resolverEnd && mainStart > gatewayEnd, "Hermes module loader is incomplete");
  return [
    source.slice(resolverStart, resolverEnd + resolverEndMarker.length),
    ...moduleLoaders,
    source.slice(gatewayEnd + gatewayEndMarker.length, mainStart),
  ].join("\n");
}

export function runHermesStartupLoader(targetMode: "present" | "missing" | "symlink" = "present") {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-loader-"));
  const runtimeDir = path.join(temporaryRoot, "hermes-startup");
  const runner = path.join(temporaryRoot, "run.sh");
  fs.mkdirSync(runtimeDir);
  for (const moduleName of hermesStartupModuleNames) {
    fs.writeFileSync(path.join(runtimeDir, `${moduleName}.sh`), ":\n");
  }
  const targetPath = path.join(runtimeDir, "service-control.sh");
  if (targetMode === "missing") fs.rmSync(targetPath);
  if (targetMode === "symlink") {
    fs.rmSync(targetPath);
    fs.symlinkSync(path.join(runtimeDir, "config-setup.sh"), targetPath);
  }
  const loader = readHermesModuleLoaderSource().replace(
    "/usr/local/lib/nemoclaw/hermes-startup",
    runtimeDir,
  );
  fs.writeFileSync(
    runner,
    ["#!/usr/bin/env bash", "set -euo pipefail", loader, "echo LOADED"].join("\n"),
    { mode: 0o700 },
  );

  try {
    return spawnSync("bash", [runner], { encoding: "utf8", timeout: 5000 });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function runHermesEntrypointWrapperFallback(envWrapper: string) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-wrapper-"));
  const entrypointPath = path.join(temporaryRoot, "packages", "nemoclaw-hermes", "start.sh");
  const wrapperPath = path.join(temporaryRoot, "scripts", "lib", "entrypoint-env-wrapper.sh");
  const runnerPath = path.join(temporaryRoot, "run.sh");
  const source = fs.readFileSync(hermesStartPath, "utf8");
  const begin = source.indexOf("# managed-entrypoint-env-wrapper begin");
  const endMarker = "# managed-entrypoint-env-wrapper end";
  const end = source.indexOf(endMarker, begin);
  assert(begin >= 0 && end > begin, "Hermes entrypoint wrapper block is missing");

  fs.mkdirSync(path.dirname(entrypointPath), { recursive: true });
  fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
  fs.copyFileSync(envWrapper, wrapperPath);
  fs.writeFileSync(
    entrypointPath,
    source
      .slice(begin, end + endMarker.length)
      .replace(
        "/usr/local/lib/nemoclaw/entrypoint-env-wrapper.sh",
        path.join(temporaryRoot, "missing-wrapper.sh"),
      ),
  );
  fs.writeFileSync(
    runnerPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `source ${bashPrintfQ(entrypointPath)}`,
      'printf "WRAPPER_FALLBACK_OK\\n"',
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    return spawnSync("bash", [runnerPath], {
      encoding: "utf8",
      timeout: 5000,
      env: { PATH: process.env.PATH ?? "" },
    });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function runHermesBashHarness(
  lines: string[],
  configure?: (tmpDir: string) => Record<string, string>,
) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-supervisor-test-"));
  const script = path.join(tmpDir, "run.sh");
  fs.writeFileSync(
    script,
    [
      "#!/usr/bin/env bash",
      "set -uo pipefail",
      "HERMES_MCP_RECONCILE_PENDING=0",
      "HERMES_MCP_INTEGRITY_FAILED=0",
      ...lines,
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    return spawnSync("bash", [script], {
      encoding: "utf-8",
      timeout: 5000,
      env: { ...process.env, ...configure?.(tmpDir) },
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function runHermesSandboxInitPreludeWithFakePath(
  startScript: string,
  envWrapper: string,
  temporaryRoot = os.tmpdir(),
) {
  const tmpDir = fs.mkdtempSync(path.join(temporaryRoot, "nemoclaw-hermes-init-path-"));
  try {
    const fakeBin = path.join(tmpDir, "bin");
    const fakeInit = path.join(tmpDir, "sandbox-init.sh");
    const fakeSupervisor = path.join(tmpDir, "gateway-supervisor.sh");
    const fakeGatePython = path.join(tmpDir, "gate-python");
    const fakeGateHelper = path.join(tmpDir, "runtime-state-mutation-startup-gate.py");
    const fakeSetpriv = path.join(tmpDir, "setpriv");
    const marker = path.join(tmpDir, "dirname-called");
    const sourcePathLog = path.join(tmpDir, "source-path.log");
    const scriptPath = path.join(tmpDir, "run.sh");
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "dirname"),
      ["#!/usr/bin/env bash", `printf called > ${shellQuote(marker)}`, "exit 99"].join("\n"),
      { mode: 0o700 },
    );
    fs.writeFileSync(
      fakeInit,
      [
        `printf "%s\\n" "$PATH" > ${shellQuote(sourcePathLog)}`,
        "harden_resource_limits() { :; }",
      ].join("\n"),
    );
    fs.writeFileSync(fakeSupervisor, "# supervisor fixture\n");
    fs.writeFileSync(fakeGatePython, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
    fs.writeFileSync(fakeGateHelper, "# startup gate fixture\n");
    fs.writeFileSync(
      fakeSetpriv,
      [
        "#!/usr/bin/env bash",
        'while [ "$#" -gt 0 ]; do',
        '  if [ "$1" = "--" ]; then shift; break; fi',
        "  shift",
        "done",
        'exec "$@"',
      ].join("\n"),
      { mode: 0o700 },
    );

    const rawSource = fs.readFileSync(startScript, "utf-8");
    const rawStart = rawSource.indexOf(
      "# SECURITY: Lock down PATH before resolving or sourcing root startup helpers.",
    );
    const rawEnd = rawSource.indexOf("\nif [ -d /opt/hermes/hermes_cli/web_dist ];", rawStart);
    assert(rawStart >= 0 && rawEnd >= 0, "Hermes start.sh prelude markers not found");
    const src = readHermesStartupSource(startScript);
    const start = src.indexOf(
      "# SECURITY: Lock down PATH before resolving or sourcing root startup helpers.",
    );
    const end = src.indexOf("\nif [ -d /opt/hermes/hermes_cli/web_dist ];", start);
    const prelude = src
      .slice(start, end)
      .replaceAll("/opt/hermes/.venv/bin/python3", fakeGatePython)
      .replaceAll("/usr/local/lib/nemoclaw/runtime-state-mutation-startup-gate.py", fakeGateHelper)
      .replaceAll("/usr/bin/setpriv", fakeSetpriv)
      .replaceAll("/usr/local/lib/nemoclaw/entrypoint-env-wrapper.sh", envWrapper)
      .replaceAll("/usr/local/lib/nemoclaw/sandbox-init.sh", fakeInit)
      .replaceAll("/usr/local/lib/nemoclaw/gateway-supervisor.sh", fakeSupervisor);

    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `export PATH=${shellQuote(`${fakeBin}:${process.env.PATH ?? ""}`)}`,
        prelude,
      ].join("\n"),
      { mode: 0o700 },
    );

    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: process.env,
    });
    return {
      result,
      dirnameCalled: fs.existsSync(marker),
      sourcePath: fs.existsSync(sourcePathLog)
        ? fs.readFileSync(sourcePathLog, "utf-8").trim()
        : "",
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
