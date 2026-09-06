// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validateHarnessPackageTree } from "../../../src/lib/agent-runtime/package/tree.ts";
import {
  requireInstalledFabricE2eBinding,
  type FabricHarnessE2eContract,
  type InstalledFabricPackageReference,
  validateFabricHarnessE2eContract,
} from "../../../tools/e2e/fabric-contract.mts";
import {
  defaultFabricPackageSandboxName,
  FABRIC_PACKAGE_LIVE_SELECTOR,
  FABRIC_PACKAGE_LIVE_TEST_PATH,
  fabricPackageE2eEnvironment,
  fabricPackageGatewayEnvironment,
  fabricPackageJourneyEnvironment,
  loadFabricPackageTarget,
  parseFabricPackageCliOptions,
  readBundledFabricHarnessE2eFixture,
  readFabricHarnessE2eFixture,
  readFabricPackageE2eTarget,
} from "../../../tools/e2e/fabric-package.mts";
import { catalogueTarget } from "../../../tools/e2e/target-catalogue.mts";

const PACKAGE_CASES = [
  {
    id: "deepseek-harness",
    adapterId: "nvidia.nemoclaw.deepseek-harness",
    fixture: "packages/nemoclaw-deepseek-harness/tests/fixtures/live-contract.json",
    runnerModule: "nemoclaw_deepseek_fabric.adapter",
    sandboxName: "e2e-deepseek",
  },
  {
    id: "haystack-agent",
    adapterId: "nvidia.nemoclaw.haystack-agent",
    fixture: "packages/nemoclaw-haystack-agent/tests/fixtures/live-contract.json",
    runnerModule: "nemoclaw_haystack_fabric.adapter",
    sandboxName: "e2e-haystack",
  },
] as const;

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

const temporaryDirectories: string[] = [];
const FABRIC_BINDING_TEST_ROOT = path.join(
  process.cwd(),
  "node_modules/.cache/nemoclaw-fabric-binding-tests",
);
fs.mkdirSync(FABRIC_BINDING_TEST_ROOT, { recursive: true, mode: 0o700 });

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
      "state_lifecycle:",
      "  backup_quiescence:",
      "    kind: not-required",
      "  snapshot_restore: []",
      "  rebuild:",
      "    image_plugin_provenance: not-required",
      "    scheduled_work:",
      "      support: disabled",
      "      reason: This synthetic package does not run scheduled work.",
      "    post_restore:",
      "      kind: not-required",
      "",
    ].join("\n"),
    "utf8",
  );

  let descriptorPath: string | undefined;
  if (options.packageOwnsDescriptor !== false) {
    const fabricDirectory = path.join(packageDirectory, "fabric");
    fs.mkdirSync(fabricDirectory);
    descriptorPath = path.join(
      fabricDirectory,
      options.descriptorFileName ?? path.posix.basename(contract.descriptorGlob),
    );
    fs.writeFileSync(
      descriptorPath,
      `${JSON.stringify({
        contract_version: "fabric.adapter/v1alpha2",
        adapter_id: options.descriptorAdapterId ?? contract.adapterId,
        adapter_kind: "python",
        runner: { module: options.descriptorRunnerModule ?? contract.descriptorRunnerModule },
      })}\n`,
      "utf8",
    );
  }
  const contentDigest = validateHarnessPackageTree(sourceRoot, {
    sourceTrust: "mutable",
  }).contentDigest;
  packageRoot = path.join(temporaryRoot, contentDigest);
  fs.renameSync(sourceRoot, packageRoot);
  if (descriptorPath) {
    descriptorPath = path.join(packageRoot, path.relative(sourceRoot, descriptorPath));
  }
  return {
    descriptorPath,
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

  it.each(PACKAGE_CASES)("builds the $id catalogue row from package-owned data", (fixture) => {
    const target = catalogueTarget(`${fixture.id}-fabric`);
    const decoded = readFabricPackageE2eTarget(target.environment);

    expect(target).toMatchObject({
      agentRuntime: fixture.id,
      profile: "nvidia-inference",
      testFile: FABRIC_PACKAGE_LIVE_TEST_PATH,
      selector: FABRIC_PACKAGE_LIVE_SELECTOR,
    });
    expect(target.owningPaths).toContain(fixture.fixture);
    expect(decoded).toEqual({
      contract: readFabricHarnessE2eFixture(fixture.fixture),
      sandboxName: fixture.sandboxName,
    });
    expect(target.environment.NEMOCLAW_GATEWAY_PORT).not.toBe("8080");
    expect(target.environment.OPENSHELL_GATEWAY).toBe(
      `nemoclaw-${target.environment.NEMOCLAW_GATEWAY_PORT}`,
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
    const target = { contract, sandboxName: "e2e-future-harness" };

    expect(readFabricPackageE2eTarget(fabricPackageE2eEnvironment(target))).toEqual(target);
  });

  it("loads the direct command target from only a fixture path and optional sandbox name", () => {
    const options = parseFabricPackageCliOptions([
      "run",
      "--contract",
      PACKAGE_CASES[1].fixture,
      "--sandbox-name",
      "external-haystack",
    ]);

    expect(options).toEqual({
      fixturePath: PACKAGE_CASES[1].fixture,
      packageArtifact: undefined,
      sandboxName: "external-haystack",
      upgradePackageArtifact: undefined,
    });
    expect(loadFabricPackageTarget(options.fixturePath, options)).toMatchObject({
      contract: { packageId: "haystack-agent" },
      sandboxName: "external-haystack",
    });
  });

  it("resolves an independently built package directory before entering the core checkout", () => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fabric-package-"));
    temporaryDirectories.push(workingDirectory);
    const artifactDirectory = path.join(workingDirectory, "dist", "nemoclaw-haystack-agent");
    fs.mkdirSync(artifactDirectory, { recursive: true });
    const fixturePath = path.resolve(PACKAGE_CASES[1].fixture);
    const options = parseFabricPackageCliOptions([
      "run",
      "--contract",
      fixturePath,
      "--package-artifact",
      "dist/nemoclaw-haystack-agent",
    ]);

    const target = loadFabricPackageTarget(options.fixturePath, {
      ...options,
      workingDirectory,
    });

    expect(target).toMatchObject({
      contract: { packageId: "haystack-agent" },
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
      path.resolve(PACKAGE_CASES[0].fixture),
      "--package-artifact",
      packageArtifact,
      "--upgrade-package-artifact",
      upgradePackageArtifact,
    ]);

    const target = loadFabricPackageTarget(options.fixturePath, options);

    expect(target).toMatchObject({ packageArtifact, upgradePackageArtifact });
    expect(readFabricPackageE2eTarget(fabricPackageE2eEnvironment(target))).toEqual(target);
  });

  it("rejects one directory as both lifecycle revisions before starting the journey", () => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fabric-package-"));
    temporaryDirectories.push(workingDirectory);
    const packageArtifact = path.join(workingDirectory, "package");
    fs.mkdirSync(packageArtifact);

    expect(() =>
      loadFabricPackageTarget(path.resolve(PACKAGE_CASES[0].fixture), {
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

      expect(() =>
        loadFabricPackageTarget(path.resolve(PACKAGE_CASES[0].fixture), {
          ...(field === "package"
            ? { packageArtifact: artifactPath }
            : { upgradePackageArtifact: artifactPath }),
          workingDirectory,
        }),
      ).toThrow(/Fabric package artifact/u);
    },
  );

  it.each(["file", "symlink"] as const)(
    "rejects a %s local package artifact before starting the live journey",
    (kind) => {
      const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fabric-package-"));
      temporaryDirectories.push(workingDirectory);
      const artifactPath = path.join(workingDirectory, "package-artifact");
      if (kind === "file") fs.writeFileSync(artifactPath, "not a directory\n", "utf8");
      if (kind === "symlink") fs.symlinkSync(workingDirectory, artifactPath, "dir");

      expect(() =>
        loadFabricPackageTarget(path.resolve(PACKAGE_CASES[0].fixture), {
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
        PACKAGE_CASES[0].fixture,
        "--contract",
        PACKAGE_CASES[1].fixture,
      ],
    },
  ])("rejects an incomplete or ambiguous direct command", ({ arguments_ }) => {
    expect(() => parseFabricPackageCliOptions(arguments_)).toThrow();
  });

  it("builds one isolated direct-run environment while preserving caller inference choices", () => {
    const contract = readFabricHarnessE2eFixture(PACKAGE_CASES[0].fixture);
    const target = { contract, sandboxName: "e2e-deepseek" };
    const environment = fabricPackageJourneyEnvironment(target, {
      E2E_TARGET_ID: "external-deepseek-proof",
      NEMOCLAW_ENDPOINT_URL: "https://example.test/v1",
      NEMOCLAW_MODEL: "example/model",
    });

    expect(environment).toMatchObject({
      E2E_TARGET_ID: "external-deepseek-proof",
      NEMOCLAW_AGENT: "deepseek-harness",
      NEMOCLAW_COMPAT_MODEL: "example/model",
      NEMOCLAW_ENDPOINT_URL: "https://example.test/v1",
      NEMOCLAW_MODEL: "example/model",
      NEMOCLAW_RUN_LIVE_E2E: "1",
      NEMOCLAW_SANDBOX_NAME: "e2e-deepseek",
    });
    expect(environment.OPENSHELL_GATEWAY).toBe(`nemoclaw-${environment.NEMOCLAW_GATEWAY_PORT}`);
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
    expect(Number(firstGateway.NEMOCLAW_GATEWAY_PORT)).toBeLessThan(40_000);
  });

  it.each([
    { packageId: "../escape" },
    { descriptorGlob: "relative/adapter.json" },
    { descriptorRunnerModule: "invalid-module.adapter" },
    { processMarkers: ["invalid\nmarker"] },
    { unexpected: true },
  ])("rejects malformed package-owned contract fields", (override) => {
    const valid = readFabricHarnessE2eFixture(PACKAGE_CASES[0].fixture);
    expect(() => validateFabricHarnessE2eContract({ ...valid, ...override })).toThrow(
      /Fabric package/u,
    );
  });
});
