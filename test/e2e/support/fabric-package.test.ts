// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { validateFabricHarnessE2eContract } from "../../../tools/e2e/fabric-contract.mts";
import {
  defaultFabricPackageSandboxName,
  FABRIC_PACKAGE_LIVE_SELECTOR,
  FABRIC_PACKAGE_LIVE_TEST_PATH,
  fabricPackageE2eEnvironment,
  fabricPackageGatewayEnvironment,
  fabricPackageJourneyEnvironment,
  loadFabricPackageTarget,
  parseFabricPackageCliOptions,
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

describe("generic Fabric package E2E", () => {
  it.each(PACKAGE_CASES)("reads the $id contract from its package fixture", (fixture) => {
    const contract = readFabricHarnessE2eFixture(fixture.fixture);

    expect(contract).toMatchObject({
      packageId: fixture.id,
      adapterId: fixture.adapterId,
      descriptorRunnerModule: fixture.runnerModule,
    });
    expect(Object.isFrozen(contract)).toBe(true);
  });

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
      sandboxName: "external-haystack",
    });
    expect(loadFabricPackageTarget(options.fixturePath, options)).toMatchObject({
      contract: { packageId: "haystack-agent" },
      sandboxName: "external-haystack",
    });
  });

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
