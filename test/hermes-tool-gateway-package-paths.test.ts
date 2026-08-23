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
  hostDir: string;
  script: string;
  matrix: string;
  runtimeCredentials: string;
  controlContract: string;
}>;

type HermesToolGatewayBroker = {
  readonly HERMES_TOOL_GATEWAY_RUNTIME_PATHS: HermesToolGatewayRuntimePaths;
  readonly brokerRuntimeHash: () => string;
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
    const hostDir = path.join(installed.rootDir, "host");
    expect(installedBroker.HERMES_TOOL_GATEWAY_RUNTIME_PATHS).toEqual({
      packageRoot: installed.rootDir,
      hostDir,
      script: path.join(hostDir, "tool-gateway-broker.ts"),
      matrix: path.join(hostDir, "managed-tool-gateway-matrix.json"),
      runtimeCredentials: path.join(hostDir, "runtime-refresh-credentials.ts"),
      controlContract: path.join(hostDir, "tool-gateway-control-contract.ts"),
    });

    const installedHash = installedBroker.brokerRuntimeHash();
    expect(installedHash).not.toBe(bundledHash);
    fs.appendFileSync(
      installedBroker.HERMES_TOOL_GATEWAY_RUNTIME_PATHS.runtimeCredentials,
      "\n// test-only installed package change\n",
    );
    expect(() => loadBroker()).toThrow("installation receipt does not match package content");
  });
});
