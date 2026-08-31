// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { dockerRunCommandBetween, runLoggedDockerShell } from "../helpers/docker-shell";
import { hermesStartupModuleNames } from "../helpers/shell-harness";
import {
  copyRlimitFixture,
  expectSystemRlimitHookEnforcesLimits,
  expectSystemRlimitHookIsSilentWhenVerificationFails,
  rlimitShim,
} from "../helpers/rlimit-hooks";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const HERMES_DOCKERFILE = path.join(PACKAGE_ROOT, "Dockerfile");

describe("sandbox rlimit system hooks (#2173)", () => {
  it("stale Hermes base replay removes OpenClaw preloads and preserves effective connect-shell rlimit hooks", () => {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-rlimit-hooks-"));
    const localLib = path.join(tmp, "lib");
    const hermesStartupDir = path.join(localLib, "hermes-startup");
    const hermesStartupPaths = hermesStartupModuleNames.map((moduleName) =>
      path.join(hermesStartupDir, `${moduleName}.sh`),
    );
    const profileHook = path.join(tmp, "profile.d", "nemoclaw-rlimits.sh");
    const rlimitLib = path.join(localLib, "sandbox-rlimits.sh");
    const initLib = path.join(localLib, "sandbox-init.sh");
    const validator = path.join(localLib, "validate-hermes-env-secret-boundary.py");
    const sessionListPreviewPatcher = path.join(localLib, "patch-hermes-session-list-preview.py");
    const sqliteTempStorePatcher = path.join(localLib, "patch-hermes-sqlite-temp-store.py");
    const discordRecoveryPatcher = path.join(
      localLib,
      "patch-hermes-discord-recovery-permissions.py",
    );
    const profilePolicyPatcher = path.join(localLib, "patch-hermes-profile-policy-defaults.py");
    const managedPolicyReader = path.join(localLib, "managed_policy.py");
    const langfuseCredentialPatcher = path.join(localLib, "patch-hermes-langfuse-credentials.mts");
    const dashboardSeeder = path.join(localLib, "seed-hermes-dashboard-config.py");
    const runtimeGuard = path.join(localLib, "hermes-runtime-config-guard.py");
    const tirithMarkerFinalizer = path.join(localLib, "finalize-tirith-marker.py");
    const buildMcpDigest = path.join(localLib, "build-hermes-mcp-digest.py");
    const mcpTransaction = path.join(localLib, "hermes-mcp-config-transaction.py");
    const mcpCredentialBoundary = path.join(
      localLib,
      "openshell-child-visible-credentials.v0.0.106.json",
    );
    const preloadDir = path.join(localLib, "preloads");
    const safetyNet = path.join(preloadDir, "sandbox-safety-net.js");
    const ciaoGuard = path.join(preloadDir, "ciao-network-guard.js");
    const gatewaySupervisor = path.join(localLib, "gateway-supervisor.sh");
    const stateDirGuard = path.join(localLib, "state-dir-guard.py");
    const runtimeStateMutationControl = path.join(localLib, "runtime-state-mutation-control.py");
    const runtimeStateMutationTransportBroker = path.join(
      localLib,
      "runtime-state-mutation-transport-broker.py",
    );
    const runtimeStateMutationStartupGate = path.join(
      localLib,
      "runtime-state-mutation-startup-gate.py",
    );
    const runtimeStateMutationPublisher = path.join(
      localLib,
      "runtime_state_mutation_hermes_publisher.py",
    );
    const stateLockPlan = path.join(tmp, "state-lock-plan.json");
    const runtimeStateMutationCapability = path.join(
      tmp,
      "runtime-state-mutation-publisher-v1.json",
    );
    const managedGatewayControl = path.join(localLib, "managed-gateway-control.py");
    const hermesCronRestoreControl = path.join(localLib, "hermes-cron-restore-control.py");
    const startBin = path.join(tmp, "nemoclaw-start");
    const managedStartupHold = path.join(tmp, "nemoclaw-managed-startup-hold");
    const managedBootstrap = path.join(tmp, "nemoclaw-managed-bootstrap");
    const gatewayControl = path.join(tmp, "nemoclaw-gateway-control");
    const corporateCaRuntime = path.join(localLib, "corporate-ca-runtime.sh");
    const entrypointEnvWrapper = path.join(localLib, "entrypoint-env-wrapper.sh");
    const bashrc = path.join(tmp, "bash.bashrc");
    const expectedRlimitShim = rlimitShim(rlimitLib);

    try {
      fs.mkdirSync(localLib, { recursive: true });
      fs.mkdirSync(hermesStartupDir, { recursive: true });
      fs.mkdirSync(path.dirname(profileHook), { recursive: true });
      hermesStartupPaths.forEach((modulePath) => {
        fs.writeFileSync(modulePath, "# startup module fixture\n");
      });
      copyRlimitFixture(rlimitLib);
      fs.writeFileSync(initLib, "# init fixture\n");
      fs.writeFileSync(validator, "# validator fixture\n");
      fs.writeFileSync(sessionListPreviewPatcher, "# session list preview patcher fixture\n");
      fs.writeFileSync(sqliteTempStorePatcher, "# SQLite temp store patcher fixture\n");
      fs.writeFileSync(discordRecoveryPatcher, "# Discord recovery patcher fixture\n");
      fs.writeFileSync(profilePolicyPatcher, "# profile policy patcher fixture\n");
      fs.writeFileSync(managedPolicyReader, "# managed policy reader fixture\n");
      fs.writeFileSync(langfuseCredentialPatcher, "# Langfuse credential patcher fixture\n");
      fs.writeFileSync(dashboardSeeder, "# dashboard seeder fixture\n");
      fs.writeFileSync(runtimeGuard, "# runtime guard fixture\n");
      fs.writeFileSync(tirithMarkerFinalizer, "# Tirith marker finalizer fixture\n");
      fs.writeFileSync(buildMcpDigest, "# build MCP digest fixture\n");
      fs.writeFileSync(mcpTransaction, "# MCP transaction fixture\n");
      fs.writeFileSync(mcpCredentialBoundary, "{}\n");
      fs.mkdirSync(preloadDir, { mode: 0o777 });
      fs.writeFileSync(safetyNet, "module.exports = 'safety net fixture';\n", { mode: 0o666 });
      fs.writeFileSync(ciaoGuard, "module.exports = 'ciao guard fixture';\n", { mode: 0o666 });
      fs.chmodSync(preloadDir, 0o777);
      fs.chmodSync(safetyNet, 0o666);
      fs.chmodSync(ciaoGuard, 0o666);
      fs.writeFileSync(gatewaySupervisor, "# gateway supervisor fixture\n");
      fs.writeFileSync(stateDirGuard, "# state-dir guard fixture\n");
      fs.writeFileSync(runtimeStateMutationControl, "# runtime mutation control fixture\n");
      fs.writeFileSync(
        runtimeStateMutationTransportBroker,
        "# runtime mutation transport broker fixture\n",
      );
      fs.writeFileSync(runtimeStateMutationStartupGate, "# runtime mutation gate fixture\n");
      fs.writeFileSync(runtimeStateMutationPublisher, "# runtime mutation publisher fixture\n");
      fs.writeFileSync(stateLockPlan, "{}\n");
      fs.writeFileSync(runtimeStateMutationCapability, "{}\n");
      fs.writeFileSync(managedGatewayControl, "# managed gateway control fixture\n");
      fs.writeFileSync(hermesCronRestoreControl, "# Hermes cron restore control fixture\n");
      fs.writeFileSync(startBin, "#!/usr/bin/env bash\n");
      fs.writeFileSync(managedStartupHold, "#!/usr/bin/env bash\n");
      fs.writeFileSync(managedBootstrap, "#!/usr/bin/env bash\n");
      fs.writeFileSync(gatewayControl, "#!/usr/bin/env sh\n");
      fs.writeFileSync(corporateCaRuntime, "# corporate CA runtime fixture\n");
      fs.writeFileSync(entrypointEnvWrapper, "# entrypoint env wrapper fixture\n");
      fs.writeFileSync(bashrc, "# stale hermes bashrc\n");
      const fixtureOwner = fs.statSync(startBin);
      const replay = dockerRunCommandBetween(
        dockerfile,
        "# Apply runtime modes to the startup script and secret-boundary validator.",
        "# Wrap the hermes CLI",
      )
        .replaceAll("/usr/local/lib/nemoclaw/hermes-startup", hermesStartupDir)
        .replaceAll("/usr/local/bin/nemoclaw-start", startBin)
        .replaceAll("/usr/local/bin/nemoclaw-managed-startup-hold", managedStartupHold)
        .replaceAll("/usr/local/bin/nemoclaw-managed-bootstrap", managedBootstrap)
        .replaceAll("/usr/local/bin/nemoclaw-gateway-control", gatewayControl)
        .replaceAll("/usr/local/lib/nemoclaw/corporate-ca-runtime.sh", corporateCaRuntime)
        .replaceAll("/usr/local/lib/nemoclaw/entrypoint-env-wrapper.sh", entrypointEnvWrapper)
        .replaceAll("/usr/local/lib/nemoclaw/sandbox-init.sh", initLib)
        .replaceAll("/usr/local/lib/nemoclaw/gateway-supervisor.sh", gatewaySupervisor)
        .replaceAll("/usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py", validator)
        .replaceAll(
          "/usr/local/lib/nemoclaw/patch-hermes-session-list-preview.py",
          sessionListPreviewPatcher,
        )
        .replaceAll(
          "/usr/local/lib/nemoclaw/patch-hermes-sqlite-temp-store.py",
          sqliteTempStorePatcher,
        )
        .replaceAll(
          "/usr/local/lib/nemoclaw/patch-hermes-discord-recovery-permissions.py",
          discordRecoveryPatcher,
        )
        .replaceAll(
          "/usr/local/lib/nemoclaw/patch-hermes-profile-policy-defaults.py",
          profilePolicyPatcher,
        )
        .replaceAll("/usr/local/lib/nemoclaw/managed_policy.py", managedPolicyReader)
        .replaceAll(
          "/usr/local/lib/nemoclaw/patch-hermes-langfuse-credentials.mts",
          langfuseCredentialPatcher,
        )
        .replaceAll("/usr/local/lib/nemoclaw/seed-hermes-dashboard-config.py", dashboardSeeder)
        .replaceAll("/usr/local/lib/nemoclaw/hermes-runtime-config-guard.py", runtimeGuard)
        .replaceAll("/usr/local/lib/nemoclaw/finalize-tirith-marker.py", tirithMarkerFinalizer)
        .replaceAll("/usr/local/lib/nemoclaw/build-hermes-mcp-digest.py", buildMcpDigest)
        .replaceAll("/usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py", mcpTransaction)
        .replaceAll(
          "/usr/local/lib/nemoclaw/openshell-child-visible-credentials.v0.0.106.json",
          mcpCredentialBoundary,
        )
        .replaceAll("/usr/local/lib/nemoclaw/preloads/sandbox-safety-net.js", safetyNet)
        .replaceAll("/usr/local/lib/nemoclaw/preloads/ciao-network-guard.js", ciaoGuard)
        .replaceAll("/usr/local/lib/nemoclaw/preloads", preloadDir)
        .replaceAll("/usr/local/lib/nemoclaw/state-dir-guard.py", stateDirGuard)
        .replaceAll(
          "/usr/local/lib/nemoclaw/runtime-state-mutation-control.py",
          runtimeStateMutationControl,
        )
        .replaceAll(
          "/usr/local/lib/nemoclaw/runtime-state-mutation-transport-broker.py",
          runtimeStateMutationTransportBroker,
        )
        .replaceAll(
          "/usr/local/lib/nemoclaw/runtime-state-mutation-startup-gate.py",
          runtimeStateMutationStartupGate,
        )
        .replaceAll(
          "/usr/local/lib/nemoclaw/runtime_state_mutation_hermes_publisher.py",
          runtimeStateMutationPublisher,
        )
        .replaceAll("/usr/local/share/nemoclaw/state-lock-plan.json", stateLockPlan)
        .replaceAll(
          "/usr/local/share/nemoclaw/runtime-state-mutation-publisher-v1.json",
          runtimeStateMutationCapability,
        )
        .replaceAll("/opt/hermes/.venv/bin/python3", "python3")
        .replaceAll("/usr/local/lib/nemoclaw/managed-gateway-control.py", managedGatewayControl)
        .replaceAll(
          "/usr/local/lib/nemoclaw/hermes-cron-restore-control.py",
          hermesCronRestoreControl,
        )
        .replaceAll("/usr/local/lib/nemoclaw/sandbox-rlimits.sh", rlimitLib)
        .replaceAll("/etc/profile.d/nemoclaw-rlimits.sh", profileHook)
        .replaceAll("/etc/profile.d", path.dirname(profileHook))
        .replaceAll("/etc/bash.bashrc", bashrc);
      // The Docker image has a root:root group contract. macOS names gid 0
      // "wheel", so stub chown while preserving every chmod and hook write.
      const command = ["chown() { :; }", replay].join("\n");

      const { result } = runLoggedDockerShell(command, tmp);
      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(profileHook, "utf-8")).toContain(expectedRlimitShim);
      expect(fs.readFileSync(bashrc, "utf-8")).toContain(expectedRlimitShim);
      expectSystemRlimitHookEnforcesLimits(profileHook);
      expectSystemRlimitHookEnforcesLimits(bashrc);
      expectSystemRlimitHookIsSilentWhenVerificationFails(bashrc, rlimitLib);
      expect(fs.existsSync(preloadDir)).toBe(false);
      expect(fs.statSync(hermesStartupDir).mode & 0o777).toBe(0o555);
      expect(hermesStartupPaths.map((modulePath) => fs.statSync(modulePath).mode & 0o777)).toEqual(
        hermesStartupPaths.map(() => 0o444),
      );
      expect(fs.statSync(discordRecoveryPatcher).mode & 0o777).toBe(0o755);
      expect(fs.statSync(profilePolicyPatcher).mode & 0o777).toBe(0o755);
      expect(fs.statSync(langfuseCredentialPatcher).mode & 0o777).toBe(0o444);
      expect(fs.statSync(mcpCredentialBoundary).mode & 0o777).toBe(0o444);
      expect(fs.statSync(buildMcpDigest).mode & 0o777).toBe(0o444);
      expect(fs.statSync(runtimeStateMutationControl).mode & 0o777).toBe(0o500);
      expect(fs.statSync(runtimeStateMutationTransportBroker).mode & 0o777).toBe(0o500);
      expect(fs.statSync(runtimeStateMutationStartupGate).mode & 0o777).toBe(0o555);
      expect(fs.statSync(runtimeStateMutationPublisher).mode & 0o777).toBe(0o500);
      expect(fs.statSync(stateLockPlan).mode & 0o777).toBe(0o444);
      expect(fs.statSync(runtimeStateMutationCapability).mode & 0o777).toBe(0o444);
      expect(fs.statSync(hermesCronRestoreControl).mode & 0o777).toBe(0o700);
    } finally {
      fs.existsSync(hermesStartupDir) && fs.chmodSync(hermesStartupDir, 0o700);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
