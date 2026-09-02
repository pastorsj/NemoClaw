// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import type { AgentConfigTarget } from "../sandbox/agent-config";

const dockerExec: typeof import("../adapters/docker/exec") = require("../adapters/docker/exec");
const privilegedExecModule: typeof import("../sandbox/privileged-exec") = require("../sandbox/privileged-exec");

const MUTABLE_CONFIG_NORMALIZER = "/usr/local/lib/nemoclaw/normalize_mutable_config_perms.py";
const MUTABLE_CONFIG_NORMALIZER_HOST_TIMEOUT_MS = 25000;
const MUTABLE_CONFIG_NORMALIZER_WATCHDOG = [
  "/usr/bin/timeout",
  "--signal=TERM",
  "--kill-after=5s",
  "15s",
] as const;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

type MutableProtectedFileMode = "600" | "660";

function directProtectedFileName(configDir: string, filePath: string): string {
  const relative = path.posix.relative(configDir, filePath);
  if (
    !relative ||
    path.posix.isAbsolute(relative) ||
    path.posix.basename(relative) !== relative ||
    relative === "." ||
    relative === ".." ||
    relative.includes("\\") ||
    CONTROL_CHAR_RE.test(relative)
  ) {
    throw new Error(`Mutable config protected file '${filePath}' must be a direct canonical file`);
  }
  return relative;
}

function mutableProtectedFileModes(
  target: AgentConfigTarget,
): Array<readonly [string, MutableProtectedFileMode]> {
  const entries: Array<readonly [string, MutableProtectedFileMode]> = [
    [directProtectedFileName(target.configDir, target.configPath), "660"],
  ];
  for (const sensitivePath of target.sensitiveFiles || []) {
    const name = directProtectedFileName(target.configDir, sensitivePath);
    entries.push([name, name === ".config-hash" ? "660" : "600"]);
  }
  const names = new Set<string>();
  for (const [name] of entries) {
    if (names.has(name)) {
      throw new Error(`Mutable config protected file '${name}' is declared more than once`);
    }
    names.add(name);
  }
  return entries;
}

function runPrivileged(sandboxName: string, cmd: string[], timeout = 15000): void {
  privilegedExecModule.withPrivilegedSandboxExecutionLease(
    sandboxName,
    "mutable config permission repair",
    () => {
      dockerExec.dockerExecFileSync(
        privilegedExecModule.privilegedSandboxExecArgv(sandboxName, cmd, false, true),
        {
          stdio: ["ignore", "pipe", "pipe"],
          timeout,
        },
      );
    },
  );
}

function privilegedExecCapture(sandboxName: string, cmd: string[], timeout = 15000): string {
  return privilegedExecModule.withPrivilegedSandboxExecutionLease(
    sandboxName,
    "mutable config identity lookup",
    () =>
      dockerExec
        .dockerExecFileSync(
          privilegedExecModule.privilegedSandboxExecArgv(sandboxName, cmd, false, true),
          {
            stdio: ["ignore", "pipe", "pipe"],
            timeout,
          },
        )
        .trim(),
  );
}

function sandboxIdentityId(sandboxName: string, flag: "-u" | "-g"): string {
  const id = privilegedExecCapture(sandboxName, ["/usr/bin/id", flag, "sandbox"]);
  // Keep the ownership target non-root so privileged repair cannot become a
  // confused-deputy path.
  if (!/^[1-9][0-9]*$/.test(id)) {
    const kind = flag === "-u" ? "UID" : "GID";
    throw new Error(`sandbox identity lookup returned an invalid ${kind}`);
  }
  return id;
}

/** Apply the mutable OpenClaw contract through the image's trusted helper. */
export function normalizeMutableOpenClawConfig(
  sandboxName: string,
  target: AgentConfigTarget,
): void {
  const protectedFileModes = mutableProtectedFileModes(target);
  const sandboxUid = sandboxIdentityId(sandboxName, "-u");
  const sandboxGid = sandboxIdentityId(sandboxName, "-g");
  // The in-sandbox watchdog signals the Python process group and reaps its
  // direct child before the longer host-side Docker timeout can release the
  // shields transition lock.
  runPrivileged(
    sandboxName,
    [
      ...MUTABLE_CONFIG_NORMALIZER_WATCHDOG,
      "/usr/bin/python3",
      "-I",
      MUTABLE_CONFIG_NORMALIZER,
      target.configDir,
      sandboxUid,
      sandboxGid,
      "normalize-protected",
      ...protectedFileModes.flatMap(([name, mode]) => [name, mode]),
    ],
    MUTABLE_CONFIG_NORMALIZER_HOST_TIMEOUT_MS,
  );
}
