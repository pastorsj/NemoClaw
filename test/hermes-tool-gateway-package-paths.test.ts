// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installBundledHarness } from "../src/lib/harness/package-registry";
import {
  isValidName as isCanonicalName,
  isValidProviderName as isCanonicalProviderName,
} from "../src/lib/shared/sandbox-name.cts";

type HermesToolGatewayRuntimePaths = Readonly<{
  packageRoot: string;
  runtimeRoot: string;
  hostDir: string;
  script: string;
  matrix: string;
  runtimeCredentials: string;
  controlContract: string;
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
const BROKER_WRAPPER = path.join(
  import.meta.dirname,
  "..",
  "src",
  "lib",
  "hermes-tool-gateway-broker.ts",
);
const HERMES_CONTROL_CONTRACT = path.join(
  import.meta.dirname,
  "..",
  "packages",
  "nemoclaw-hermes",
  "host",
  "tool-gateway-control-contract.ts",
);
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
        isValidName: (value: unknown) => boolean;
        isValidProviderName: (value: unknown) => boolean;
      };
      expect(hermes.isValidName(value)).toBe(isCanonicalName(value));
      expect(hermes.isValidProviderName(value)).toBe(isCanonicalProviderName(value));
    },
  );

  it("uses receipt-qualified installed Hermes host files", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-host-package-"));
    temporaryHome = home;
    process.env.HOME = home;

    const bundledBroker = loadBroker();
    const bundledHash = bundledBroker.brokerRuntimeHash();
    expect(bundledBroker.HERMES_TOOL_GATEWAY_RUNTIME_PATHS.packageRoot).toBe(
      path.join(import.meta.dirname, "..", "packages", "nemoclaw-hermes"),
    );

    const installed = installBundledHarness("hermes", { HOME: home });
    const installedBroker = loadBroker();
    const sourceHostDir = path.join(installed.rootDir, "host");
    const runtimePaths = installedBroker.HERMES_TOOL_GATEWAY_RUNTIME_PATHS;
    expect(runtimePaths.packageRoot).toBe(installed.rootDir);
    expect(runtimePaths.hostDir).toBe(path.join(runtimePaths.runtimeRoot, "host"));
    expect(runtimePaths.script).toBe(path.join(runtimePaths.hostDir, "tool-gateway-broker.ts"));
    expect(runtimePaths.matrix).toBe(
      path.join(runtimePaths.hostDir, "managed-tool-gateway-matrix.json"),
    );
    expect(runtimePaths.runtimeCredentials).toBe(
      path.join(runtimePaths.hostDir, "runtime-refresh-credentials.ts"),
    );
    expect(runtimePaths.controlContract).toBe(
      path.join(runtimePaths.hostDir, "tool-gateway-control-contract.ts"),
    );
    expect(loadBroker().HERMES_TOOL_GATEWAY_RUNTIME_PATHS.runtimeRoot).toBe(
      runtimePaths.runtimeRoot,
    );
    expect(fs.statSync(runtimePaths.runtimeRoot).mode & 0o777).toBe(0o700);
    expectCapturedFile(runtimePaths, sourceHostDir, "tool-gateway-broker.ts");
    expectCapturedFile(runtimePaths, sourceHostDir, "managed-tool-gateway-matrix.json");
    expectCapturedFile(runtimePaths, sourceHostDir, "runtime-refresh-credentials.ts");
    expectCapturedFile(runtimePaths, sourceHostDir, "tool-gateway-control-contract.ts");

    const installedHash = installedBroker.brokerRuntimeHash();
    expect(installedHash).toBe(bundledHash);
    const sourceRuntimeCredentials = path.join(sourceHostDir, "runtime-refresh-credentials.ts");
    fs.appendFileSync(sourceRuntimeCredentials, "\n// test-only installed package change\n");
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
    expect(() => loadBroker()).toThrow("installation receipt does not match package content");
  });
});
