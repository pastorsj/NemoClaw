// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  dockerRunCommandBetween,
  runDockerShell,
  runLoggedDockerShell,
} from "../helpers/docker-shell";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const DOCKERFILE = path.join(PACKAGE_ROOT, "Dockerfile");
const DOCKERFILE_BASE = path.join(PACKAGE_ROOT, "Dockerfile.base");

function runOpenclawRepairLayoutCase(legacy: boolean) {
  const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
  const cleanupBlock = dockerRunCommandBetween(
    dockerfile,
    "# Flatten stale published base images",
    "# Stale-base fallback for the gateway/root-in-sandbox-group setup",
  );
  const permissionBlock = dockerRunCommandBetween(
    dockerfile,
    "# Keep the image readable to the root entrypoint",
    "# System-wide shell hooks",
  );
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-repair-"));
  const sandboxRoot = path.join(tmp, "sandbox");
  const openclawDir = path.join(sandboxRoot, ".openclaw");
  const dataDir = path.join(sandboxRoot, ".openclaw-data");
  const marker = path.join(tmp, "legacy-marker");
  const rootNpm = path.join(tmp, "root-npm");
  const sandboxNpm = path.join(sandboxRoot, ".npm");
  const relativePath = (entry: string) => path.relative(openclawDir, entry) || ".";
  const listRelativeEntries = (dir: string, kind: "directory" | "file"): string[] => {
    const entries: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (kind === "directory") {
          entries.push(relativePath(entryPath));
        }
        entries.push(...listRelativeEntries(entryPath, kind));
      } else if (kind === "file" && entry.isFile()) {
        entries.push(relativePath(entryPath));
      }
    }
    return entries.sort();
  };
  const rewrite = (command: string) =>
    command
      .replaceAll("/sandbox/.openclaw-data", "__NEMOCLAW_TEST_OPENCLAW_DATA__")
      .replaceAll("/sandbox/.openclaw", "__NEMOCLAW_TEST_OPENCLAW_DIR__")
      .replaceAll("/sandbox/.npm", "__NEMOCLAW_TEST_SANDBOX_NPM__")
      .replaceAll("/tmp/nemoclaw-legacy-openclaw-layout", marker)
      .replaceAll("/root/.npm", rootNpm)
      .replaceAll("__NEMOCLAW_TEST_OPENCLAW_DATA__", dataDir)
      .replaceAll("__NEMOCLAW_TEST_OPENCLAW_DIR__", openclawDir)
      .replaceAll("__NEMOCLAW_TEST_SANDBOX_NPM__", sandboxNpm);
  const functionDefs = [
    'install() { printf "install %s\\n" "$*" >> "$call_log"; local target="${*: -1}"; mkdir -p "$target"; }',
    'chown() { printf "chown %s\\n" "$*" >> "$call_log"; }',
    'chmod() { printf "chmod %s\\n" "$*" >> "$call_log"; command chmod "$@"; }',
    'find() { printf "find %s\\n" "$*" >> "$call_log"; command find "$@"; }',
  ];

  fs.mkdirSync(openclawDir, { recursive: true });
  if (legacy) {
    fs.mkdirSync(path.join(dataDir, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "extensions", "legacy-plugin.json"), "{}\n");
  }

  const cleanup = runLoggedDockerShell(rewrite(cleanupBlock), tmp, functionDefs);
  const markerExistsAfterCleanup = fs.existsSync(marker);
  const dirsAfterCleanup = [".", ...listRelativeEntries(openclawDir, "directory")];
  const filesAfterCleanup = listRelativeEntries(openclawDir, "file");
  fs.writeFileSync(path.join(openclawDir, "openclaw.json"), "{}\n");
  fs.writeFileSync(path.join(openclawDir, "fabric.json"), "{}\n");
  const permission = runLoggedDockerShell(rewrite(permissionBlock), tmp, functionDefs);
  const markerExistsAfterPermission = fs.existsSync(marker);

  try {
    return {
      cleanup,
      dirsAfterCleanup,
      filesAfterCleanup,
      markerExistsAfterCleanup,
      markerExistsAfterPermission,
      openclawDir,
      permission,
      pluginRuntimeDeps: path.join(openclawDir, "plugin-runtime-deps"),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function runOpenclawUserSetupBlock() {
  const dockerfile = fs.readFileSync(DOCKERFILE_BASE, "utf-8");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-users-"));
  const sandboxRoot = path.join(tmp, "sandbox");
  const command = dockerRunCommandBetween(
    dockerfile,
    "# Create sandbox user (matches OpenShell convention)",
    "# Create .openclaw with all state subdirs directly",
  ).replaceAll("/sandbox", sandboxRoot);
  const result = runLoggedDockerShell(command, tmp, [
    'groupadd() { printf "groupadd %s\\n" "$*" >> "$call_log"; }',
    'useradd() { printf "useradd %s\\n" "$*" >> "$call_log"; }',
    'usermod() { printf "usermod %s\\n" "$*" >> "$call_log"; }',
    'chown() { printf "chown %s\\n" "$*" >> "$call_log"; }',
    'id() { case "$1" in -u|-g) printf "998\\n" ;; *) return 1 ;; esac; }',
    `getent() { printf "%s\\n" ${JSON.stringify(`sandbox:x:998:998::${sandboxRoot}:/bin/bash`)}; }`,
  ]);
  return { ...result, tmp, sandboxRoot };
}

function runOpenclawStaleGroupFallback() {
  const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-groups-"));
  const command = dockerRunCommandBetween(
    dockerfile,
    "# Stale-base fallback for the gateway/root-in-sandbox-group setup",
    "# Keep the image readable to the root entrypoint",
  );
  const result = runLoggedDockerShell(command, tmp, [
    'id() { case "$*" in "gateway"|"sandbox"|"root") return 0 ;; "-nG gateway") printf "gateway\\n" ;; "-nG root") printf "root\\n" ;; *) return 1 ;; esac; }',
    'usermod() { printf "usermod %s\\n" "$*" >> "$call_log"; }',
  ]);
  return { ...result, tmp };
}

function dockerfileEnvDirectives(text: string): string[] {
  const lines = text.split("\n");
  const directives: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (!/^ENV\s/.test(raw)) continue;
    let collected = raw.replace(/^ENV\s+/, "");
    while (collected.endsWith("\\") && i + 1 < lines.length) {
      collected = `${collected.slice(0, -1)} ${lines[++i] ?? ""}`;
    }
    directives.push(collected.trim());
  }
  return directives;
}

function envDirectiveToExports(directive: string): string[] {
  const exports: string[] = [];
  const pattern = /([A-Za-z_][A-Za-z0-9_]*)=("([^"]*)"|'([^']*)'|(\S+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(directive)) !== null) {
    const name = match[1];
    const value = match[3] ?? match[4] ?? match[5] ?? "";
    exports.push(`export ${name}=${JSON.stringify(value)}`);
  }
  return exports;
}

function collectDockerfileEnvExports(file: string): string[] {
  const text = fs.readFileSync(file, "utf-8");
  return dockerfileEnvDirectives(text).flatMap(envDirectiveToExports);
}

function stageDockerfileUntil(file: string, runMarker: string): string[] {
  const text = fs.readFileSync(file, "utf-8");
  const cutoff = text.indexOf(runMarker);
  if (cutoff === -1) {
    throw new Error(`Dockerfile is missing expected RUN marker: ${runMarker}`);
  }
  return dockerfileEnvDirectives(text.slice(0, cutoff)).flatMap(envDirectiveToExports);
}

describe("sandbox provisioning: runtime npm online state", () => {
  // source-shape-contract: compatibility -- Model manifests and their package-owned plugin sources must remain siblings in the completed image so generator path validation succeeds.
  it("stages model-specific plugin sources beside their manifests", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
    expect(dockerfile).toContain(
      "COPY packages/nemoclaw-openclaw/model-specific-setup/openclaw/ /opt/nemoclaw-blueprint/model-specific-setup/openclaw/",
    );
    expect(dockerfile).toContain(
      "COPY packages/nemoclaw-openclaw/openclaw-plugins/ /opt/nemoclaw-blueprint/openclaw-plugins/",
    );
    expect(dockerfile).toContain("COPY --from=openclaw-plugin-payload / /");
  });

  it("does not bake the split-user OpenClaw state marker into the runtime environment", () => {
    const exports = collectDockerfileEnvExports(DOCKERFILE);
    const probe = [
      "#!/usr/bin/env bash",
      "set -eo pipefail",
      ...exports,
      'printf "%s\\n" "${NPM_CONFIG_OFFLINE:-unset}" "${NEMOCLAW_OPENCLAW_SHARED_STATE:-unset}"',
    ].join("\n");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-npm-online-"));
    const scriptPath = path.join(tmp, "replay.sh");
    try {
      fs.writeFileSync(scriptPath, probe, { mode: 0o700 });
      const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
      expect(result.status, `stderr: ${result.stderr}`).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual(["false", "unset"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("exercises the staged plugin install with the offline lock still applied", () => {
    const stage = stageDockerfileUntil(DOCKERFILE, "openclaw plugins install /opt/nemoclaw");
    const probe = [
      "#!/usr/bin/env bash",
      "set -eo pipefail",
      ...stage,
      'printf "%s\\n" "${NPM_CONFIG_OFFLINE:-unset}"',
    ].join("\n");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-npm-online-staged-"));
    const scriptPath = path.join(tmp, "staged.sh");
    try {
      fs.writeFileSync(scriptPath, probe, { mode: 0o700 });
      const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
      expect(result.status, `stderr: ${result.stderr}`).toBe(0);
      expect(result.stdout.trim()).toBe("true");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("sandbox provisioning: unified .openclaw layout (#2227)", () => {
  it("keeps root in the sandbox group for capability-dropped lifecycle guards", () => {
    const base = runOpenclawUserSetupBlock();
    const fallback = runOpenclawStaleGroupFallback();
    try {
      expect(base.result.status, base.result.stderr).toBe(0);
      expect(base.calls).toContain("groupadd -r -g 999 gateway");
      expect(base.calls).toContain(
        `useradd -r -u 999 -g gateway -d ${base.sandboxRoot} -s /usr/sbin/nologin gateway`,
      );
      expect(base.calls).toContain("groupadd -r -g 998 sandbox");
      expect(base.calls).toContain(
        `useradd -r -u 998 -g sandbox -d ${base.sandboxRoot} -s /bin/bash sandbox`,
      );
      expect(base.calls).toContain("usermod -aG sandbox gateway");
      expect(base.calls).toContain("usermod -aG sandbox root");
      expect(fallback.result.status, fallback.result.stderr).toBe(0);
      expect(fallback.calls).toContain("usermod -aG sandbox gateway");
      expect(fallback.calls).toContain("usermod -aG sandbox root");
    } finally {
      fs.rmSync(base.tmp, { recursive: true, force: true });
      fs.rmSync(fallback.tmp, { recursive: true, force: true });
    }
  });

  it("uses targeted permission repair unless legacy migration ran", () => {
    const modern = runOpenclawRepairLayoutCase(false);
    expect(modern.cleanup.result.status).toBe(0);
    expect(modern.permission.result.status).toBe(0);
    expect(modern.markerExistsAfterCleanup).toBe(false);
    expect(modern.markerExistsAfterPermission).toBe(false);
    expect(modern.dirsAfterCleanup).toEqual([
      ".",
      "agents",
      "agents/main",
      "agents/main/agent",
      "canvas",
      "credentials",
      "cron",
      "devices",
      "extensions",
      "fabric-artifacts",
      "flows",
      "hooks",
      "identity",
      "logs",
      "media",
      "memory",
      "plugin-runtime-deps",
      "sandbox",
      "skills",
      "state",
      "telegram",
      "wechat",
      "workspace",
    ]);
    expect(modern.filesAfterCleanup).toEqual(["exec-approvals.json"]);
    expect(modern.cleanup.calls.split("\n").filter(Boolean)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^find /)]),
    );
    expect(modern.permission.calls.split("\n").filter(Boolean)).toEqual([
      `chown sandbox:sandbox ${modern.openclawDir} ${path.join(
        modern.openclawDir,
        "openclaw.json",
      )} ${path.join(modern.openclawDir, "fabric.json")} ${modern.pluginRuntimeDeps}`,
      `chmod 2770 ${modern.openclawDir} ${modern.pluginRuntimeDeps}`,
      `chmod 660 ${path.join(modern.openclawDir, "openclaw.json")}`,
      `chmod 600 ${path.join(modern.openclawDir, "fabric.json")}`,
    ]);

    const legacy = runOpenclawRepairLayoutCase(true);
    expect(legacy.cleanup.result.status).toBe(0);
    expect(legacy.permission.result.status).toBe(0);
    expect(legacy.markerExistsAfterCleanup).toBe(true);
    expect(legacy.markerExistsAfterPermission).toBe(false);
    expect(legacy.cleanup.calls.split("\n").filter(Boolean)).toEqual(
      expect.arrayContaining([`find ${legacy.openclawDir} -type l -print`]),
    );
    expect(legacy.permission.calls.split("\n").filter(Boolean)).toEqual(
      expect.arrayContaining([
        `chown -R sandbox:sandbox ${legacy.openclawDir}`,
        `chmod -R g+rwX,o-rwx ${legacy.openclawDir}`,
        `find ${legacy.openclawDir} -type d -exec chmod g+s {} +`,
      ]),
    );
  });

  it("provisions unified mutable .openclaw layout and clean trusted rc files", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE_BASE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-base-layout-"));
    const sandboxRoot = path.join(tmp, "sandbox");
    fs.mkdirSync(sandboxRoot, { recursive: true });

    try {
      const layout = runDockerShell(
        dockerRunCommandBetween(
          dockerfile,
          "# Create .openclaw with all state subdirs directly",
          "# Pre-create shell init files",
        ),
        sandboxRoot,
      );
      expect(layout.result.status).toBe(0);
      const openclawDir = path.join(sandboxRoot, ".openclaw");
      expect(fs.statSync(openclawDir).isDirectory()).toBe(true);
      expect(fs.statSync(path.join(openclawDir, "exec-approvals.json")).isFile()).toBe(true);
      expect(fs.existsSync(path.join(openclawDir, "update-check.json"))).toBe(false);
      [
        "credentials",
        "devices",
        "fabric-artifacts",
        "identity",
        "logs",
        "state",
        "telegram",
      ].forEach((dir) => {
        const stateDir = path.join(openclawDir, dir);
        expect(fs.statSync(stateDir).isDirectory()).toBe(true);
        expect(fs.lstatSync(stateDir).isSymbolicLink()).toBe(false);
        expect(fs.statSync(stateDir).mode & 0o020).toBe(0o020);
        expect(fs.statSync(stateDir).mode & 0o2000).toBe(0o2000);
      });
      expect(fs.existsSync(path.join(sandboxRoot, ".openclaw-data"))).toBe(false);
      expect(fs.lstatSync(path.join(openclawDir, "exec-approvals.json")).isSymbolicLink()).toBe(
        false,
      );
      expect(layout.calls).toContain(`chown -R sandbox:sandbox ${openclawDir}`);

      const rc = runDockerShell(
        dockerRunCommandBetween(
          dockerfile,
          "# Pre-create shell init files for the sandbox user.",
          "# System-wide proxy hooks.",
        ),
        sandboxRoot,
      );
      expect(rc.result.status).toBe(0);
      [".bashrc", ".profile"].forEach((rcName) => {
        const rcPath = path.join(sandboxRoot, rcName);
        const content = fs.readFileSync(rcPath, "utf-8");
        expect(content.toLowerCase()).not.toContain("proxy");
        expect(content).not.toContain("/tmp/nemoclaw-proxy-env.sh");
        expect((fs.statSync(rcPath).mode & 0o777).toString(8)).toBe("444");
      });
      expect(rc.calls).toContain(
        `chown root:root ${path.join(sandboxRoot, ".bashrc")} ${path.join(sandboxRoot, ".profile")}`,
      );
      expect(rc.calls).not.toContain("sandbox:sandbox");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("provisions system-wide runtime proxy hooks", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE_BASE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-base-system-proxy-"));
    const profileHook = path.join(tmp, "profile.d", "nemoclaw-proxy.sh");
    const rlimitHook = path.join(tmp, "profile.d", "nemoclaw-rlimits.sh");
    const rlimitLib = path.join(tmp, "sandbox-rlimits.sh");
    const bashrc = path.join(tmp, "bash.bashrc");
    const runtimeEnvShim = "[ -f /tmp/nemoclaw-proxy-env.sh ] && . /tmp/nemoclaw-proxy-env.sh";
    const rlimitShim = `[ -f ${rlimitLib} ] && . ${rlimitLib} && harden_resource_limits --quiet && verify_resource_limits --quiet || true`;

    try {
      fs.mkdirSync(path.dirname(profileHook), { recursive: true });
      fs.writeFileSync(rlimitLib, "# rlimit fixture\n");
      fs.writeFileSync(bashrc, "# existing bashrc\n");
      const command = dockerRunCommandBetween(
        dockerfile,
        "# System-wide proxy hooks",
        "# Install OpenClaw CLI + PyYAML",
      )
        .replaceAll("/usr/local/lib/nemoclaw/sandbox-rlimits.sh", rlimitLib)
        .replaceAll("/etc/profile.d/nemoclaw-rlimits.sh", rlimitHook)
        .replaceAll("/etc/profile.d/nemoclaw-proxy.sh", profileHook)
        .replaceAll("/etc/bash.bashrc", bashrc);

      const { result } = runLoggedDockerShell(command, tmp);
      expect(result.status).toBe(0);
      expect(fs.readFileSync(rlimitHook, "utf-8").split(rlimitShim).length - 1).toBe(1);
      expect((fs.statSync(rlimitHook).mode & 0o777).toString(8)).toBe("444");
      expect((fs.statSync(rlimitLib).mode & 0o777).toString(8)).toBe("444");
      expect(fs.readFileSync(profileHook, "utf-8").split(runtimeEnvShim).length - 1).toBe(1);
      expect((fs.statSync(profileHook).mode & 0o777).toString(8)).toBe("444");

      const bashrcContent = fs.readFileSync(bashrc, "utf-8");
      expect(bashrcContent.split(rlimitShim).length - 1).toBe(1);
      expect(bashrcContent.split(runtimeEnvShim).length - 1).toBe(1);
      expect(bashrcContent.indexOf(runtimeEnvShim)).toBeLessThan(bashrcContent.indexOf(rlimitShim));
      expect(bashrcContent.split("\n").slice(0, 2).join("\n")).toContain(runtimeEnvShim);
      expect(bashrcContent).toContain("# existing bashrc");
      expect((fs.statSync(bashrc).mode & 0o777).toString(8)).toBe("444");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("repairs stale OpenClaw base images with system-wide rlimit hooks", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-thin-rlimits-"));
    const profileHook = path.join(tmp, "profile.d", "nemoclaw-proxy.sh");
    const rlimitHook = path.join(tmp, "profile.d", "nemoclaw-rlimits.sh");
    const rlimitLib = path.join(tmp, "sandbox-rlimits.sh");
    const bashrc = path.join(tmp, "bash.bashrc");
    const runtimeEnvShim = "[ -f /tmp/nemoclaw-proxy-env.sh ] && . /tmp/nemoclaw-proxy-env.sh";
    const rlimitShim = `[ -f ${rlimitLib} ] && . ${rlimitLib} && harden_resource_limits --quiet && verify_resource_limits --quiet || true`;

    try {
      fs.mkdirSync(path.dirname(profileHook), { recursive: true });
      fs.writeFileSync(rlimitLib, "# rlimit fixture\n");
      fs.writeFileSync(bashrc, "# stale base bashrc\n");
      const command = dockerRunCommandBetween(
        dockerfile,
        "# System-wide shell hooks",
        "# Pin config hash at build time",
      )
        .replaceAll("/usr/local/lib/nemoclaw/sandbox-rlimits.sh", rlimitLib)
        .replaceAll("/etc/profile.d/nemoclaw-rlimits.sh", rlimitHook)
        .replaceAll("/etc/profile.d/nemoclaw-proxy.sh", profileHook)
        .replaceAll("/etc/bash.bashrc", bashrc);

      const { result } = runLoggedDockerShell(command, tmp);
      expect(result.status).toBe(0);
      expect(fs.readFileSync(rlimitHook, "utf-8").split(rlimitShim).length - 1).toBe(1);
      expect(fs.readFileSync(profileHook, "utf-8").split(runtimeEnvShim).length - 1).toBe(1);

      const bashrcContent = fs.readFileSync(bashrc, "utf-8");
      expect(bashrcContent.split(rlimitShim).length - 1).toBe(1);
      expect(bashrcContent.split(runtimeEnvShim).length - 1).toBe(1);
      expect(bashrcContent.indexOf(runtimeEnvShim)).toBeLessThan(bashrcContent.indexOf(rlimitShim));
      expect(bashrcContent.split("\n").slice(0, 2).join("\n")).toContain(runtimeEnvShim);
      expect(bashrcContent).toContain("# stale base bashrc");
      expect((fs.statSync(bashrc).mode & 0o777).toString(8)).toBe("444");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("sandbox provisioning: stale base runtime tools", () => {
  it("runtime hardening installs procps and e2fsprogs when a stale base lacks ps and chattr", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-procps-"));
    const log = path.join(tmp, "calls.log");
    const marker = path.join(tmp, "ps-installed");
    const chattrMarker = path.join(tmp, "chattr-installed");
    const tmuxMarker = path.join(tmp, "tmux-installed");
    const lists = path.join(tmp, "apt-lists");
    fs.mkdirSync(lists);
    const command = dockerRunCommandBetween(
      dockerfile,
      "# Harden: remove unnecessary build tools",
      "# Copy built plugin and blueprint",
    ).replaceAll("/var/lib/apt/lists", lists);
    const script = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `call_log=${JSON.stringify(log)}`,
      `ps_marker=${JSON.stringify(marker)}`,
      `chattr_marker=${JSON.stringify(chattrMarker)}`,
      `tmux_marker=${JSON.stringify(tmuxMarker)}`,
      'apt-mark() { printf "apt-mark %s\\n" "$*" >> "$call_log"; }',
      'apt-get() { printf "apt-get %s\\n" "$*" >> "$call_log"; if [[ "$*" == *"install"* && "$*" == *"procps=2:4.0.4-9"* ]]; then touch "$ps_marker"; fi; if [[ "$*" == *"install"* && "$*" == *"e2fsprogs=1.47.2-3+b11"* ]]; then touch "$chattr_marker"; fi; if [[ "$*" == *"install"* && "$*" == *"tmux=3.5a-3"* ]]; then touch "$tmux_marker"; fi; }',
      'command() { if [ "${1:-}" = "-v" ] && [ "${2:-}" = "ps" ]; then [ -f "$ps_marker" ]; elif [ "${1:-}" = "-v" ] && [ "${2:-}" = "chattr" ]; then [ -f "$chattr_marker" ]; elif [ "${1:-}" = "-v" ] && [ "${2:-}" = "tmux" ]; then [ -f "$tmux_marker" ]; else builtin command "$@"; fi; }',
      'ps() { [ -f "$ps_marker" ] || return 127; printf "procps test version\\n"; }',
      command,
    ].join("\n");
    const scriptPath = path.join(tmp, "run.sh");
    try {
      fs.writeFileSync(scriptPath, script, { mode: 0o700 });
      const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
      expect(result.status).toBe(0);
      const calls = fs.readFileSync(log, "utf-8");
      expect(calls).toContain("apt-mark manual procps e2fsprogs");
      expect(calls).toContain("apt-get autoremove --purge -y");
      expect(calls).toContain("apt-get update");
      expect(calls).toContain("apt-get install -y --no-install-recommends procps=2:4.0.4-9");
      expect(calls).toContain("apt-get install -y --no-install-recommends e2fsprogs=1.47.2-3+b11");
      expect(result.stdout).toContain("procps test version");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
