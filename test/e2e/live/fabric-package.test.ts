// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { assertExitZero, outputContainsSandbox, resultText } from "../fixtures/clients/command.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { createIsolatedTestRuntime } from "../fixtures/environment-profiles.ts";
import { trackIsolatedGatewayCleanup } from "../fixtures/gateway-cleanup.ts";
import {
  harnessPackageIdentitiesEqual,
  installHarnessPackage,
  parseHarnessPackageIdentity,
  type HarnessPackageIdentity,
} from "../fixtures/harness-package.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import { readRegistrySandboxEntry } from "../fixtures/phases/index.ts";
import {
  hasFabricPackageE2eTarget,
  readFabricPackageE2eTarget,
} from "../../../tools/e2e/fabric-contract.mts";
import { runPublicFabricTurn } from "./public-fabric-turn.ts";

const COMMAND_TIMEOUT_MS = 3 * 60_000;
const ONBOARD_TIMEOUT_MS = 25 * 60_000;
const FABRIC_PACKAGE_PHASES = [
  "verify local package and runtime prerequisites",
  "install and inspect the receipt-backed harness package",
  "onboard the package-owned sandbox",
  "run the public Fabric agent turn",
  "restart the sandbox and repeat the Fabric turn",
  "destroy the sandbox and verify absence",
  "record Fabric package journey evidence",
] as const;

function requireRecordedPackageIdentity(
  sandboxName: string,
  expected: HarnessPackageIdentity,
  registryPath: string,
): HarnessPackageIdentity {
  const recorded = parseHarnessPackageIdentity(
    readRegistrySandboxEntry(sandboxName, { registryPath }).harnessPackage,
  );
  expect(
    harnessPackageIdentitiesEqual(recorded, expected),
    "sandbox registry must retain the installed harness package identity",
  ).toBe(true);
  return recorded;
}

function requireEmptyHarnessInventory(source: string): void {
  expect(JSON.parse(source)).toEqual(expect.objectContaining({ installed: [] }));
}

test.skipIf(!hasFabricPackageE2eTarget())(
  "fabric-package",
  {
    timeout: 50 * 60_000,
    meta: {
      e2eArtifactRootId: "fabric-package",
      e2eCleanupTimeoutMs: 10 * 60_000,
      e2ePhases: FABRIC_PACKAGE_PHASES,
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox, secrets }) => {
    const target = readFabricPackageE2eTarget();
    const inference = requireHostedInferenceConfig(secrets);
    const redactionValues = [inference.apiKey];
    const runtime = createIsolatedTestRuntime(".nemoclaw-fabric-package-home-");
    const registryPath = path.join(runtime.stateRoot, "sandboxes.json");
    const env = runtime.environment({
      ...inference.env,
      NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
      NEMOCLAW_AGENT: target.contract.packageId,
      NEMOCLAW_NON_INTERACTIVE: "1",
      NEMOCLAW_RECREATE_SANDBOX: "1",
      NEMOCLAW_SANDBOX_GPU: "0",
      NEMOCLAW_SANDBOX_NAME: target.sandboxName,
    });

    trackIsolatedGatewayCleanup(cleanup, host, {
      artifactName: `cleanup-fabric-${target.contract.packageId}-gateway`,
      environment: env,
      gatewayName: runtime.gatewayName,
      gatewayPort: runtime.gatewayPort,
      home: runtime.home,
      redactionValues,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });

    await artifacts.target.declare({
      id: target.contract.packageId,
      contract: [
        "the public CLI installs and lists one exact receipt-backed harness package",
        "the installed package onboards from its package-owned Dockerfile",
        "the public agent command dispatches through the package-owned Fabric adapter",
        "the package receipt and Fabric turn survive a sandbox stop and start",
        "destroy removes the sandbox from NemoClaw and OpenShell inventory",
      ],
      adapterId: target.contract.adapterId,
      sandboxName: target.sandboxName,
    });

    progress.phase("verify local package and runtime prerequisites");
    await host.expectNemoclawAvailable();
    await runtimeProvider.requireAvailable({
      artifactName: `fabric-${target.contract.packageId}-runtime-info`,
      scenarioLabel: `${target.contract.packageId} Fabric package`,
    });
    await host.cleanupSandbox(target.sandboxName, { env, timeoutMs: COMMAND_TIMEOUT_MS });
    cleanup.trackSandbox(host, target.sandboxName, { env, timeoutMs: 10 * 60_000 });

    progress.phase("install and inspect the receipt-backed harness package");
    const initialInventory = await host.nemoclaw(["harness", "list", "--json"], {
      artifactName: `fabric-${target.contract.packageId}-initial-harness-list`,
      env,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    assertExitZero(initialInventory, "list initial isolated harness inventory");
    requireEmptyHarnessInventory(initialInventory.stdout);
    const installation = await installHarnessPackage(host, target.contract.packageId, env);

    progress.phase("onboard the package-owned sandbox");
    const onboard = await host.nemoclaw(
      ["onboard", "--fresh", "--non-interactive", "--yes", "--yes-i-accept-third-party-software"],
      {
        artifactName: `fabric-${target.contract.packageId}-onboard`,
        env,
        redactionValues,
        timeoutMs: ONBOARD_TIMEOUT_MS,
      },
    );
    assertExitZero(onboard, `${target.contract.packageId} onboarding`);
    await host.expectListed(target.sandboxName, { env });
    await host.expectStatus(target.sandboxName, { env, timeoutMs: COMMAND_TIMEOUT_MS });
    await sandbox.expectListed(target.sandboxName, { env, timeoutMs: COMMAND_TIMEOUT_MS });
    const onboardReceipt = requireRecordedPackageIdentity(
      target.sandboxName,
      installation.identity,
      registryPath,
    );

    progress.phase("run the public Fabric agent turn");
    const onboardTurn = await runPublicFabricTurn({
      artifacts,
      contract: target.contract,
      env,
      host,
      lifecyclePhase: "after-onboard",
      redactionValues,
      sandbox,
      sandboxName: target.sandboxName,
    });

    progress.phase("restart the sandbox and repeat the Fabric turn");
    const stop = await host.nemoclaw([target.sandboxName, "stop"], {
      artifactName: `fabric-${target.contract.packageId}-stop`,
      env,
      redactionValues,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    assertExitZero(stop, `${target.contract.packageId} stop`);
    const start = await host.nemoclaw([target.sandboxName, "start"], {
      artifactName: `fabric-${target.contract.packageId}-start`,
      env,
      redactionValues,
      timeoutMs: 10 * 60_000,
    });
    assertExitZero(start, `${target.contract.packageId} start`);
    await host.expectStatus(target.sandboxName, { env, timeoutMs: COMMAND_TIMEOUT_MS });
    await sandbox.expectListed(target.sandboxName, { env, timeoutMs: COMMAND_TIMEOUT_MS });
    const restartedReceipt = requireRecordedPackageIdentity(
      target.sandboxName,
      installation.identity,
      registryPath,
    );
    const restartedTurn = await runPublicFabricTurn({
      artifacts,
      contract: target.contract,
      env,
      host,
      lifecyclePhase: "after-sandbox-restart",
      redactionValues,
      sandbox,
      sandboxName: target.sandboxName,
    });

    progress.phase("destroy the sandbox and verify absence");
    const destroy = await host.destroySandbox(target.sandboxName, {
      artifactName: `fabric-${target.contract.packageId}-destroy`,
      env,
      timeoutMs: 10 * 60_000,
    });
    assertExitZero(destroy, `${target.contract.packageId} destroy`);
    await sandbox.expectAbsent(target.sandboxName, {
      artifactName: `fabric-${target.contract.packageId}-openshell-list-after-destroy`,
      env,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    const listAfterDestroy = await host.nemoclaw(["list"], {
      artifactName: `fabric-${target.contract.packageId}-list-after-destroy`,
      env,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    assertExitZero(listAfterDestroy, "list sandboxes after Fabric package destroy");
    expect(
      outputContainsSandbox(listAfterDestroy, target.sandboxName),
      resultText(listAfterDestroy),
    ).toBe(false);

    progress.phase("record Fabric package journey evidence");
    await artifacts.target.complete({
      id: target.contract.packageId,
      adapterId: target.contract.adapterId,
      installedIdentity: installation.identity,
      lifecycle: ["onboard", "turn", "stop", "start", "turn", "destroy"],
      onboardReceipt,
      onboardTurn,
      restartedReceipt,
      restartedTurn,
      sandboxAbsent: true,
    });
  },
);
