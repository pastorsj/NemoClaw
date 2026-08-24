// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const packageRoot = path.join(import.meta.dirname, "..", "..", "packages", "nemoclaw-openclaw");

export const openClawStartupShellFiles = [
  "runtime-state.sh",
  "model-routing.sh",
  "gateway-setup.sh",
  "startup-env.sh",
  "sandbox-setup.sh",
  "process-control.sh",
] as const;
export const openClawStartupFiles = ["auto-pair.py", ...openClawStartupShellFiles] as const;

export const openClawStartPath = path.join(packageRoot, "start.sh");
export const openClawAutoPairPath = path.join(packageRoot, "runtime", "auto-pair.py");

export function readOpenClawStartupSource(): string {
  const entrypoint = fs.readFileSync(openClawStartPath, "utf8");
  const moduleStart = entrypoint.indexOf("# startup-modules begin");
  const moduleEndMarker = "# startup-modules end";
  const moduleEnd = entrypoint.indexOf(moduleEndMarker, moduleStart);
  if (moduleStart < 0 || moduleEnd < moduleStart) {
    throw new Error("OpenClaw start.sh does not contain the startup module boundary.");
  }

  const modules = openClawStartupShellFiles
    .map((fileName) => fs.readFileSync(path.join(packageRoot, "runtime", fileName), "utf8"))
    .join("\n");
  return `${entrypoint.slice(0, moduleStart)}${modules}\n${entrypoint.slice(
    moduleEnd + moduleEndMarker.length,
  )}`;
}

export function readOpenClawModuleLoaderSource(): string {
  const entrypoint = fs.readFileSync(openClawStartPath, "utf8");
  const startMarker = "# startup-modules begin";
  const endMarker = "# startup-modules end";
  const start = entrypoint.indexOf(startMarker);
  const end = entrypoint.indexOf(endMarker, start);
  if (start < 0 || end < start) {
    throw new Error("OpenClaw start.sh does not contain the startup module loader.");
  }
  return entrypoint.slice(start, end + endMarker.length);
}

export function readOpenClawAutoPairSource(): string {
  return fs.readFileSync(openClawAutoPairPath, "utf8");
}

export function runOpenClawModuleLoaderFixture(
  targetFile = "",
  targetMode: "present" | "missing" | "symlink" | "unreadable" = "present",
) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-loader-"));
  const packageRoot = path.join(temporaryRoot, "packages", "nemoclaw-openclaw");
  const runtimeDir = path.join(packageRoot, "runtime");
  const entrypoint = path.join(packageRoot, "start.sh");
  fs.mkdirSync(runtimeDir, { recursive: true });
  for (const fileName of openClawStartupFiles) {
    fs.writeFileSync(
      path.join(runtimeDir, fileName),
      fileName.endsWith(".sh") ? ":\n" : "# fixture\n",
    );
  }
  const targetPath = targetFile ? path.join(runtimeDir, targetFile) : "";
  if (targetMode === "missing") fs.rmSync(targetPath);
  if (targetMode === "symlink") {
    fs.rmSync(targetPath);
    fs.symlinkSync(path.join(runtimeDir, "runtime-state.sh"), targetPath);
  }
  if (targetMode === "unreadable") fs.chmodSync(targetPath, 0o000);
  fs.writeFileSync(
    entrypoint,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      readOpenClawModuleLoaderSource(),
      "echo LOADED",
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    return spawnSync("bash", [entrypoint], { encoding: "utf8", timeout: 5000 });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function writeOpenClawStartupFixture(filePath: string): void {
  fs.writeFileSync(filePath, readOpenClawStartupSource(), { mode: 0o700 });
}
