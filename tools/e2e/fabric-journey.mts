// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ArtifactSink } from "../../test/e2e/fixtures/artifacts.ts";
import {
  cleanupIsolatedGateway,
  type IsolatedGatewayCleanupOptions,
  requireIsolatedGatewayAvailable,
} from "../../test/e2e/fixtures/gateway-cleanup.ts";
import {
  harnessPackageIdentitiesEqual,
  installHarnessPackage,
  parseHarnessPackageIdentity,
  type HarnessPackageIdentity,
} from "../../test/e2e/fixtures/harness-package.ts";
import {
  HARNESS_LIFECYCLE_REVISION_MARKER_PATH,
  prepareHarnessPackageUpgrade,
  requireHarnessPackageActivation,
  requireHarnessPackageDeactivation,
  requireHarnessPackageUpgrade,
} from "../../test/e2e/fixtures/harness-lifecycle.ts";
import { startTestProgress } from "../../test/e2e/fixtures/progress.ts";
import { redactString } from "../../test/e2e/fixtures/redaction.ts";
import * as riskSignalModule from "./risk-signal.ts";
import type { RiskSignalEnvironment } from "./risk-signal.ts";
import {
  requireFabricPackageArtifactE2eBinding,
  requireInstalledFabricE2eBinding,
  type FabricPackageE2eTarget,
} from "./fabric-contract.mts";
import {
  LiveCommandRunner,
  LiveHostClient,
  liveOutputContainsSandbox as outputContainsSandbox,
  liveResultText as resultText,
  LiveSandboxClient,
  requireLiveCommandSuccess as assertExitZero,
} from "./live-client.mts";
import { createPrivateFabricRuntime } from "./private-runtime.mts";
import { runPublicFabricTurn } from "./fabric-turn.mts";

const COMMAND_TIMEOUT_MS = 3 * 60_000;
const ONBOARD_TIMEOUT_MS = 25 * 60_000;
const FABRIC_PACKAGE_PHASES = [
  "verify local package and runtime prerequisites",
  "install and inspect the receipt-backed harness package",
  "onboard the package-owned sandbox",
  "run the public Fabric agent turn",
  "upgrade the active package while the sandbox stays pinned",
  "onboard the upgraded receipt and run its Fabric turn",
  "roll back the active package and prove both pinned receipts",
  "deactivate the package and restart the pinned sandbox",
  "destroy the sandbox and verify absence",
  "record Fabric package journey evidence",
] as const;

type RiskSignalApi = Pick<
  typeof import("./risk-signal.ts"),
  "configuredRiskSignalEnvironment" | "writeRiskSignalCounts"
>;

function hasRiskSignalApi(value: object): value is RiskSignalApi {
  return (
    typeof Reflect.get(value, "configuredRiskSignalEnvironment") === "function" &&
    typeof Reflect.get(value, "writeRiskSignalCounts") === "function"
  );
}

function resolveRiskSignalApi(): RiskSignalApi {
  if (hasRiskSignalApi(riskSignalModule)) return riskSignalModule;
  const defaultExport = Reflect.get(riskSignalModule, "default");
  if (typeof defaultExport === "object" && defaultExport && hasRiskSignalApi(defaultExport)) {
    return defaultExport;
  }
  throw new Error("Fabric package E2E could not load its risk-signal writer");
}

const { configuredRiskSignalEnvironment, writeRiskSignalCounts } = resolveRiskSignalApi();

type CleanupAction = {
  readonly label: string;
  readonly run: () => Promise<void> | void;
};

type CleanupEvidence = {
  readonly actions: readonly { label: string; status: "passed" | "failed" }[];
  readonly failures: readonly string[];
};

type JourneyEvidence = Record<string, unknown> & {
  readonly adapterId: string;
  readonly id: string;
  readonly journey: "smoke" | "lifecycle";
  readonly sandboxAbsent: true;
};

export interface TestedNemoClawCliIdentity {
  readonly contentSha256: string;
  readonly path: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Add hosted inference credentials only to the onboarding process that persists them. */
export function buildFabricOnboardingEnvironment(
  controlEnvironment: NodeJS.ProcessEnv,
  inferenceEnvironment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return { ...controlEnvironment, ...inferenceEnvironment };
}

function currentCommit(repositoryRoot: string): string {
  return execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  }).trim();
}

/** Bind execution to the regular CLI file in the checkout being attested. */
export function requireTestedNemoClawCli(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
): TestedNemoClawCliIdentity {
  let expectedPath: string;
  try {
    expectedPath = fs.realpathSync(path.join(repositoryRoot, "bin", "nemoclaw.js"));
  } catch {
    throw new Error("Fabric package E2E requires the tested checkout's NemoClaw CLI");
  }
  const metadata = fs.lstatSync(expectedPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Fabric package E2E requires the tested checkout's regular NemoClaw CLI");
  }
  const configured = environment.NEMOCLAW_CLI_BIN?.trim();
  if (configured) {
    let configuredPath: string;
    try {
      if (!path.isAbsolute(configured)) throw new Error("relative CLI path");
      configuredPath = fs.realpathSync(configured);
    } catch {
      throw new Error("NEMOCLAW_CLI_BIN must resolve to the tested checkout's NemoClaw CLI");
    }
    if (configuredPath !== expectedPath) {
      throw new Error("NEMOCLAW_CLI_BIN must resolve to the tested checkout's NemoClaw CLI");
    }
  }
  return Object.freeze({
    contentSha256: createHash("sha256").update(fs.readFileSync(expectedPath)).digest("hex"),
    path: expectedPath,
  });
}

export function fabricPackageRunArtifactDirectory(
  artifactRoot: string,
  target: FabricPackageE2eTarget,
  runId: string,
): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(runId)) {
    throw new Error("Fabric package E2E run id must be a lowercase UUID");
  }
  return path.join(
    artifactRoot,
    "fabric-package",
    target.contract.packageId,
    target.journey,
    target.sandboxName,
    runId,
  );
}

export interface FabricJourneyArtifacts {
  readonly packageArtifact: string;
  readonly preparedUpgrade?: ReturnType<typeof prepareHarnessPackageUpgrade>;
  readonly upgradePackageArtifact?: string;
}

/** Keep the caller's source exact and generate only the optional test upgrade. */
export function prepareFabricJourneyArtifacts(
  target: FabricPackageE2eTarget,
  runtimeHome: string,
): FabricJourneyArtifacts {
  if (target.journey !== "lifecycle" || target.upgradePackageArtifact) {
    return Object.freeze({
      packageArtifact: target.packageArtifact,
      ...(target.upgradePackageArtifact
        ? { upgradePackageArtifact: target.upgradePackageArtifact }
        : {}),
    });
  }
  const preparedUpgrade = prepareHarnessPackageUpgrade(
    target.packageArtifact,
    path.join(runtimeHome, "fabric-package-lifecycle-upgrade"),
    target.contract.packageId,
  );
  return Object.freeze({
    packageArtifact: target.packageArtifact,
    preparedUpgrade,
    upgradePackageArtifact: preparedUpgrade.packageRoot,
  });
}

function upgradedSandboxName(sandboxName: string): string {
  const suffix = "-upgraded";
  return `${sandboxName.slice(0, 19 - suffix.length).replace(/-+$/u, "")}${suffix}`;
}

function requireEmptyHarnessInventory(source: string): void {
  let inventory: unknown;
  try {
    inventory = JSON.parse(source);
  } catch {
    throw new Error("Harness inventory did not contain machine-readable JSON");
  }
  const installed = (inventory as { installed?: unknown }).installed;
  if (!Array.isArray(installed) || installed.length !== 0) {
    throw new Error("The isolated Fabric journey did not start with an empty harness inventory");
  }
}

function requireRecordedPackageIdentity(
  sandboxName: string,
  expected: HarnessPackageIdentity,
  registryPath: string,
): HarnessPackageIdentity {
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
    readonly sandboxes?: Readonly<Record<string, { readonly harnessPackage?: unknown }>>;
  };
  const recorded = parseHarnessPackageIdentity(registry.sandboxes?.[sandboxName]?.harnessPackage);
  if (!harnessPackageIdentitiesEqual(recorded, expected)) {
    throw new Error("The sandbox registry did not retain its immutable harness package receipt");
  }
  return recorded;
}

async function runCleanup(actions: CleanupAction[]): Promise<CleanupEvidence> {
  const outcomes: Array<{ label: string; status: "passed" | "failed" }> = [];
  const failures: string[] = [];
  for (const action of actions.reverse()) {
    try {
      await action.run();
      outcomes.push({ label: action.label, status: "passed" });
    } catch (error) {
      outcomes.push({ label: action.label, status: "failed" });
      failures.push(`${action.label}: ${errorMessage(error)}`);
    }
  }
  return Object.freeze({ actions: outcomes, failures });
}

function requireFabricRiskSignalEnvironment(
  artifactDirectory: string,
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
  defaultCorrelationId: string,
): RiskSignalEnvironment {
  const testedSha = currentCommit(repositoryRoot);
  const expectedSha =
    environment.NEMOCLAW_E2E_RISK_SIGNAL_EXPECTED_SHA ??
    environment.NEMOCLAW_E2E_EXPECTED_SHA ??
    testedSha;
  const configured = configuredRiskSignalEnvironment(
    {
      ...environment,
      E2E_ARTIFACT_DIR: artifactDirectory,
      E2E_TARGET_ID: environment.E2E_TARGET_ID ?? "fabric-package",
      NEMOCLAW_E2E_CORRELATION_ID: environment.NEMOCLAW_E2E_CORRELATION_ID ?? defaultCorrelationId,
      NEMOCLAW_E2E_RISK_SIGNAL_EXPECTED_SHA: expectedSha,
      NEMOCLAW_E2E_SHARD: environment.NEMOCLAW_E2E_SHARD ?? "default",
      NEMOCLAW_E2E_TESTED_ROOT: repositoryRoot,
    },
    () => testedSha,
  );
  if (!configured) throw new Error("Fabric package E2E risk signal was not configured");
  return configured;
}

/** Execute one exact package-owned qualification without registering another Vitest target. */
export async function executeFabricPackageJourney(
  target: FabricPackageE2eTarget,
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const apiKey = environment.NVIDIA_INFERENCE_API_KEY;
  if (!apiKey) throw new Error("Fabric package E2E requires NVIDIA_INFERENCE_API_KEY");
  const endpointUrl = environment.NEMOCLAW_ENDPOINT_URL ?? "https://inference-api.nvidia.com/v1";
  const model =
    environment.NEMOCLAW_MODEL ??
    environment.NEMOCLAW_COMPAT_MODEL ??
    "nvidia/nvidia/nemotron-3-ultra";
  const inferenceEnvironment = {
    NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
    NEMOCLAW_PROVIDER: "custom",
    NEMOCLAW_ENDPOINT_URL: endpointUrl,
    NEMOCLAW_MODEL: model,
    NEMOCLAW_COMPAT_MODEL: model,
    NEMOCLAW_PREFERRED_API: environment.NEMOCLAW_PREFERRED_API ?? "openai-completions",
    ...(environment.NEMOCLAW_TRUSTED_PRIVATE_HOSTS
      ? { NEMOCLAW_TRUSTED_PRIVATE_HOSTS: environment.NEMOCLAW_TRUSTED_PRIVATE_HOSTS }
      : {}),
    ...(environment.NEMOCLAW_TRUSTED_PRIVATE_INFERENCE_HOSTS
      ? {
          NEMOCLAW_TRUSTED_PRIVATE_INFERENCE_HOSTS:
            environment.NEMOCLAW_TRUSTED_PRIVATE_INFERENCE_HOSTS,
        }
      : {}),
    NVIDIA_INFERENCE_API_KEY: apiKey,
    COMPATIBLE_API_KEY: apiKey,
  };
  const artifactRoot = path.resolve(
    environment.E2E_ARTIFACT_DIR ?? path.join(repositoryRoot, "e2e-artifacts", "live"),
  );
  const runId = randomUUID();
  const artifactDirectory = fabricPackageRunArtifactDirectory(artifactRoot, target, runId);
  const riskSignalEnvironment = requireFabricRiskSignalEnvironment(
    artifactDirectory,
    repositoryRoot,
    environment,
    runId,
  );
  const artifacts = new ArtifactSink(artifactDirectory, [apiKey]);
  const progress = startTestProgress("fabric-package", FABRIC_PACKAGE_PHASES, {
    targetId: environment.E2E_TARGET_ID ?? `${target.contract.packageId}-fabric`,
    terminalPhase: "release registered E2E resources",
    logLine: (line) => process.stdout.write(`${redactString(line, [apiKey])}\n`),
  });
  const commandRunner = new LiveCommandRunner(artifacts, [apiKey]);
  const testedCli = requireTestedNemoClawCli(repositoryRoot, environment);
  const host = new LiveHostClient(commandRunner, testedCli.path, repositoryRoot);
  const sandbox = new LiveSandboxClient(commandRunner);
  const runtime = createPrivateFabricRuntime(".nemoclaw-fabric-package-home-", environment);
  const registryPath = path.join(runtime.stateRoot, "sandboxes.json");
  const secondSandboxName = upgradedSandboxName(target.sandboxName);
  const controlEnv = runtime.environment({
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_AGENT: target.contract.packageId,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_GPU: "0",
    NEMOCLAW_SANDBOX_NAME: target.sandboxName,
  });
  const inferenceEnv = buildFabricOnboardingEnvironment(controlEnv, inferenceEnvironment);
  const secondControlEnv = { ...controlEnv, NEMOCLAW_SANDBOX_NAME: secondSandboxName };
  const secondInferenceEnv = buildFabricOnboardingEnvironment(
    secondControlEnv,
    inferenceEnvironment,
  );
  let gatewayOwnershipClaimed = false;
  const gatewayCleanupOptions: IsolatedGatewayCleanupOptions = {
    artifactName: "cleanup-fabric-package-gateway",
    environment: controlEnv,
    gatewayName: runtime.gatewayName,
    gatewayPort: runtime.gatewayPort,
    home: runtime.home,
    redactionValues: [apiKey],
    timeoutMs: COMMAND_TIMEOUT_MS,
  };
  const cleanupActions: CleanupAction[] = [
    {
      label: `release isolated gateway ${runtime.gatewayName} and its private home`,
      run: () =>
        gatewayOwnershipClaimed
          ? cleanupIsolatedGateway(host, gatewayCleanupOptions)
          : runtime.removeHome(),
    },
    {
      label: `remove sandbox ${target.sandboxName}`,
      run: () =>
        host.cleanupSandbox(target.sandboxName, { env: controlEnv, timeoutMs: 10 * 60_000 }),
    },
  ];
  if (target.journey === "lifecycle") {
    cleanupActions.push({
      label: `remove sandbox ${secondSandboxName}`,
      run: () =>
        host.cleanupSandbox(secondSandboxName, {
          env: secondControlEnv,
          timeoutMs: 10 * 60_000,
        }),
    });
  }

  let result: JourneyEvidence | undefined;
  let failure: unknown;
  let preparedUpgrade: ReturnType<typeof prepareHarnessPackageUpgrade> | undefined;
  let sourceArtifact: ReturnType<typeof requireFabricPackageArtifactE2eBinding> | undefined;
  let upgradeArtifact: ReturnType<typeof requireFabricPackageArtifactE2eBinding> | undefined;
  let runtimeIdentity:
    | {
        readonly docker: string;
        readonly hostArch: string;
        readonly hostPlatform: NodeJS.Platform;
        readonly nemoclaw: string;
        readonly node: string;
        readonly openshell: string;
      }
    | undefined;
  let terminationSignal: "SIGINT" | "SIGTERM" | undefined;
  const handleTermination = (signal: "SIGINT" | "SIGTERM") => {
    terminationSignal ??= signal;
    commandRunner.cancelActive();
  };
  const handleInterrupt = () => handleTermination("SIGINT");
  const handleTerminate = () => handleTermination("SIGTERM");
  const enterPhase = (phase: (typeof FABRIC_PACKAGE_PHASES)[number]) => {
    if (terminationSignal) {
      throw new Error(`Fabric package journey interrupted by ${terminationSignal}`);
    }
    progress.phase(phase);
  };
  process.on("SIGINT", handleInterrupt);
  process.on("SIGTERM", handleTerminate);
  try {
    enterPhase("verify local package and runtime prerequisites");
    const selectedArtifacts = prepareFabricJourneyArtifacts(target, runtime.home);
    const { packageArtifact, upgradePackageArtifact } = selectedArtifacts;
    preparedUpgrade = selectedArtifacts.preparedUpgrade;
    sourceArtifact = requireFabricPackageArtifactE2eBinding(target.contract, packageArtifact);
    upgradeArtifact =
      target.journey === "lifecycle" && upgradePackageArtifact
        ? requireFabricPackageArtifactE2eBinding(target.contract, upgradePackageArtifact)
        : undefined;
    if (target.journey === "lifecycle" && !upgradeArtifact) {
      throw new Error("Fabric package lifecycle requires an exact upgrade artifact");
    }
    await requireIsolatedGatewayAvailable(host, gatewayCleanupOptions);
    gatewayOwnershipClaimed = true;
    const cliVersion = await host.nemoclaw(["--version"], {
      env: controlEnv,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    assertExitZero(cliVersion, "nemoclaw --version");
    const openShellVersion = await host.command("openshell", ["--version"], {
      env: controlEnv,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    assertExitZero(openShellVersion, "openshell --version");
    const dockerVersion = await host.command(
      "docker",
      ["version", "--format", "{{.Server.Version}}"],
      { env: controlEnv, timeoutMs: COMMAND_TIMEOUT_MS },
    );
    assertExitZero(dockerVersion, "docker version");
    runtimeIdentity = {
      docker: dockerVersion.stdout.trim(),
      hostArch: process.arch,
      hostPlatform: process.platform,
      nemoclaw: cliVersion.stdout.trim(),
      node: process.version,
      openshell: openShellVersion.stdout.trim(),
    };
    await artifacts.writeJson("target.json", {
      id: target.contract.packageId,
      adapterId: target.contract.adapterId,
      journey: target.journey,
      sandboxName: target.sandboxName,
      runner: "fabric-package-cli",
      runId,
      runtimeIdentity,
      testedCli,
      sourceArtifactIdentity: sourceArtifact.reference.identity,
      ...(upgradeArtifact ? { upgradeArtifactIdentity: upgradeArtifact.reference.identity } : {}),
      contracts: [
        "install and list one exact receipt-backed harness package",
        "onboard the installed package-owned image",
        "complete a public Fabric agent turn",
        "destroy every test-owned sandbox and deactivate the package",
        ...(target.journey === "lifecycle"
          ? [
              "preserve immutable sandbox receipts through upgrade, rollback, deactivation, and restart",
            ]
          : []),
      ],
    });
    await host.bestEffortCleanupSandbox(target.sandboxName, {
      env: controlEnv,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    if (target.journey === "lifecycle") {
      await host.bestEffortCleanupSandbox(secondSandboxName, {
        env: secondControlEnv,
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
    }

    enterPhase("install and inspect the receipt-backed harness package");
    const initialInventory = await host.nemoclaw(["harness", "list", "--json"], {
      env: controlEnv,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    assertExitZero(initialInventory, "list initial harness inventory");
    requireEmptyHarnessInventory(initialInventory.stdout);

    const installation = await installHarnessPackage(host, target.contract.packageId, controlEnv, {
      packageArtifact: sourceArtifact.reference.packageRoot,
    });
    if (!harnessPackageIdentitiesEqual(installation.identity, sourceArtifact.reference.identity)) {
      throw new Error("Installed Fabric package receipt does not match --package-artifact");
    }
    requireInstalledFabricE2eBinding(target.contract, {
      identity: installation.identity,
      packageRoot: path.join(
        runtime.home,
        ".nemoclaw",
        "harnesses",
        "objects",
        "sha256",
        installation.identity.contentDigest,
      ),
    });

    const requireRevisionMarker = async (
      sandboxName: string,
      sandboxEnvironment: NodeJS.ProcessEnv,
      expected: string,
    ): Promise<string> => {
      const marker = await sandbox.exec(
        sandboxName,
        ["grep", "-Fx", "--", expected, HARNESS_LIFECYCLE_REVISION_MARKER_PATH],
        { env: sandboxEnvironment, timeoutMs: COMMAND_TIMEOUT_MS },
      );
      assertExitZero(marker, "inspect package revision marker");
      return marker.stdout.trim();
    };

    enterPhase("onboard the package-owned sandbox");
    const onboard = await host.nemoclaw(
      ["onboard", "--fresh", "--non-interactive", "--yes", "--yes-i-accept-third-party-software"],
      { env: inferenceEnv, redactionValues: [apiKey], timeoutMs: ONBOARD_TIMEOUT_MS },
    );
    assertExitZero(onboard, `${target.contract.packageId} onboarding`);
    await sandbox.expectListed(target.sandboxName, {
      env: controlEnv,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    const onboardReceipt = requireRecordedPackageIdentity(
      target.sandboxName,
      installation.identity,
      registryPath,
    );
    enterPhase("run the public Fabric agent turn");
    const onboardTurn = await runPublicFabricTurn({
      artifacts,
      contract: target.contract,
      env: controlEnv,
      host,
      lifecyclePhase: "after-onboard",
      redactionValues: [apiKey],
      sandbox,
      sandboxName: target.sandboxName,
    });

    const destroyAndVerify = async (
      sandboxName: string,
      sandboxEnvironment: NodeJS.ProcessEnv,
    ): Promise<void> => {
      const destroy = await host.destroySandbox(sandboxName, {
        env: sandboxEnvironment,
        timeoutMs: 10 * 60_000,
      });
      assertExitZero(destroy, `destroy ${sandboxName}`);
      await sandbox.expectAbsent(sandboxName, {
        env: sandboxEnvironment,
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      const list = await host.nemoclaw(["list"], {
        env: sandboxEnvironment,
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      assertExitZero(list, "list sandboxes after destroy");
      if (outputContainsSandbox(list, sandboxName)) {
        throw new Error(`NemoClaw inventory still contains ${sandboxName}: ${resultText(list)}`);
      }
    };

    const deactivateAndVerify = async (): Promise<HarnessPackageIdentity> => {
      const removal = await host.nemoclaw(
        ["harness", "remove", target.contract.packageId, "--yes", "--json"],
        { env: controlEnv, timeoutMs: COMMAND_TIMEOUT_MS },
      );
      const identity = requireHarnessPackageDeactivation(removal, installation.identity);
      const inventory = await host.nemoclaw(["harness", "list", "--json"], {
        env: controlEnv,
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      assertExitZero(inventory, "list harness inventory after deactivation");
      requireEmptyHarnessInventory(inventory.stdout);
      return identity;
    };

    if (target.journey === "smoke") {
      enterPhase("destroy the sandbox and verify absence");
      await destroyAndVerify(target.sandboxName, controlEnv);
      const deactivatedIdentity = await deactivateAndVerify();
      enterPhase("record Fabric package journey evidence");
      result = {
        id: target.contract.packageId,
        adapterId: target.contract.adapterId,
        journey: "smoke",
        installedIdentity: installation.identity,
        sourceArtifactIdentity: sourceArtifact.reference.identity,
        runtimeIdentity,
        runId,
        testedCli,
        onboardReceipt,
        onboardTurn,
        deactivatedIdentity,
        lifecycle: ["install", "onboard", "turn", "destroy", "deactivate"],
        sandboxAbsent: true,
      };
    } else {
      const verifiedUpgradeArtifact = upgradeArtifact;
      if (!verifiedUpgradeArtifact) {
        throw new Error("Fabric package lifecycle lost its verified upgrade artifact");
      }
      enterPhase("upgrade the active package while the sandbox stays pinned");
      const upgradeInstallation = await installHarnessPackage(
        host,
        target.contract.packageId,
        controlEnv,
        {
          packageArtifact: verifiedUpgradeArtifact.reference.packageRoot,
        },
      );
      requireHarnessPackageUpgrade(
        installation.identity,
        upgradeInstallation.identity,
        preparedUpgrade?.packageVersion,
      );
      if (
        !harnessPackageIdentitiesEqual(
          upgradeInstallation.identity,
          verifiedUpgradeArtifact.reference.identity,
        )
      ) {
        throw new Error(
          "Installed Fabric package receipt does not match --upgrade-package-artifact",
        );
      }
      requireInstalledFabricE2eBinding(target.contract, {
        identity: upgradeInstallation.identity,
        packageRoot: path.join(
          runtime.home,
          ".nemoclaw",
          "harnesses",
          "objects",
          "sha256",
          upgradeInstallation.identity.contentDigest,
        ),
      });
      const upgradePinnedReceipt = requireRecordedPackageIdentity(
        target.sandboxName,
        installation.identity,
        registryPath,
      );
      const upgradedTurn = await runPublicFabricTurn({
        artifacts,
        contract: target.contract,
        env: controlEnv,
        host,
        lifecyclePhase: "after-package-upgrade",
        redactionValues: [apiKey],
        sandbox,
        sandboxName: target.sandboxName,
        scanPrivateState: false,
      });

      enterPhase("onboard the upgraded receipt and run its Fabric turn");
      const upgradeOnboard = await host.nemoclaw(
        ["onboard", "--fresh", "--non-interactive", "--yes", "--yes-i-accept-third-party-software"],
        {
          env: secondInferenceEnv,
          redactionValues: [apiKey],
          timeoutMs: ONBOARD_TIMEOUT_MS,
        },
      );
      assertExitZero(upgradeOnboard, `${target.contract.packageId} upgraded onboarding`);
      const upgradedSandboxReceipt = requireRecordedPackageIdentity(
        secondSandboxName,
        upgradeInstallation.identity,
        registryPath,
      );
      const upgradeMarker = preparedUpgrade
        ? await requireRevisionMarker(
            secondSandboxName,
            secondControlEnv,
            preparedUpgrade.revisionMarker,
          )
        : undefined;
      const upgradedSandboxTurn = await runPublicFabricTurn({
        artifacts,
        contract: target.contract,
        env: secondControlEnv,
        host,
        lifecyclePhase: "after-upgraded-receipt-onboard",
        redactionValues: [apiKey],
        sandbox,
        sandboxName: secondSandboxName,
        scanPrivateState: true,
      });

      enterPhase("roll back the active package and prove both pinned receipts");
      const rollback = await host.nemoclaw(
        [
          "harness",
          "activate",
          target.contract.packageId,
          "--digest",
          installation.identity.contentDigest,
          "--json",
        ],
        { env: controlEnv, timeoutMs: COMMAND_TIMEOUT_MS },
      );
      const rollbackIdentity = requireHarnessPackageActivation(rollback, installation.identity);
      const rollbackPinnedReceipt = requireRecordedPackageIdentity(
        target.sandboxName,
        installation.identity,
        registryPath,
      );
      const upgradeReceiptAfterRollback = requireRecordedPackageIdentity(
        secondSandboxName,
        upgradeInstallation.identity,
        registryPath,
      );
      const rollbackTurn = await runPublicFabricTurn({
        artifacts,
        contract: target.contract,
        env: controlEnv,
        host,
        lifecyclePhase: "after-package-rollback",
        redactionValues: [apiKey],
        sandbox,
        sandboxName: target.sandboxName,
        scanPrivateState: false,
      });
      const upgradedReceiptTurn = await runPublicFabricTurn({
        artifacts,
        contract: target.contract,
        env: secondControlEnv,
        host,
        lifecyclePhase: "upgraded-sandbox-after-package-rollback",
        redactionValues: [apiKey],
        sandbox,
        sandboxName: secondSandboxName,
        scanPrivateState: false,
      });
      await destroyAndVerify(secondSandboxName, secondControlEnv);

      enterPhase("deactivate the package and restart the pinned sandbox");
      const deactivatedIdentity = await deactivateAndVerify();
      const deactivatedPinnedReceipt = requireRecordedPackageIdentity(
        target.sandboxName,
        installation.identity,
        registryPath,
      );
      const stop = await host.nemoclaw([target.sandboxName, "stop"], {
        env: controlEnv,
        redactionValues: [apiKey],
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      assertExitZero(stop, `${target.contract.packageId} stop`);
      const start = await host.nemoclaw([target.sandboxName, "start"], {
        env: controlEnv,
        redactionValues: [apiKey],
        timeoutMs: 10 * 60_000,
      });
      assertExitZero(start, `${target.contract.packageId} start`);
      await host.expectStatus(target.sandboxName, {
        env: controlEnv,
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      await sandbox.expectListed(target.sandboxName, {
        env: controlEnv,
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      const restartedReceipt = requireRecordedPackageIdentity(
        target.sandboxName,
        installation.identity,
        registryPath,
      );
      const restartedTurn = await runPublicFabricTurn({
        artifacts,
        contract: target.contract,
        env: controlEnv,
        host,
        lifecyclePhase: "after-package-deactivation",
        redactionValues: [apiKey],
        sandbox,
        sandboxName: target.sandboxName,
        scanPrivateState: false,
      });

      enterPhase("destroy the sandbox and verify absence");
      await destroyAndVerify(target.sandboxName, controlEnv);
      enterPhase("record Fabric package journey evidence");
      result = {
        id: target.contract.packageId,
        adapterId: target.contract.adapterId,
        journey: "lifecycle",
        installedIdentity: installation.identity,
        upgradeIdentity: upgradeInstallation.identity,
        upgradeArtifactIdentity: verifiedUpgradeArtifact.reference.identity,
        runtimeIdentity,
        runId,
        testedCli,
        onboardReceipt,
        onboardTurn,
        upgradePinnedReceipt,
        upgradedTurn,
        upgradedSandboxReceipt,
        upgradedSandboxTurn,
        rollbackIdentity,
        rollbackPinnedReceipt,
        upgradeReceiptAfterRollback,
        rollbackTurn,
        upgradedReceiptTurn,
        deactivatedIdentity,
        deactivatedPinnedReceipt,
        restartedReceipt,
        restartedTurn,
        ...(preparedUpgrade
          ? {
              revisionMarkers: {
                upgrade: preparedUpgrade.revisionMarker,
                upgradedSandbox: upgradeMarker,
              },
            }
          : {}),
        lifecycle: [
          "install",
          "onboard",
          "turn",
          "upgrade",
          "onboard-upgraded-receipt",
          "rollback",
          "deactivate",
          "stop",
          "start",
          "turn",
          "destroy",
        ],
        sandboxAbsent: true,
      };
    }
  } catch (error) {
    failure = error;
  }

  const cleanup = await runCleanup(cleanupActions);
  process.off("SIGINT", handleInterrupt);
  process.off("SIGTERM", handleTerminate);
  await artifacts.writeJson("cleanup.json", cleanup);
  if (!failure && cleanup.failures.length > 0) {
    failure = new Error("Fabric package cleanup did not complete");
  }
  if (!failure) {
    try {
      const completedCli = requireTestedNemoClawCli(repositoryRoot, environment);
      if (
        completedCli.path !== testedCli.path ||
        completedCli.contentSha256 !== testedCli.contentSha256
      ) {
        throw new Error("The tested checkout's NemoClaw CLI changed during Fabric qualification");
      }
    } catch (error) {
      failure = error;
    }
  }
  if (!failure && result === undefined) {
    failure = new Error("Fabric package journey did not produce result evidence");
  }
  const passed = !failure;
  progress.stop(passed ? "passed" : "failed");
  await artifacts.writeJson("test-progress.json", progress.summary());
  if (failure) {
    await artifacts.writeJson("target-result.json", {
      id: target.contract.packageId,
      adapterId: target.contract.adapterId,
      journey: target.journey,
      status: "failed",
      runner: "fabric-package-cli",
      runId,
      testedCli,
      ...(runtimeIdentity ? { runtimeIdentity } : {}),
      ...(sourceArtifact ? { sourceArtifactIdentity: sourceArtifact.reference.identity } : {}),
      ...(upgradeArtifact ? { upgradeArtifactIdentity: upgradeArtifact.reference.identity } : {}),
      error: redactString(errorMessage(failure), [apiKey]),
    });
    writeRiskSignalCounts(riskSignalEnvironment, {
      passed: 0,
      failed: 1,
      skipped: 0,
      pending: 0,
      unhandledErrors: 0,
      runReason: "failed",
    });
    throw failure;
  }
  if (!result) throw new Error("Fabric package journey result evidence was lost");
  await artifacts.writeJson("target-result.json", {
    ...result,
    status: "passed",
    runner: "fabric-package-cli",
  });
  // The risk signal is the final success commit. A process that stops after
  // result persistence but before this write remains fail-closed to release
  // automation; it can never expose a passing risk gate without the evidence
  // that gate qualifies.
  writeRiskSignalCounts(riskSignalEnvironment, {
    passed: 1,
    failed: 0,
    skipped: 0,
    pending: 0,
    unhandledErrors: 0,
    runReason: "passed",
  });
}
