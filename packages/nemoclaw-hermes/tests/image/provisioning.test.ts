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
import { hermesStartupModuleNames } from "../helpers/shell-harness";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const HERMES_DOCKERFILE = path.join(PACKAGE_ROOT, "Dockerfile");
const HERMES_DOCKERFILE_BASE = path.join(PACKAGE_ROOT, "Dockerfile.base");
const HERMES_FINALIZE_IMAGE_LAYOUT = path.join(PACKAGE_ROOT, "finalize-image-layout.sh");

describe("Hermes sandbox provisioning", () => {
  it("stages privileged lifecycle helpers with root-only Hermes image modes", () => {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-helper-modes-"));
    const localBin = path.join(tmp, "usr", "local", "bin");
    const localLib = path.join(tmp, "usr", "local", "lib", "nemoclaw");
    const hermesStartupDir = path.join(localLib, "hermes-startup");
    const hermesStartupPaths = hermesStartupModuleNames
      .map((moduleName) => path.join(hermesStartupDir, `${moduleName}.sh`))
      .sort();
    const etcDir = path.join(tmp, "etc");
    const profileDir = path.join(etcDir, "profile.d");
    const bashrcPath = path.join(etcDir, "bash.bashrc");
    const gatewayControlPath = path.join(localBin, "nemoclaw-gateway-control");
    const gatewaySupervisorPath = path.join(localLib, "gateway-supervisor.sh");
    const buildMcpDigestPath = path.join(localLib, "build-hermes-mcp-digest.py");
    const mcpConfigTransactionPath = path.join(localLib, "hermes-mcp-config-transaction.py");
    const langfuseCredentialPatcherPath = path.join(
      localLib,
      "patch-hermes-langfuse-credentials.mts",
    );
    const managedPolicyReaderPath = path.join(localLib, "managed_policy.py");
    const mcpManifest = path.join(localLib, "openshell-child-visible-credentials.v0.0.106.json");
    const managedGatewayControlPath = path.join(localLib, "managed-gateway-control.py");
    const hermesCronRestoreControlPath = path.join(localLib, "hermes-cron-restore-control.py");
    const corporateCaRuntimePath = path.join(localLib, "corporate-ca-runtime.sh");
    const files = [
      ...hermesStartupPaths,
      path.join(localBin, "nemoclaw-start"),
      path.join(localBin, "nemoclaw-managed-startup-hold"),
      path.join(localBin, "nemoclaw-managed-bootstrap"),
      gatewayControlPath,
      corporateCaRuntimePath,
      path.join(localLib, "entrypoint-env-wrapper.sh"),
      path.join(localLib, "sandbox-init.sh"),
      path.join(localLib, "validate-hermes-env-secret-boundary.py"),
      path.join(localLib, "patch-hermes-session-list-preview.py"),
      path.join(localLib, "patch-hermes-sqlite-temp-store.py"),
      path.join(localLib, "patch-hermes-discord-recovery-permissions.py"),
      path.join(localLib, "patch-hermes-profile-policy-defaults.py"),
      managedPolicyReaderPath,
      langfuseCredentialPatcherPath,
      path.join(localLib, "seed-hermes-dashboard-config.py"),
      path.join(localLib, "hermes-runtime-config-guard.py"),
      path.join(localLib, "finalize-tirith-marker.py"),
      buildMcpDigestPath,
      mcpConfigTransactionPath,
      mcpManifest,
      gatewaySupervisorPath,
      managedGatewayControlPath,
      hermesCronRestoreControlPath,
      path.join(localLib, "sandbox-rlimits.sh"),
    ];
    const command = dockerRunCommandBetween(
      dockerfile,
      "# Dockerfile.base is the source of truth for rlimit hooks.",
      "# Wrap the hermes CLI",
    )
      .replaceAll("/usr/local/bin", localBin)
      .replaceAll("/usr/local/lib/nemoclaw", localLib)
      .replaceAll("/opt/hermes/.venv/bin/python3", "python3")
      .replaceAll("/etc/profile.d", profileDir)
      .replaceAll("/etc/bash.bashrc", bashrcPath);
    try {
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(localLib, { recursive: true });
      fs.mkdirSync(hermesStartupDir, { recursive: true });
      fs.mkdirSync(etcDir, { recursive: true });
      fs.writeFileSync(bashrcPath, "# fixture\n", { mode: 0o600 });
      files.forEach((file) => {
        fs.writeFileSync(file, "# fixture\n", { mode: 0o600 });
      });
      const { result, calls } = runLoggedDockerShell(command, tmp, [
        'chown() { printf "chown %s\\n" "$*" >> "$call_log"; }',
      ]);

      expect(result.status, result.stderr).toBe(0);
      expect(calls).toContain(
        `chown root:root ${hermesStartupDir} ${hermesStartupPaths.join(" ")} ${gatewayControlPath} ${gatewaySupervisorPath} ${managedGatewayControlPath} ${buildMcpDigestPath} ${hermesCronRestoreControlPath} ${mcpManifest}`,
      );
      expect((fs.statSync(hermesStartupDir).mode & 0o777).toString(8)).toBe("555");
      expect(
        hermesStartupPaths.map((modulePath) => (fs.statSync(modulePath).mode & 0o777).toString(8)),
      ).toEqual(hermesStartupPaths.map(() => "444"));
      expect((fs.statSync(gatewayControlPath).mode & 0o777).toString(8)).toBe("700");
      expect((fs.statSync(hermesCronRestoreControlPath).mode & 0o777).toString(8)).toBe("700");
      expect((fs.statSync(mcpConfigTransactionPath).mode & 0o777).toString(8)).toBe("755");
      expect((fs.statSync(langfuseCredentialPatcherPath).mode & 0o777).toString(8)).toBe("444");
      expect((fs.statSync(mcpManifest).mode & 0o777).toString(8)).toBe("444");
      expect((fs.statSync(buildMcpDigestPath).mode & 0o777).toString(8)).toBe("444");
      expect((fs.statSync(managedPolicyReaderPath).mode & 0o777).toString(8)).toBe("444");
      expect((fs.statSync(gatewaySupervisorPath).mode & 0o777).toString(8)).toBe("444");
      expect((fs.statSync(corporateCaRuntimePath).mode & 0o777).toString(8)).toBe("444");
      expect((fs.statSync(managedGatewayControlPath).mode & 0o777).toString(8)).toBe("500");
    } finally {
      fs.existsSync(hermesStartupDir) && fs.chmodSync(hermesStartupDir, 0o700);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  function runHermesPathValidation(pathEntriesBeforeManifest: string[] = []) {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-path-"));
    const manifestHermes = path.join(tmp, "usr", "local", "bin", "hermes");
    const command = dockerRunCommandBetween(
      dockerfile,
      "# Keep the final image contract explicit",
      "# Harden: remove unnecessary build tools",
    ).replaceAll("/usr/local/bin/hermes", manifestHermes);
    const scriptPath = path.join(tmp, "run.sh");
    try {
      fs.mkdirSync(path.dirname(manifestHermes), { recursive: true });
      fs.writeFileSync(
        manifestHermes,
        "#!/usr/bin/env bash\nprintf 'hermes manifest version\\n'\n",
        { mode: 0o755 },
      );
      fs.writeFileSync(
        scriptPath,
        ["#!/usr/bin/env bash", "set -euo pipefail", command].join("\n"),
        {
          mode: 0o700,
        },
      );
      return spawnSync("bash", [scriptPath], {
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: [
            ...pathEntriesBeforeManifest,
            path.dirname(manifestHermes),
            "/usr/bin",
            "/bin",
          ].join(":"),
        },
        timeout: 5000,
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  function runHermesUserSetupBlock() {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE_BASE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-users-"));
    const sandboxRoot = path.join(tmp, "sandbox");
    const command = dockerRunCommandBetween(
      dockerfile,
      "# Create sandbox user (matches OpenShell convention)",
      "# Create .hermes with mutable integration dirs",
    ).replaceAll("/sandbox", sandboxRoot);
    const result = runLoggedDockerShell(command, tmp, [
      'groupadd() { printf "groupadd %s\\n" "$*" >> "$call_log"; }',
      'useradd() { printf "useradd %s\\n" "$*" >> "$call_log"; }',
      'usermod() { printf "usermod %s\\n" "$*" >> "$call_log"; }',
      'chown() { printf "chown %s\\n" "$*" >> "$call_log"; }',
      'id() { case "$1" in -u) printf "998\\n" ;; -g) printf "999\\n" ;; *) return 1 ;; esac; }',
      `getent() { printf "%s\\n" ${JSON.stringify(
        `sandbox:x:998:999::${sandboxRoot}:/bin/bash`,
      )}; }`,
    ]);
    return { ...result, tmp, sandboxRoot };
  }
  function runHermesLayoutBlock(
    dockerfilePath: string,
    startMarker: string,
    endMarker: string,
    { precreateConfig = false }: { precreateConfig?: boolean } = {},
  ) {
    const dockerfile = fs.readFileSync(dockerfilePath, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-layout-"));
    const sandboxRoot = path.join(tmp, "sandbox");
    const hermesDir = path.join(sandboxRoot, ".hermes");
    fs.mkdirSync(hermesDir, { recursive: true });
    if (precreateConfig) {
      fs.writeFileSync(path.join(hermesDir, "config.yaml"), "model: test\n");
      fs.writeFileSync(path.join(hermesDir, ".env"), "TOKEN=test\n");
    }
    const finalizeImageLayout = path.join(tmp, "finalize-image-layout.sh");
    fs.copyFileSync(HERMES_FINALIZE_IMAGE_LAYOUT, finalizeImageLayout);
    const finalizeImageLayoutSha256 =
      dockerfile.match(
        /^ARG NEMOCLAW_HERMES_FINALIZE_IMAGE_LAYOUT_SHA256=([a-f0-9]{64})$/mu,
      )?.[1] ?? "";
    const command = dockerRunCommandBetween(dockerfile, startMarker, endMarker)
      .replaceAll("/root/.cache/pip", path.join(tmp, "root-cache", "pip"))
      .replaceAll("/opt/nemoclaw-hermes-config/finalize-image-layout.sh", finalizeImageLayout)
      .replaceAll("$NEMOCLAW_HERMES_FINALIZE_IMAGE_LAYOUT_SHA256", finalizeImageLayoutSha256);
    const result = runDockerShell(command, sandboxRoot);
    return { ...result, tmp, sandboxRoot };
  }
  it("final image validates and runs the manifest-declared hermes binary path", () => {
    const result = runHermesPathValidation();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("hermes manifest version");
  });
  function runHermesUvExtrasExpansion() {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE_BASE, "utf-8");
    const extras = dockerfile.match(/^ARG HERMES_UV_EXTRAS="([^"]*)"$/m)?.[1];
    if (!extras) {
      throw new Error("Expected HERMES_UV_EXTRAS ARG in Hermes base Dockerfile");
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-uv-extras-"));
    const command = [
      "set -euo pipefail",
      `HERMES_UV_EXTRAS=${JSON.stringify(extras)}`,
      "set --",
      'for extra in ${HERMES_UV_EXTRAS}; do set -- "$@" --extra "$extra"; done',
      'printf "%s\\n" "$@"',
    ].join("\n");
    const result = spawnSync("bash", ["-c", command], {
      encoding: "utf-8",
      cwd: tmp,
      timeout: 5000,
    });
    return { result, tmp };
  }

  it("installs the selected Hermes extras, including native Anthropic (#4230)", () => {
    const { result, tmp } = runHermesUvExtrasExpansion();
    try {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim().split(/\n/)).toEqual([
        "--extra",
        "anthropic",
        "--extra",
        "messaging",
        "--extra",
        "web",
        "--extra",
        "pty",
        "--extra",
        "mcp",
        "--extra",
        "acp",
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("final image rejects a hermes binary from a different PATH location", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-wrong-path-"));
    const wrongBin = path.join(tmp, "bin");
    try {
      fs.mkdirSync(wrongBin);
      fs.writeFileSync(path.join(wrongBin, "hermes"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });
      const result = runHermesPathValidation([wrongBin]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("expected hermes");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("prebuilds the Hermes dashboard bundle in final images built from stale bases", () => {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-dashboard-build-"));
    const hermesRoot = path.join(tmp, "hermes");
    const hermesWebDir = path.join(hermesRoot, "web");
    const hermesWebDist = path.join(hermesRoot, "hermes_cli", "web_dist");
    const rootCache = path.join(tmp, "root-cache");
    fs.mkdirSync(hermesWebDir, { recursive: true });
    fs.writeFileSync(path.join(hermesWebDir, "package.json"), "{}\n");
    fs.writeFileSync(path.join(hermesWebDir, "package-lock.json"), "{}\n");
    fs.mkdirSync(path.join(hermesWebDir, "node_modules"), { recursive: true });
    ["npm", "electron", "node-gyp", "uv"].forEach((cache) => {
      const cachePath = path.join(rootCache, cache);
      fs.mkdirSync(cachePath, { recursive: true });
      fs.writeFileSync(path.join(cachePath, "build-only-cache"), "unused after image assembly\n");
    });
    const command = dockerRunCommandBetween(
      dockerfile,
      "# Published base images can lag Dockerfile.base",
      "# Harden: remove unnecessary build tools",
    )
      .replaceAll("/opt/hermes", hermesRoot)
      .replaceAll("/root/.npm", path.join(rootCache, "npm"))
      .replaceAll("/root/.cache/electron", path.join(rootCache, "electron"))
      .replaceAll("/root/.cache/node-gyp", path.join(rootCache, "node-gyp"))
      .replaceAll("/root/.cache/uv", path.join(rootCache, "uv"));
    try {
      const { result, calls } = runLoggedDockerShell(command, tmp, [
        'npm() { printf "npm %s\\n" "$*" >> "$call_log"; if [ -n "${hermes_web_dist:-}" ] && [ "${1:-}" = "run" ] && [ "${2:-}" = "build" ]; then mkdir -p "$hermes_web_dist"; fi; }',
      ]);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(calls).toContain(`npm ci --prefix ${hermesWebDir}`);
      expect(calls).toContain(`npm run build --prefix ${hermesWebDir}`);
      expect(fs.existsSync(hermesWebDist)).toBe(true);
      expect(fs.existsSync(path.join(hermesWebDir, "node_modules"))).toBe(false);
      ["npm", "electron", "node-gyp", "uv"].forEach((cache) => {
        expect(() => fs.lstatSync(path.join(rootCache, cache))).toThrow();
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("adds root to the Hermes sandbox group during base user setup", () => {
    const { result, calls, tmp, sandboxRoot } = runHermesUserSetupBlock();
    try {
      expect(result.status).toBe(0);
      expect(calls).toContain("groupadd -r -g 999 sandbox");
      expect(calls).toContain("groupadd -r -g 998 gateway");
      expect(calls).toContain(
        `useradd -r -u 999 -g gateway -G sandbox -d ${sandboxRoot} -s /usr/sbin/nologin gateway`,
      );
      expect(calls).toContain(
        `useradd -r -u 998 -g sandbox -d ${sandboxRoot} -s /bin/bash sandbox`,
      );
      expect(calls).toContain("usermod -a -G sandbox root");
      expect(calls).toContain(`chown -R sandbox:sandbox ${sandboxRoot}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("creates the Hermes lazy dependency target with sandbox ownership (#8613)", () => {
    const layout = runHermesLayoutBlock(
      HERMES_DOCKERFILE_BASE,
      "# Create .hermes with mutable integration dirs",
      "# Pre-create shell init files",
    );
    try {
      expect(layout.result.status, layout.result.stderr).toBe(0);
      const lazyPackages = path.join(layout.sandboxRoot, ".hermes", "lazy-packages");
      const metadata = fs.statSync(lazyPackages);
      expect(metadata.mode & 0o777).toBe(0o750);
      expect(layout.calls).toContain(
        `chown -R sandbox:sandbox ${path.join(layout.sandboxRoot, ".hermes")}`,
      );
    } finally {
      fs.rmSync(layout.tmp, { recursive: true, force: true });
    }
  });

  it("grants the Hermes gateway group write access to runtime state directories", () => {
    const runs = [
      runHermesLayoutBlock(
        HERMES_DOCKERFILE_BASE,
        "# Create .hermes with mutable integration dirs",
        "# Pre-create shell init files",
      ),
      runHermesLayoutBlock(
        HERMES_DOCKERFILE,
        "# Flatten stale published base images",
        "# Pin config hash at build time",
        { precreateConfig: true },
      ),
    ];
    try {
      runs.forEach((run) => {
        expect(run.result.status).toBe(0);
        const hermesDir = path.join(run.sandboxRoot, ".hermes");
        expect((fs.statSync(hermesDir).mode & 0o7777).toString(8)).toBe("3770");
        expect(
          [
            "logs",
            "logs/curator",
            "cache",
            "hooks",
            "image_cache",
            "audio_cache",
            "fabric-artifacts",
            "platforms",
          ].every((dir) =>
            Object.is((fs.statSync(path.join(hermesDir, dir)).mode & 0o777).toString(8), "770"),
          ),
        ).toBe(true);
        expect((fs.statSync(path.join(hermesDir, "platforms")).mode & 0o7777).toString(8)).toBe(
          "2770",
        );
        expect((fs.statSync(path.join(hermesDir, "logs")).mode & 0o7777).toString(8)).toBe("2770");
        expect(
          (fs.statSync(path.join(hermesDir, "logs", "curator")).mode & 0o7777).toString(8),
        ).toBe("2770");
        const whatsappSessionDir = path.join(hermesDir, "platforms", "whatsapp", "session");
        expect((fs.statSync(whatsappSessionDir).mode & 0o7777).toString(8)).toBe("2770");
        expect((fs.statSync(path.join(hermesDir, "runtime")).mode & 0o7777).toString(8)).toBe(
          "2770",
        );
        expect(fs.readlinkSync(path.join(hermesDir, "gateway_state.json"))).toBe(
          "runtime/gateway_state.json",
        );
        expect(() => fs.lstatSync(path.join(hermesDir, "gateway.pid"))).toThrow();
        expect(run.calls).toContain(
          `chown gateway:sandbox ${path.join(hermesDir, "cron")} ${path.join(
            hermesDir,
            "gateway",
          )} ${path.join(hermesDir, "runtime")}`,
        );
      });
    } finally {
      runs.forEach((run) => {
        fs.rmSync(run.tmp, { recursive: true, force: true });
      });
    }
  });
});
