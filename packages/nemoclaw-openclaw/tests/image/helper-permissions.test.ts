// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  dockerRunCommandBetween,
  runLoggedDockerShell,
} from "../../../../test/helpers/dockerfile-run-shell";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const DOCKERFILE = path.join(ROOT, "packages", "nemoclaw-openclaw", "Dockerfile");

describe("sandbox provisioning: copied OpenClaw helper permissions (#2861)", () => {
  it("keeps copied messaging metadata searchable by the sandbox user", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-messaging-mode-"));
    const messagingDirectory = path.join(tmp, "usr", "local", "share", "nemoclaw", "messaging");

    try {
      fs.mkdirSync(messagingDirectory, { recursive: true });
      fs.writeFileSync(path.join(messagingDirectory, "runtime-profile.json"), "{}\n", {
        mode: 0o444,
      });
      // Docker COPY --chmod applies the restrictive mode to a newly created
      // destination directory on BuildKit. Replay that state before the image
      // changes to the unprivileged sandbox user.
      fs.chmodSync(messagingDirectory, 0o444);

      const command = dockerRunCommandBetween(
        dockerfile,
        "# Bake reduced messaging runtime metadata",
        "USER sandbox",
      ).replaceAll("/usr/local/share/nemoclaw/messaging", messagingDirectory);
      const { result } = runLoggedDockerShell(command, tmp, ["node() { :; }"], {
        env: { OPENCLAW_VERSION: "fixture-version" },
      });

      expect(result.status, result.stderr).toBe(0);
      expect((fs.statSync(messagingDirectory).mode & 0o777).toString(8)).toBe("755");
      expect(
        fs.accessSync(path.join(messagingDirectory, "runtime-profile.json"), fs.constants.R_OK),
      ).toBeUndefined();
    } finally {
      try {
        fs.chmodSync(messagingDirectory, 0o755);
      } catch {
        // The directory may not exist if fixture creation failed.
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("normalizes copied blueprint permissions before non-root config generation", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-blueprint-mode-"));
    const blueprintRoot = path.join(tmp, "opt", "nemoclaw-blueprint");
    const nemoclawRoot = path.join(tmp, "opt", "nemoclaw");
    const manifestDir = path.join(blueprintRoot, "model-specific-setup", "openclaw");
    const manifestPath = path.join(manifestDir, "kimi-k2.6-managed-inference.json");
    const pluginPackageJson = path.join(nemoclawRoot, "package.json");
    const pluginManifest = path.join(nemoclawRoot, "openclaw.plugin.json");

    try {
      fs.mkdirSync(manifestDir, { recursive: true });
      fs.writeFileSync(manifestPath, "{}\n", { mode: 0o600 });
      fs.chmodSync(path.join(blueprintRoot, "model-specific-setup"), 0o700);
      fs.chmodSync(manifestDir, 0o700);
      fs.chmodSync(manifestPath, 0o600);
      fs.mkdirSync(nemoclawRoot, { recursive: true });
      fs.writeFileSync(pluginPackageJson, "{}\n", { mode: 0o400 });
      fs.writeFileSync(pluginManifest, "{}\n", { mode: 0o400 });
      fs.chmodSync(nemoclawRoot, 0o700);
      fs.chmodSync(pluginPackageJson, 0o400);
      fs.chmodSync(pluginManifest, 0o400);

      const command = dockerRunCommandBetween(
        dockerfile,
        "# Copy built plugin and blueprint",
        "# The builder-stage verify-openshell-policy-boundary-dependencies.mts check",
      )
        .replaceAll("/opt/nemoclaw-blueprint", "__BLUEPRINT__")
        .replaceAll("/opt/nemoclaw", nemoclawRoot)
        .replaceAll("__BLUEPRINT__", blueprintRoot);
      const { result } = runLoggedDockerShell(command, tmp);

      expect(result.status, result.stderr).toBe(0);
      expect((fs.statSync(manifestDir).mode & 0o777).toString(8)).toBe("755");
      expect((fs.statSync(manifestPath).mode & 0o777).toString(8)).toBe("644");
      expect((fs.statSync(nemoclawRoot).mode & 0o777).toString(8)).toBe("755");
      expect((fs.statSync(pluginPackageJson).mode & 0o777).toString(8)).toBe("444");
      expect((fs.statSync(pluginManifest).mode & 0o777).toString(8)).toBe("644");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("normalizes the config generator mode after Docker COPY preserves a restrictive source mode", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-helper-mode-"));
    const localBin = path.join(tmp, "usr", "local", "bin");
    const localLib = path.join(tmp, "usr", "local", "lib", "nemoclaw");
    const localShare = path.join(tmp, "usr", "local", "share", "nemoclaw");
    const localScripts = path.join(tmp, "scripts");
    const retiredSourceRoot = path.join(tmp, "retired-source-root");
    const localPackageRoot = path.join(tmp, "packages", "nemoclaw-openclaw");
    const generatorPath = path.join(localPackageRoot, "config", "generate-config.mts");
    const toolSearchValidatorPath = path.join(localScripts, "validate-openclaw-tool-search.mts");
    const toolDisclosurePath = path.join(localPackageRoot, "config", "tool-disclosure.ts");
    const pluginDir = path.join(localShare, "openclaw-plugins", "kimi-inference-compat");
    const pluginFile = path.join(pluginDir, "index.js");
    const nestedPluginDir = path.join(pluginDir, "lib");
    const nestedPluginFile = path.join(nestedPluginDir, "helper.js");
    const gatewayControlPath = path.join(localBin, "nemoclaw-gateway-control");
    const gatewaySupervisorPath = path.join(localLib, "gateway-supervisor.sh");
    const startupDirectory = path.join(localLib, "openclaw-startup");
    const startupModulePath = path.join(startupDirectory, "auto-pair.py");
    const configGuardPath = path.join(localLib, "openclaw-config-guard.py");
    const managedGatewayControlPath = path.join(localLib, "managed-gateway-control.py");
    const managedGatewayProfilePath = path.join(localLib, "managed-gateway-profile.py");
    const files = [
      path.join(localBin, "nemoclaw-start"),
      path.join(localBin, "nemoclaw-codex-acp"),
      path.join(localBin, "nemoclaw-managed-startup-hold"),
      path.join(localBin, "nemoclaw-managed-bootstrap"),
      gatewayControlPath,
      path.join(localLib, "entrypoint-env-wrapper.sh"),
      path.join(localLib, "sandbox-init.sh"),
      path.join(localLib, "sandbox-rlimits.sh"),
      gatewaySupervisorPath,
      startupModulePath,
      configGuardPath,
      managedGatewayControlPath,
      managedGatewayProfilePath,
      path.join(localLib, "openclaw_device_approval_policy.py"),
      path.join(localLib, "clean_runtime_shell_env_shim.py"),
      path.join(localLib, "normalize_mutable_config_perms.py"),
      generatorPath,
      toolSearchValidatorPath,
      toolDisclosurePath,
      pluginFile,
      nestedPluginFile,
    ];

    try {
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(localLib, { recursive: true });
      fs.mkdirSync(startupDirectory, { recursive: true });
      fs.mkdirSync(localScripts, { recursive: true });
      fs.mkdirSync(path.dirname(generatorPath), { recursive: true });
      fs.mkdirSync(nestedPluginDir, { recursive: true });
      files.forEach((file) => {
        fs.writeFileSync(file, "# fixture\n", { mode: 0o600 });
        fs.chmodSync(file, 0o600);
      });
      fs.chmodSync(startupModulePath, 0o444);
      fs.chmodSync(startupDirectory, 0o444);
      for (const directory of [
        path.join(tmp, "packages"),
        localPackageRoot,
        path.join(localPackageRoot, "config"),
        path.join(localPackageRoot, "host"),
      ]) {
        fs.mkdirSync(directory, { recursive: true });
        fs.chmodSync(directory, 0o700);
      }

      const permissionCommands = [
        dockerRunCommandBetween(
          dockerfile,
          "# Copy only the configuration inputs needed by the expensive non-messaging",
          "# Build args for config that varies per deployment",
        ),
        dockerRunCommandBetween(
          dockerfile,
          "# Copy startup script and shared sandbox initialisation library",
          "# Lock down npm for the next RUN",
        ),
      ];
      for (const permissionCommand of permissionCommands) {
        const command = permissionCommand
          .replaceAll("/usr/local/bin", localBin)
          .replaceAll("/usr/local/lib/nemoclaw", localLib)
          .replaceAll("/usr/local/share/nemoclaw", localShare)
          .replaceAll("/packages/nemoclaw-openclaw", "__OPENCLAW_PACKAGE__")
          .replaceAll("/packages", path.join(tmp, "packages"))
          .replaceAll("__OPENCLAW_PACKAGE__", localPackageRoot)
          // Leave this localized path absent. A stale final-image /src chmod then
          // fails exactly as it would against a clean published base image.
          .replaceAll("/src", retiredSourceRoot)
          .replaceAll("/scripts", localScripts);
        const { result } = runLoggedDockerShell(command, tmp, ["chown() { :; }"]);
        expect(result.status, result.stderr).toBe(0);
      }

      expect((fs.statSync(generatorPath).mode & 0o777).toString(8)).toBe("755");
      for (const directory of [
        path.join(tmp, "packages"),
        localPackageRoot,
        path.join(localPackageRoot, "config"),
        path.join(localPackageRoot, "host"),
      ]) {
        expect((fs.statSync(directory).mode & 0o777).toString(8)).toBe("755");
      }
      expect((fs.statSync(toolSearchValidatorPath).mode & 0o777).toString(8)).toBe("755");
      expect((fs.statSync(toolDisclosurePath).mode & 0o777).toString(8)).toBe("444");
      expect(
        (
          fs.statSync(path.join(localLib, "openclaw_device_approval_policy.py")).mode & 0o777
        ).toString(8),
      ).toBe("644");
      expect(
        (
          fs.statSync(path.join(localLib, "normalize_mutable_config_perms.py")).mode & 0o777
        ).toString(8),
      ).toBe("555");
      expect((fs.statSync(pluginDir).mode & 0o777).toString(8)).toBe("755");
      expect((fs.statSync(pluginFile).mode & 0o777).toString(8)).toBe("644");
      expect((fs.statSync(nestedPluginDir).mode & 0o777).toString(8)).toBe("755");
      expect((fs.statSync(nestedPluginFile).mode & 0o777).toString(8)).toBe("644");
      expect((fs.statSync(gatewayControlPath).mode & 0o777).toString(8)).toBe("700");
      expect((fs.statSync(gatewaySupervisorPath).mode & 0o777).toString(8)).toBe("444");
      expect((fs.statSync(startupDirectory).mode & 0o777).toString(8)).toBe("755");
      expect((fs.statSync(startupModulePath).mode & 0o777).toString(8)).toBe("444");
      expect((fs.statSync(configGuardPath).mode & 0o777).toString(8)).toBe("500");
      expect((fs.statSync(managedGatewayControlPath).mode & 0o777).toString(8)).toBe("500");
      expect((fs.statSync(managedGatewayProfilePath).mode & 0o777).toString(8)).toBe("400");
    } finally {
      // The fixture intentionally starts this directory without search permission.
      // Restore it even when the replayed Docker command fails so cleanup cannot
      // hide the original assertion.
      try {
        fs.chmodSync(startupDirectory, 0o755);
      } catch {
        // It may already have been removed by a successful cleanup path.
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
