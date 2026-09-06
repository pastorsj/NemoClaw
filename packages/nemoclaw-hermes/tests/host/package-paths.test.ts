// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getHarnessPackageStoreRoot } from "../../../../src/lib/agent-runtime/package/store";
import { resolveCredentialProviderProfile } from "../../../../src/lib/agent-runtime/provider-profile";
import {
  isValidName as isCanonicalSandboxName,
  isValidProviderName as isCanonicalProviderName,
} from "../../../../src/lib/shared/sandbox-name.cts";
import { installHermesPackage } from "../helpers/package-store";

type HermesToolGatewayRuntimePaths = Readonly<{
  packageRoot: string;
  runtimeRoot: string;
  hostDir: string;
  script: string;
  brokerCredentials: string;
  cloneControl: string;
  requestProxy: string;
  matrix: string;
  runtimeCredentials: string;
  controlContract: string;
  nameValidation: string;
}>;

type HermesToolGatewayBroker = {
  readonly HERMES_TOOL_GATEWAY_RUNTIME_PATHS: HermesToolGatewayRuntimePaths;
  readonly brokerRuntimeHash: () => string;
  readonly probeHermesToolGatewayBrokerStart: (options: {
    port: number;
    spawnSyncImpl: (
      executable: string,
      argv: readonly string[],
      options: { env: NodeJS.ProcessEnv },
    ) => { status: number };
  }) => void;
};

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const HERMES_PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const BROKER_WRAPPER = path.join(
  REPO_ROOT,
  "src",
  "lib",
  "actions",
  "sandbox",
  "legacy-hermes-tool-gateway-broker.ts",
);
const HERMES_CONTROL_CONTRACT = path.join(HERMES_PACKAGE_ROOT, "host", "tool-contract.ts");
const SOURCE_REQUIRE_HOOK = path.join(REPO_ROOT, "test", "helpers", "onboard-script-mocks.cjs");
const NAME_VALIDATION_CASES: readonly { label: string; value: unknown }[] = [
  { label: "undefined", value: undefined },
  { label: "null", value: null },
  { label: "number", value: 0 },
  { label: "empty", value: "" },
  { label: "short lowercase", value: "a" },
  { label: "maximum sandbox length", value: `a${"b".repeat(18)}` },
  { label: "overlong sandbox", value: `a${"b".repeat(19)}` },
  { label: "single hyphen", value: "a-b" },
  { label: "double hyphen", value: "a--b" },
  { label: "uppercase", value: "A" },
  { label: "provider punctuation", value: "provider_1.prod" },
  { label: "numeric provider prefix", value: "1provider" },
  { label: "maximum provider length", value: `p${"x".repeat(127)}` },
  { label: "overlong provider", value: `p${"x".repeat(128)}` },
];
let temporaryHome: string | null = null;
let previousHome: string | undefined;

function loadBroker(): HermesToolGatewayBroker {
  delete require.cache[require.resolve(BROKER_WRAPPER)];
  return require(BROKER_WRAPPER) as HermesToolGatewayBroker;
}

function expectCapturedFile(
  runtimePaths: HermesToolGatewayRuntimePaths,
  sourceHostDir: string,
  fileName: string,
): void {
  const capturedPath = path.join(runtimePaths.hostDir, fileName);
  expect(fs.readFileSync(capturedPath)).toEqual(
    fs.readFileSync(path.join(sourceHostDir, fileName)),
  );
  expect(fs.statSync(capturedPath).mode & 0o777).toBe(0o400);
}

beforeEach(() => {
  previousHome = process.env.HOME;
});

afterEach(() => {
  previousHome === undefined
    ? Reflect.deleteProperty(process.env, "HOME")
    : Reflect.set(process.env, "HOME", previousHome);
  delete require.cache[require.resolve(BROKER_WRAPPER)];
  temporaryHome && fs.rmSync(temporaryHome, { recursive: true, force: true });
  temporaryHome = null;
});

describe("Hermes tool-gateway package paths", () => {
  it.each(NAME_VALIDATION_CASES)(
    "keeps its copied boundary validators aligned for $label",
    ({ value }) => {
      const hermes = require(HERMES_CONTROL_CONTRACT) as {
        isValidSandboxName: (value: unknown) => boolean;
        isValidProviderName: (value: unknown) => boolean;
      };
      expect(hermes.isValidSandboxName(value)).toBe(isCanonicalSandboxName(value));
      expect(hermes.isValidProviderName(value)).toBe(isCanonicalProviderName(value));
    },
  );

  it("keeps the qualified provider runtime separate from an installed harness receipt", () => {
    const home = fs.mkdtempSync(
      path.join(fs.realpathSync.native(os.tmpdir()), "nemoclaw-hermes-host-package-"),
    );
    temporaryHome = home;
    process.env.HOME = home;

    const bundledBroker = loadBroker();
    const bundledHash = bundledBroker.brokerRuntimeHash();
    expect(bundledBroker.HERMES_TOOL_GATEWAY_RUNTIME_PATHS.packageRoot).toBe(HERMES_PACKAGE_ROOT);

    const installed = installHermesPackage(home);
    const installedBroker = loadBroker();
    const sourceHostDir = path.join(HERMES_PACKAGE_ROOT, "host");
    const runtimePaths = installedBroker.HERMES_TOOL_GATEWAY_RUNTIME_PATHS;
    expect(runtimePaths.packageRoot).toBe(HERMES_PACKAGE_ROOT);
    expect(runtimePaths.hostDir).toBe(path.join(runtimePaths.runtimeRoot, "host"));
    expect(runtimePaths.script).toBe(path.join(runtimePaths.hostDir, "tool-broker.ts"));
    expect(runtimePaths.brokerCredentials).toBe(
      path.join(runtimePaths.hostDir, "broker-credentials.ts"),
    );
    expect(runtimePaths.cloneControl).toBe(path.join(runtimePaths.hostDir, "clone-control.ts"));
    expect(runtimePaths.requestProxy).toBe(path.join(runtimePaths.hostDir, "request-proxy.ts"));
    expect(runtimePaths.matrix).toBe(path.join(runtimePaths.hostDir, "tool-matrix.json"));
    expect(runtimePaths.runtimeCredentials).toBe(
      path.join(runtimePaths.hostDir, "refresh-credentials.ts"),
    );
    expect(runtimePaths.controlContract).toBe(path.join(runtimePaths.hostDir, "tool-contract.ts"));
    expect(runtimePaths.nameValidation).toBe(path.join(runtimePaths.hostDir, "name-validation.ts"));
    expect(loadBroker().HERMES_TOOL_GATEWAY_RUNTIME_PATHS.runtimeRoot).toBe(
      runtimePaths.runtimeRoot,
    );
    expect(fs.statSync(runtimePaths.runtimeRoot).mode & 0o777).toBe(0o700);
    expectCapturedFile(runtimePaths, sourceHostDir, "tool-broker.ts");
    expectCapturedFile(runtimePaths, sourceHostDir, "broker-credentials.ts");
    expectCapturedFile(runtimePaths, sourceHostDir, "clone-control.ts");
    expectCapturedFile(runtimePaths, sourceHostDir, "request-proxy.ts");
    expectCapturedFile(runtimePaths, sourceHostDir, "tool-matrix.json");
    expectCapturedFile(runtimePaths, sourceHostDir, "refresh-credentials.ts");
    expectCapturedFile(runtimePaths, sourceHostDir, "tool-contract.ts");
    expectCapturedFile(runtimePaths, sourceHostDir, "name-validation.ts");

    const installedHash = installedBroker.brokerRuntimeHash();
    expect(installedHash).toBe(bundledHash);
    const installedRuntimeCredentials = path.join(
      path.dirname(installed.packageManifest.manifestPath),
      "host",
      "refresh-credentials.ts",
    );
    fs.appendFileSync(installedRuntimeCredentials, "\n// test-only installed package change\n");
    expect(installedBroker.brokerRuntimeHash()).toBe(installedHash);

    let probeInvocation:
      | { executable: string; argv: readonly string[]; env: NodeJS.ProcessEnv }
      | undefined;
    installedBroker.probeHermesToolGatewayBrokerStart({
      port: 11437,
      spawnSyncImpl: (executable, argv, options) => {
        probeInvocation = { executable, argv, env: options.env };
        return { status: 0 };
      },
    });
    expect(probeInvocation).toBeDefined();
    expect(probeInvocation?.executable).toBe(process.execPath);
    expect(probeInvocation?.argv).toEqual(["--experimental-strip-types", runtimePaths.script]);
    expect(probeInvocation?.env.HERMES_TOOL_GATEWAY_MATRIX_PATH).toBe(runtimePaths.matrix);
    expect(loadBroker().brokerRuntimeHash()).toBe(installedHash);
  });

  it("resolves package profiles from the Hermes receipt and retains the core fallback", () => {
    const home = fs.mkdtempSync(
      path.join(fs.realpathSync.native(os.tmpdir()), "nemoclaw-hermes-provider-profile-"),
    );
    temporaryHome = home;
    const installed = installHermesPackage(home);

    const resolverOptions = {
      storeRoot: getHarnessPackageStoreRoot(home),
      coreRoot: REPO_ROOT,
    };
    const profile = resolveCredentialProviderProfile("Langfuse-Hermes-V1", resolverOptions);

    const installedProfiles = path.join(
      path.dirname(installed.packageManifest.manifestPath),
      "provider-profiles",
    );
    const expectedPath = path.join(installedProfiles, "langfuse-hermes-v1.yaml");
    expect(profile).toEqual({
      profileType: "langfuse-hermes-v1",
      profilePath: expectedPath,
    });
    expect(
      resolveCredentialProviderProfile("langfuse-hermes-v1", {
        ...resolverOptions,
        coreRoot: path.join(home, "core-without-hermes-profiles"),
      }),
    ).toEqual(profile);
    expect(resolveCredentialProviderProfile("tavily-hermes-v1", resolverOptions)?.profilePath).toBe(
      path.join(installedProfiles, "tavily-hermes-v1.yaml"),
    );
    expect(resolveCredentialProviderProfile("openai", resolverOptions)).toEqual({
      profileType: "openai",
      profilePath: path.join(REPO_ROOT, "nemoclaw-blueprint", "provider-profiles", "openai.yaml"),
    });
  });

  it("shares one captured runtime and cleanup across isolated module globals", () => {
    const home = fs.mkdtempSync(
      path.join(fs.realpathSync.native(os.tmpdir()), "nemoclaw-hermes-broker-cache-"),
    );
    temporaryHome = home;
    const script = String.raw`
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const vm = require("node:vm");
const brokerPath = ${JSON.stringify(BROKER_WRAPPER)};
const brokerSource = fs.readFileSync(brokerPath, "utf8");
const brokerRequire = Module.createRequire(brokerPath);

function loadBrokerInIsolatedGlobal() {
  const context = vm.createContext({ process });
  const compile = vm.runInContext(Module.wrap(brokerSource), context, {
    filename: brokerPath,
  });
  const brokerModule = { exports: {} };
  compile(
    brokerModule.exports,
    brokerRequire,
    brokerModule,
    brokerPath,
    path.dirname(brokerPath),
  );
  return brokerModule.exports;
}

const exitListenersBefore = process.listenerCount("exit");
const first = loadBrokerInIsolatedGlobal();
const second = loadBrokerInIsolatedGlobal();
process.stdout.write(JSON.stringify({
  exitListenerDelta: process.listenerCount("exit") - exitListenersBefore,
  runtimeRoots: [
    first.HERMES_TOOL_GATEWAY_RUNTIME_PATHS.runtimeRoot,
    second.HERMES_TOOL_GATEWAY_RUNTIME_PATHS.runtimeRoot,
  ],
}));
`;

    const result = spawnSync(process.execPath, ["--require", SOURCE_REQUIRE_HOOK, "-e", script], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, HOME: home, NODE_OPTIONS: "" },
      timeout: 10_000,
    });

    expect(result.status, result.stderr).toBe(0);
    const proof = JSON.parse(result.stdout) as {
      exitListenerDelta: number;
      runtimeRoots: [string, string];
    };
    expect(proof.exitListenerDelta).toBe(1);
    expect(proof.runtimeRoots[1]).toBe(proof.runtimeRoots[0]);
  }, 15_000);
});
