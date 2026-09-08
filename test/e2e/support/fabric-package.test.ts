// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validateHarnessPackageTree } from "../../../src/lib/agent-runtime/package/tree.ts";
import {
  requireFabricPackageArtifactE2eBinding,
  requireInstalledFabricE2eBinding,
  type FabricHarnessE2eContract,
  type InstalledFabricPackageReference,
  validateFabricHarnessE2eContract,
} from "../../../tools/e2e/fabric-contract.mts";
import { prepareFabricJourneyArtifacts } from "../../../tools/e2e/fabric-journey.mts";
import {
  defaultFabricPackageSandboxName,
  fabricPackageE2eEnvironment,
  fabricPackageGatewayEnvironment,
  fabricPackageJourneyEnvironment,
  loadFabricPackageTarget,
  parseFabricPackageCliOptions,
  readBundledFabricHarnessE2eFixture,
  readFabricHarnessE2eFixture,
  readFabricPackageE2eTarget,
} from "../../../tools/e2e/fabric-package.mts";

function discoverBundledFabricFixtures(): readonly {
  readonly id: string;
  readonly fixture: string;
}[] {
  const packagesDirectory = path.resolve("packages");
  return fs
    .readdirSync(packagesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("nemoclaw-"))
    .flatMap((entry) => {
      const id = entry.name.slice("nemoclaw-".length);
      const fixture = path.posix.join("packages", entry.name, "tests/fixtures/live-contract.json");
      return fs.existsSync(path.resolve(fixture)) ? [{ id, fixture }] : [];
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

const BUNDLED_PACKAGE_CASES = discoverBundledFabricFixtures();
const SYNTHETIC_FIXTURE_PATH = "/tmp/future-harness-live-contract.json";
const SYNTHETIC_ARTIFACT_PATH = "/tmp/future-harness-package";

const temporaryDirectories: string[] = [];
const FABRIC_BINDING_TEST_ROOT = path.join(
  process.cwd(),
  "node_modules/.cache/nemoclaw-fabric-binding-tests",
);
fs.mkdirSync(FABRIC_BINDING_TEST_ROOT, { recursive: true, mode: 0o700 });

function writeFutureContractFixture(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fabric-contract-"));
  temporaryDirectories.push(directory);
  const fixture = path.join(directory, "live-contract.json");
  fs.writeFileSync(fixture, `${JSON.stringify(futureFabricContract(), null, 2)}\n`, "utf8");
  return fixture;
}

function createEmptyPackageArtifact(label = "package-artifact"): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fabric-artifact-"));
  temporaryDirectories.push(directory);
  const artifact = path.join(directory, label);
  fs.mkdirSync(artifact);
  return artifact;
}

interface InstalledPackageFixtureOptions {
  readonly descriptorAdapterId?: string;
  readonly descriptorFileName?: string;
  readonly descriptorRunnerModule?: string;
  readonly headlessCommand?: string;
  readonly manifestId?: string;
  readonly metadataId?: string;
  readonly packageOwnsDescriptor?: boolean;
}

function futureFabricContract(
  overrides: Partial<FabricHarnessE2eContract> = {},
): FabricHarnessE2eContract {
  return validateFabricHarnessE2eContract({
    packageId: "future-harness",
    adapterId: "example.future-harness",
    artifactRoot: "/sandbox/.future-harness/fabric-artifacts",
    configPath: "/sandbox/.future-harness/fabric.json",
    descriptorGlob: "/usr/local/share/nemoclaw/future-harness.fabric-adapter.json",
    descriptorPathPrefix: "/usr/local/share/nemoclaw",
    descriptorRunnerModule: "future_harness_fabric.adapter",
    ...overrides,
  });
}

function writeInstalledPackageFixture(
  contract: FabricHarnessE2eContract,
  options: InstalledPackageFixtureOptions = {},
): {
  readonly descriptorPath: string | undefined;
  readonly reference: InstalledFabricPackageReference;
} {
  const temporaryRoot = fs.mkdtempSync(path.join(FABRIC_BINDING_TEST_ROOT, "fixture-"));
  temporaryDirectories.push(temporaryRoot);
  const sourceRoot = path.join(temporaryRoot, "package-source");
  let packageRoot = sourceRoot;
  const packageDirectory = path.join(packageRoot, "packages", `nemoclaw-${contract.packageId}`);
  fs.mkdirSync(packageDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "nemoclaw-package.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "agent-runtime",
      id: options.metadataId ?? contract.packageId,
      displayName: "Future Harness",
      packageVersion: "1.0.0",
      minimumNemoClawVersion: "0.0.113",
      maximumNemoClawVersionExclusive: "0.0.121",
      manifest: `packages/nemoclaw-${contract.packageId}/manifest.yaml`,
    })}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(packageDirectory, "manifest.yaml"),
    [
      `name: ${options.manifestId ?? contract.packageId}`,
      "runtime:",
      "  kind: terminal",
      "  prompt_transport: stdin",
      `  headless_command: ${JSON.stringify(
        options.headlessCommand ??
          `nemoclaw-fabric-run --deadline-seconds 120 --kill-grace-seconds 10 --config ${contract.configPath}`,
      )}`,
      "config:",
      `  dir: /sandbox/.${contract.packageId}`,
      "  config_file: config.json",
      "  format: json",
      "inference:",
      "  config_update:",
      "    support: unsupported",
      "    reason: This synthetic package has fixed inference configuration.",
      "messaging:",
      "  support: disabled",
      "policy:",
      "  owned_presets: []",
      "  automatic_presets: []",
      "  baseline_exclusion_impacts: {}",
      "state_lifecycle:",
      "  backup_quiescence:",
      "    kind: not-required",
      "  snapshot_restore: []",
      "  rebuild:",
      "    managed_extensions:",
      "      support: disabled",
      "      reason: Test package has no managed extensions.",
      "    scheduled_work:",
      "      support: disabled",
      "      reason: This synthetic package does not run scheduled work.",
      "    post_restore:",
      "      kind: not-required",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(path.join(packageDirectory, "Dockerfile"), "FROM scratch\n", "utf8");

  const descriptorPath =
    options.packageOwnsDescriptor === false
      ? undefined
      : (() => {
          const fabricDirectory = path.join(packageDirectory, "fabric");
          fs.mkdirSync(fabricDirectory);
          const file = path.join(
            fabricDirectory,
            options.descriptorFileName ?? path.posix.basename(contract.descriptorGlob),
          );
          fs.writeFileSync(
            file,
            `${JSON.stringify({
              contract_version: "fabric.adapter/v1alpha2",
              adapter_id: options.descriptorAdapterId ?? contract.adapterId,
              adapter_kind: "python",
              runner: { module: options.descriptorRunnerModule ?? contract.descriptorRunnerModule },
            })}\n`,
            "utf8",
          );
          return file;
        })();
  const contentDigest = validateHarnessPackageTree(sourceRoot, {
    sourceTrust: "mutable",
  }).contentDigest;
  packageRoot = path.join(temporaryRoot, contentDigest);
  fs.renameSync(sourceRoot, packageRoot);
  return {
    descriptorPath: descriptorPath
      ? path.join(packageRoot, path.relative(sourceRoot, descriptorPath))
      : undefined,
    reference: {
      identity: {
        kind: "agent-runtime",
        id: contract.packageId,
        packageVersion: "1.0.0",
        contentDigest,
      },
      packageRoot,
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("generic Fabric package E2E", () => {
  it("binds package-owned live expectations to the receipt-pinned installed object", () => {
    const contract = futureFabricContract();
    const fixture = writeInstalledPackageFixture(contract);

    expect(requireInstalledFabricE2eBinding(contract, fixture.reference)).toEqual({
      adapterId: contract.adapterId,
      configPath: contract.configPath,
      descriptorAuthority: "package",
      packageId: contract.packageId,
      runnerModule: contract.descriptorRunnerModule,
    });
  });

  it("binds a trusted-local input directory to its exact pre-install identity", () => {
    const contract = futureFabricContract();
    const fixture = writeInstalledPackageFixture(contract);
    const artifactRoot = path.join(path.dirname(fixture.reference.packageRoot), "exact-artifact");
    fs.renameSync(fixture.reference.packageRoot, artifactRoot);

    const bound = requireFabricPackageArtifactE2eBinding(contract, artifactRoot);

    expect(bound.binding).toMatchObject({
      adapterId: contract.adapterId,
      packageId: contract.packageId,
    });
    expect(bound.reference).toMatchObject({
      identity: fixture.reference.identity,
      packageRoot: artifactRoot,
    });
  });

  it("binds an exact artifact through the documented tsx subprocess", () => {
    const contract = futureFabricContract();
    const fixturePath = writeFutureContractFixture();
    const fixture = writeInstalledPackageFixture(contract);
    const script = String.raw`
import fs from "node:fs";
const fabricContract = await import("./tools/e2e/fabric-contract.mts");
const contract = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const bound = fabricContract.requireFabricPackageArtifactE2eBinding(contract, process.argv[2]);
process.stdout.write(bound.reference.identity.id);
`;

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        script,
        fixturePath,
        fixture.reference.packageRoot,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        shell: false,
        timeout: 10_000,
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe("future-harness");
  });

  it("keeps the supplied lifecycle source exact while generating only its upgrade", () => {
    const contract = futureFabricContract();
    const fixture = writeInstalledPackageFixture(contract);
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fabric-runtime-"));
    temporaryDirectories.push(runtimeHome);
    const before = requireFabricPackageArtifactE2eBinding(contract, fixture.reference.packageRoot);

    const selected = prepareFabricJourneyArtifacts(
      {
        contract,
        journey: "lifecycle",
        packageArtifact: fixture.reference.packageRoot,
        sandboxName: "e2e-future",
      },
      runtimeHome,
    );

    expect(selected.packageArtifact).toBe(fixture.reference.packageRoot);
    expect(selected.upgradePackageArtifact).not.toBe(fixture.reference.packageRoot);
    expect(selected.preparedUpgrade?.packageRoot).toBe(selected.upgradePackageArtifact);
    expect(
      requireFabricPackageArtifactE2eBinding(contract, selected.packageArtifact).reference.identity,
    ).toEqual(before.reference.identity);
  });

  it("accepts a package without a local descriptor only through the upstream Fabric namespace", () => {
    const contract = futureFabricContract({
      adapterId: "nvidia.fabric.future",
      descriptorGlob:
        "/opt/nemoclaw-fabric-venv/share/nemo-fabric/adapters/future/future.fabric-adapter.json",
      descriptorPathPrefix: "/opt/nemoclaw-fabric-venv/share/nemo-fabric",
      descriptorRunnerModule: "nemo_fabric_adapters.future.adapter",
    });
    const fixture = writeInstalledPackageFixture(contract, { packageOwnsDescriptor: false });

    expect(requireInstalledFabricE2eBinding(contract, fixture.reference)).toMatchObject({
      descriptorAuthority: "nemo-fabric",
      packageId: "future-harness",
    });
  });

  it.each([
    {
      label: "metadata package id",
      options: { metadataId: "another-harness" },
    },
    {
      label: "manifest package id",
      options: { manifestId: "another-harness" },
    },
    {
      label: "headless config path",
      options: {
        headlessCommand:
          "nemoclaw-fabric-run --deadline-seconds 120 --kill-grace-seconds 10 --config /sandbox/.other/fabric.json",
      },
    },
    {
      label: "headless executable",
      options: {
        headlessCommand:
          "other-runner --deadline-seconds 120 --kill-grace-seconds 10 --config /sandbox/.future-harness/fabric.json",
      },
    },
    {
      label: "descriptor adapter id",
      options: { descriptorAdapterId: "example.other" },
    },
    {
      label: "descriptor runner module",
      options: { descriptorRunnerModule: "other_fabric.adapter" },
    },
    {
      label: "descriptor file name",
      options: { descriptorFileName: "other.fabric-adapter.json" },
    },
  ] satisfies readonly {
    readonly label: string;
    readonly options: InstalledPackageFixtureOptions;
  }[])("rejects $label drift before onboarding can mutate a sandbox", ({ options }) => {
    const contract = futureFabricContract();
    const fixture = writeInstalledPackageFixture(contract, options);

    expect(() => requireInstalledFabricE2eBinding(contract, fixture.reference)).toThrow(
      "Installed Fabric package does not match its package-owned E2E contract",
    );
  });

  it("rejects an unbound external descriptor namespace before onboarding", () => {
    const contract = futureFabricContract();
    const fixture = writeInstalledPackageFixture(contract, { packageOwnsDescriptor: false });

    expect(() => requireInstalledFabricE2eBinding(contract, fixture.reference)).toThrow(
      "Installed Fabric package does not match its package-owned E2E contract",
    );
  });

  it("rejects an oversized package-owned descriptor through the bounded reader", () => {
    const contract = futureFabricContract();
    const fixture = writeInstalledPackageFixture(contract);
    fs.writeFileSync(fixture.descriptorPath!, "x".repeat(256 * 1024 + 1), "utf8");

    expect(() => requireInstalledFabricE2eBinding(contract, fixture.reference)).toThrow(
      "Installed Fabric package does not match its package-owned E2E contract",
    );
  });

  it("rejects package bytes that no longer match the receipt digest", () => {
    const contract = futureFabricContract();
    const fixture = writeInstalledPackageFixture(contract);
    fs.appendFileSync(fixture.descriptorPath!, "\n", "utf8");

    expect(() => requireInstalledFabricE2eBinding(contract, fixture.reference)).toThrow(
      "Installed Fabric package does not match its package-owned E2E contract",
    );
  });

  it("rejects a receipt whose version or complete identity differs from the package", () => {
    const contract = futureFabricContract();
    const fixture = writeInstalledPackageFixture(contract);

    expect(() =>
      requireInstalledFabricE2eBinding(contract, {
        ...fixture.reference,
        identity: { ...fixture.reference.identity, packageVersion: "2.0.0" },
      }),
    ).toThrow("Installed Fabric package does not match its package-owned E2E contract");
  });

  it.each(BUNDLED_PACKAGE_CASES)(
    "loads the conventional $id contract from its package",
    (fixture) => {
      const contract = readBundledFabricHarnessE2eFixture(fixture.id);

      expect(contract).toEqual(readFabricHarnessE2eFixture(fixture.fixture));
      expect(contract.packageId).toBe(fixture.id);
      expect(Object.isFrozen(contract)).toBe(true);
    },
  );

  it("loads an ordinary tsx real target through the hosted-credential gate", () => {
    const bundled = BUNDLED_PACKAGE_CASES[0];
    expect(bundled).toBeDefined();
    const credentialFreeEnvironment = { ...process.env };
    delete credentialFreeEnvironment.NVIDIA_INFERENCE_API_KEY;
    const packageDirectory = path.resolve(path.dirname(bundled!.fixture), "../..");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.resolve("tools/e2e/fabric-package.mts"),
        "run",
        "--contract",
        path.resolve(bundled!.fixture),
        "--package-artifact",
        packageDirectory,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: credentialFreeEnvironment,
        shell: false,
        timeout: 10_000,
      },
    );

    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe(
      "Fabric package qualification failed; inspect the redacted E2E artifacts for details.\n",
    );
  });

  it("round-trips an unknown typed package without a harness-name switch", () => {
    const contract = validateFabricHarnessE2eContract({
      packageId: "future-harness",
      adapterId: "example.future-harness",
      artifactRoot: "/sandbox/.future-harness/fabric-artifacts",
      configPath: "/sandbox/.future-harness/fabric.json",
      descriptorGlob: "/usr/local/share/nemoclaw/future-harness.fabric-adapter.json",
      descriptorPathPrefix: "/usr/local/share/nemoclaw",
      descriptorRunnerModule: "future_harness_fabric.adapter",
      processMarkers: ["future_harness"],
    });
    const target = {
      contract,
      journey: "smoke" as const,
      packageArtifact: createEmptyPackageArtifact(),
      sandboxName: "e2e-future-harness",
    };

    expect(readFabricPackageE2eTarget(fabricPackageE2eEnvironment(target))).toEqual(target);
  });

  it("loads the direct command target from an exact artifact, fixture, and optional sandbox name", () => {
    const fixturePath = writeFutureContractFixture();
    const packageArtifact = createEmptyPackageArtifact();
    const options = parseFabricPackageCliOptions([
      "run",
      "--contract",
      fixturePath,
      "--package-artifact",
      packageArtifact,
      "--sandbox-name",
      "external-future",
    ]);

    expect(options).toEqual({
      fixturePath,
      journey: "smoke",
      packageArtifact,
      sandboxName: "external-future",
      upgradePackageArtifact: undefined,
    });
    expect(loadFabricPackageTarget(options.fixturePath, options)).toMatchObject({
      contract: { packageId: "future-harness" },
      journey: "smoke",
      packageArtifact,
      sandboxName: "external-future",
    });
  });

  it("resolves an independently built package directory before entering the core checkout", () => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fabric-package-"));
    temporaryDirectories.push(workingDirectory);
    const artifactDirectory = path.join(workingDirectory, "dist", "nemoclaw-future-harness");
    fs.mkdirSync(artifactDirectory, { recursive: true });
    const fixturePath = writeFutureContractFixture();
    const options = parseFabricPackageCliOptions([
      "run",
      "--contract",
      fixturePath,
      "--package-artifact",
      "dist/nemoclaw-future-harness",
    ]);

    const target = loadFabricPackageTarget(options.fixturePath, {
      ...options,
      workingDirectory,
    });

    expect(target).toMatchObject({
      contract: { packageId: "future-harness" },
      journey: "smoke",
      packageArtifact: artifactDirectory,
    });
    expect(readFabricPackageE2eTarget(fabricPackageE2eEnvironment(target))).toEqual(target);
  });

  it("round-trips an explicit upgrade artifact without a package registry entry", () => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fabric-package-"));
    temporaryDirectories.push(workingDirectory);
    const packageArtifact = path.join(workingDirectory, "initial-package");
    const upgradePackageArtifact = path.join(workingDirectory, "upgrade-package");
    fs.mkdirSync(packageArtifact);
    fs.mkdirSync(upgradePackageArtifact);
    const options = parseFabricPackageCliOptions([
      "run",
      "--contract",
      writeFutureContractFixture(),
      "--package-artifact",
      packageArtifact,
      "--upgrade-package-artifact",
      upgradePackageArtifact,
      "--journey",
      "lifecycle",
    ]);

    const target = loadFabricPackageTarget(options.fixturePath, options);

    expect(target).toMatchObject({ packageArtifact, upgradePackageArtifact });
    expect(readFabricPackageE2eTarget(fabricPackageE2eEnvironment(target))).toEqual(target);
  });

  it("selects the full lifecycle journey explicitly", () => {
    const packageArtifact = createEmptyPackageArtifact();
    const options = parseFabricPackageCliOptions([
      "run",
      "--contract",
      writeFutureContractFixture(),
      "--package-artifact",
      packageArtifact,
      "--journey",
      "lifecycle",
    ]);

    expect(options.journey).toBe("lifecycle");
    expect(loadFabricPackageTarget(options.fixturePath, options).journey).toBe("lifecycle");
  });

  it("rejects one directory as both lifecycle revisions before starting the journey", () => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fabric-package-"));
    temporaryDirectories.push(workingDirectory);
    const packageArtifact = path.join(workingDirectory, "package");
    fs.mkdirSync(packageArtifact);

    expect(() =>
      loadFabricPackageTarget(writeFutureContractFixture(), {
        journey: "lifecycle",
        packageArtifact,
        upgradePackageArtifact: packageArtifact,
      }),
    ).toThrow(/different directories/u);
  });

  it.each(["package", "upgrade"] as const)(
    "rejects a missing %s artifact before starting the live journey",
    (field) => {
      const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fabric-package-"));
      temporaryDirectories.push(workingDirectory);
      const artifactPath = path.join(workingDirectory, "package-artifact");
      const packageArtifact =
        field === "package" ? artifactPath : createEmptyPackageArtifact("initial-package");

      expect(() =>
        loadFabricPackageTarget(writeFutureContractFixture(), {
          packageArtifact,
          ...(field === "upgrade"
            ? { journey: "lifecycle" as const, upgradePackageArtifact: artifactPath }
            : {}),
          workingDirectory,
        }),
      ).toThrow(/Fabric package artifact/u);
    },
  );

  it.each([
    {
      kind: "file",
      prepare: (artifactPath: string, _workingDirectory: string) =>
        fs.writeFileSync(artifactPath, "not a directory\n", "utf8"),
    },
    {
      kind: "symlink",
      prepare: (artifactPath: string, workingDirectory: string) =>
        fs.symlinkSync(workingDirectory, artifactPath, "dir"),
    },
  ] as const)(
    "rejects a $kind local package artifact before starting the live journey",
    ({ prepare }) => {
      const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fabric-package-"));
      temporaryDirectories.push(workingDirectory);
      const artifactPath = path.join(workingDirectory, "package-artifact");
      prepare(artifactPath, workingDirectory);

      expect(() =>
        loadFabricPackageTarget(writeFutureContractFixture(), {
          packageArtifact: artifactPath,
          workingDirectory,
        }),
      ).toThrow(/Fabric package artifact/u);
    },
  );

  it.each([
    { arguments_: [] },
    { arguments_: ["run"] },
    { arguments_: ["run", "--unknown", "value"] },
    {
      arguments_: [
        "run",
        "--contract",
        SYNTHETIC_FIXTURE_PATH,
        "--package-artifact",
        SYNTHETIC_ARTIFACT_PATH,
        "--journey",
        "complete",
      ],
    },
    {
      arguments_: [
        "run",
        "--contract",
        SYNTHETIC_FIXTURE_PATH,
        "--package-artifact",
        SYNTHETIC_ARTIFACT_PATH,
        "--upgrade-package-artifact",
        "/tmp/example-upgrade",
      ],
    },
    {
      arguments_: [
        "run",
        "--contract",
        SYNTHETIC_FIXTURE_PATH,
        "--contract",
        "/tmp/another-future-live-contract.json",
      ],
    },
  ])("rejects an incomplete or ambiguous direct command", ({ arguments_ }) => {
    expect(() => parseFabricPackageCliOptions(arguments_)).toThrow();
  });

  it("builds one isolated direct-run environment while preserving caller inference choices", () => {
    const contract = futureFabricContract();
    const target = {
      contract,
      journey: "smoke" as const,
      packageArtifact: SYNTHETIC_ARTIFACT_PATH,
      sandboxName: "e2e-future",
    };
    const environment = fabricPackageJourneyEnvironment(target, {
      E2E_TARGET_ID: "external-future-proof",
      NEMOCLAW_ENDPOINT_URL: "https://example.test/v1",
      NEMOCLAW_MODEL: "example/model",
    });

    expect(environment).toMatchObject({
      E2E_TARGET_ID: "external-future-proof",
      E2E_FABRIC_PACKAGE_JOURNEY: "smoke",
      NEMOCLAW_AGENT: "future-harness",
      NEMOCLAW_COMPAT_MODEL: "example/model",
      NEMOCLAW_ENDPOINT_URL: "https://example.test/v1",
      NEMOCLAW_MODEL: "example/model",
      NEMOCLAW_RUN_LIVE_E2E: "1",
      NEMOCLAW_SANDBOX_NAME: "e2e-future",
    });
    expect(environment).not.toHaveProperty("NEMOCLAW_CANDIDATE_AGENTS");
    expect(environment).not.toHaveProperty("NEMOCLAW_CANDIDATE_QUALIFICATION_RECEIPT");
    expect(environment.OPENSHELL_GATEWAY).toBe(`nemoclaw-${environment.NEMOCLAW_GATEWAY_PORT}`);
  });

  it("defaults direct runs to a Fabric-compatible hosted model", () => {
    const contract = futureFabricContract();
    const target = {
      contract,
      journey: "smoke" as const,
      packageArtifact: SYNTHETIC_ARTIFACT_PATH,
      sandboxName: "e2e-future",
    };

    expect(fabricPackageJourneyEnvironment(target, {})).toMatchObject({
      NEMOCLAW_COMPAT_MODEL: "nvidia/nvidia/nemotron-3-super-v3",
      NEMOCLAW_MODEL: "nvidia/nvidia/nemotron-3-super-v3",
    });
  });

  it("derives stable bounded sandbox and gateway identities for any canonical package id", () => {
    const longPackageId = `a${"b".repeat(62)}`;
    const sandboxName = defaultFabricPackageSandboxName(longPackageId);
    const firstGateway = fabricPackageGatewayEnvironment(longPackageId);
    const secondGateway = fabricPackageGatewayEnvironment(longPackageId);

    expect(sandboxName).toMatch(/^e2e-[a-z0-9-]+$/u);
    expect(sandboxName.length).toBeLessThanOrEqual(19);
    expect(firstGateway).toEqual(secondGateway);
    expect(Number(firstGateway.NEMOCLAW_GATEWAY_PORT)).toBeGreaterThanOrEqual(20_000);
    expect(Number(firstGateway.NEMOCLAW_GATEWAY_PORT)).toBeLessThan(60_000);
  });

  it.each([
    { packageId: "../escape" },
    { descriptorGlob: "relative/adapter.json" },
    { descriptorRunnerModule: "invalid-module.adapter" },
    { processMarkers: ["invalid\nmarker"] },
    { unexpected: true },
  ])("rejects malformed package-owned contract fields", (override) => {
    const valid = futureFabricContract();
    expect(() => validateFabricHarnessE2eContract({ ...valid, ...override })).toThrow(
      /Fabric package/u,
    );
  });

  it("rejects a descriptor glob that only shares the descriptor-root text prefix", () => {
    const valid = futureFabricContract();

    expect(() =>
      validateFabricHarnessE2eContract({
        ...valid,
        descriptorGlob: `${valid.descriptorPathPrefix}-outside/adapter.fabric-adapter.json`,
      }),
    ).toThrow(/Fabric package/u);
  });
});
