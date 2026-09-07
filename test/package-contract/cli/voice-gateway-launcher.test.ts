// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import {
  buildVoiceGatewayLaunchContract,
  type VoiceGatewayLauncherDependencies,
} from "../../../dist/lib/voice-gateway/launcher";
import { runVoiceGatewayLaunch } from "../../../dist/lib/actions/voice-gateway/launch";
import { installHarnessPackage } from "../../../dist/lib/agent-runtime/package/install";
import { getBuildIdentity } from "../../../dist/lib/core/build-identity";
import {
  openFileTargets,
  requestSession,
  reserveLoopbackPort,
  stopGateway,
  VOICE_GATEWAY_PROCESS_CONTRACT_TIMEOUT_MS,
  waitForGatewayListening,
} from "../../fixtures/voice-gateway/process-launcher";
import { PinnedVoiceRuntimeAdapter } from "../../fixtures/voice-gateway/pinned-runtime-adapter";
import { describe, expect, test } from "../../helpers/owned-test-resources";

const DEPLOYMENT_BEARER = "deployment-bearer-for-process-contract";
const ROTATED_DEPLOYMENT_BEARER = "rotated-deployment-bearer-for-process-contract";
const SECURE_PACKAGE_TEST_PARENT = path.join(
  process.cwd(),
  "node_modules/.cache/nemoclaw-voice-package-contract",
);
fs.mkdirSync(SECURE_PACKAGE_TEST_PARENT, { recursive: true, mode: 0o700 });

function semanticAuthority() {
  return Object.freeze({
    sandboxName: "repository-fixture",
    packageIdentity: Object.freeze({
      kind: "agent-runtime" as const,
      id: "openclaw",
      packageVersion: "1.2.3",
      contentDigest: "a".repeat(64),
    }),
    declaration: Object.freeze({
      support: "managed" as const,
      command: Object.freeze(["/usr/local/bin/openclaw-semantic-turn"]),
      timeout_seconds: 120,
      protocol: "semantic-turn-ndjson" as const,
    }),
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    lifecycleGeneration: "generation-one",
    lifecycleLiveIdentityFingerprint: "b".repeat(64),
  });
}

function launcherDependencies(home: string): VoiceGatewayLauncherDependencies {
  return {
    env: { HOME: home, PATH: process.env.PATH },
    resolveOpenShell: () => process.execPath,
    resolveSemanticTurnAuthority: semanticAuthority,
  };
}

describe("voice gateway process launch contract", () => {
  test(
    "maps fixed descriptors, closes them before serving, and rotates on restart (#9235)",
    async ({ resources }) => {
      const directory = resources.temporaryDirectory("nemoclaw-voice-process-");
      const deploymentCredentialPath = path.join(directory, "deployment");
      fs.writeFileSync(deploymentCredentialPath, DEPLOYMENT_BEARER, { mode: 0o600 });
      const listenPort = await reserveLoopbackPort();
      const options = {
        deploymentCredentialPath,
        runtimeIdentity: "voice-runtime-local",
        runtimeProfile: "voice-runtime-pinned",
        sandbox: "repository-fixture",
        agent: "main",
        listenPort,
      };
      const dependencies = launcherDependencies(directory);
      const contract = buildVoiceGatewayLaunchContract(options, {
        openshellBinary: process.execPath,
        semanticTurn: semanticAuthority(),
        sourceEnv: dependencies.env ?? {},
      });

      expect(JSON.stringify(contract)).not.toContain(deploymentCredentialPath);
      expect(JSON.stringify(contract)).not.toContain(DEPLOYMENT_BEARER);

      const first = resources.ownChild(await runVoiceGatewayLaunch(options, dependencies));
      await waitForGatewayListening(first);
      expect(openFileTargets(first.pid!)).not.toContain(deploymentCredentialPath);
      expect(await requestSession(listenPort, DEPLOYMENT_BEARER)).toMatchObject({ status: 201 });
      await stopGateway(first);

      fs.writeFileSync(deploymentCredentialPath, ROTATED_DEPLOYMENT_BEARER, { mode: 0o600 });
      const second = resources.ownChild(await runVoiceGatewayLaunch(options, dependencies));
      await waitForGatewayListening(second);
      expect(openFileTargets(second.pid!)).not.toContain(deploymentCredentialPath);
      expect(await requestSession(listenPort, DEPLOYMENT_BEARER)).toEqual({
        status: 401,
        body: '{"error":"authentication_failed"}',
      });
      expect(await requestSession(listenPort, ROTATED_DEPLOYMENT_BEARER)).toMatchObject({
        status: 201,
      });
      await stopGateway(second);
    },
    VOICE_GATEWAY_PROCESS_CONTRACT_TIMEOUT_MS,
  );

  test(
    "commits through a custom gateway registry and a user-local OpenShell executable",
    async ({ resources }) => {
      // The package store rejects a symlink anywhere in its authority path. macOS exposes its
      // system temporary directory through /var, which is a symlink, so this process-boundary
      // fixture intentionally lives under the checkout's private ignored cache.
      const home = resources.ownDirectory(
        fs.mkdtempSync(path.join(SECURE_PACKAGE_TEST_PARENT, "home-")),
      );
      const deploymentCredentialPath = path.join(home, "deployment");
      fs.writeFileSync(deploymentCredentialPath, DEPLOYMENT_BEARER, { mode: 0o600 });
      const openshellBinary = path.join(home, ".local", "bin", "openshell");
      fs.mkdirSync(path.dirname(openshellBinary), { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        openshellBinary,
        [
          "#!/bin/sh",
          "cat >/dev/null",
          "printf '%s\\n' '{\"type\":\"started\"}'",
          'printf \'%s\\n\' \'{"type":"text","text":"package turn completed"}\'',
          "printf '%s\\n' '{\"type\":\"completed\"}'",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const installed = installHarnessPackage(
        {
          packageRoot: path.join(process.cwd(), "dist", "harnesses", "nemoclaw-openclaw"),
          sourceIdentity: {
            kind: "bundled",
            nemoclawBuildIdentity: getBuildIdentity({ rootDir: process.cwd() }),
          },
        },
        { storeRoot: path.join(home, ".nemoclaw", "harnesses") },
      );
      const gatewayPort = 19080;
      const entry = {
        name: "repository-fixture",
        createdAt: "2026-09-07T00:00:00.000Z",
        agent: "openclaw",
        harnessPackage: installed.identity,
        gatewayName: `nemoclaw-${String(gatewayPort)}`,
        gatewayPort,
        lifecycleGeneration: "generation-one",
        lifecycleLiveIdentityFingerprint: "b".repeat(64),
      };
      const registryDirectory = path.join(home, ".nemoclaw", "gateways", String(gatewayPort));
      fs.mkdirSync(registryDirectory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        path.join(registryDirectory, "sandboxes.json"),
        `${JSON.stringify({ sandboxes: { [entry.name]: entry }, defaultSandbox: entry.name })}\n`,
        { mode: 0o600 },
      );
      const authority = {
        ...semanticAuthority(),
        packageIdentity: installed.identity,
        gatewayName: entry.gatewayName,
        gatewayPort,
        lifecycleGeneration: entry.lifecycleGeneration,
        lifecycleLiveIdentityFingerprint: entry.lifecycleLiveIdentityFingerprint,
      };
      const dependencies: VoiceGatewayLauncherDependencies = {
        env: {
          HOME: home,
          PATH: "/usr/bin:/bin",
          XDG_CONFIG_HOME: path.join(home, ".config"),
          OPENSHELL_WORKSPACE: path.join(home, ".openshell"),
        },
        resolveOpenShell: () => openshellBinary,
        resolveSemanticTurnAuthority: () => authority,
      };
      const listenPort = await reserveLoopbackPort();
      const child = resources.ownChild(
        await runVoiceGatewayLaunch(
          {
            deploymentCredentialPath,
            runtimeIdentity: "voice-runtime-local",
            runtimeProfile: "voice-runtime-pinned",
            sandbox: entry.name,
            agent: "main",
            listenPort,
          },
          dependencies,
        ),
      );
      await waitForGatewayListening(child);
      const output: string[] = [];
      const runtime = new PinnedVoiceRuntimeAdapter(listenPort, DEPLOYMENT_BEARER, (text) =>
        output.push(text),
      );

      const session = await runtime.createSession("process-contract");
      const events = await runtime.commitTurn(session, "commit-one", "repository status");
      await runtime.closeSession(session);

      expect(output).toEqual(["package turn completed"]);
      expect(events.map((event) => (event as { readonly type: string }).type)).toEqual([
        "response.started",
        "response.text.delta",
        "response.completed",
      ]);
      await stopGateway(child);
    },
    VOICE_GATEWAY_PROCESS_CONTRACT_TIMEOUT_MS,
  );
});
