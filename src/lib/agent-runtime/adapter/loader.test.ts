// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineHarnessAdapterContract, defineHarnessAdapterOperation } from "./contract";
import { loadHarnessAdapter } from "./loader";
import { installHarnessPackage } from "../package/install";
import type { InstalledHarnessPackage } from "../package/store";

interface TestRequest {
  readonly value: string;
}

interface TestResult {
  readonly value: string;
}

const TEST_PARENT = path.join(process.cwd(), "node_modules/.cache/nemoclaw-adapter-loader-tests");
const SOURCE_IDENTITY = Object.freeze({
  kind: "bundled" as const,
  nemoclawBuildIdentity: Object.freeze({
    nemoclawVersion: "0.0.113",
    sourceRevision: "f".repeat(40),
  }),
});
const TEST_CONTRACT = defineHarnessAdapterContract({
  displayName: "test plan adapter",
  modulePath: "host/test-adapter.cts",
  manifestSchema: {
    type: "object",
    required: ["name"],
    properties: { name: { const: "future-harness" } },
  },
  sourceMaxBytes: 32 * 1024,
  requestMaxBytes: 1024,
  resultMaxBytes: 1024,
  operations: {
    build: defineHarnessAdapterOperation<TestRequest, TestResult>({
      exportName: "buildTestPlan",
      requestSchema: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: { type: "string", maxLength: 256 } },
      },
      resultSchema: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: { type: "string", maxLength: 512 } },
      },
      resultDescription: "test plan",
    }),
  },
});

fs.mkdirSync(TEST_PARENT, { recursive: true, mode: 0o700 });

let fixtureRoot = path.join(TEST_PARENT, "unused");
let sourceRoot = path.join(fixtureRoot, "source");
let storeRoot = path.join(fixtureRoot, "store");

function writeFixtureFile(relativePath: string, contents: string): void {
  const target = path.join(sourceRoot, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, contents, { mode: 0o600 });
}

function installTestPackage(moduleSource: string): InstalledHarnessPackage {
  writeFixtureFile(
    "nemoclaw-package.json",
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "agent-runtime",
      id: "future-harness",
      displayName: "Future Harness",
      packageVersion: "1.0.0",
      manifest: "packages/nemoclaw-future-harness/manifest.yaml",
    })}\n`,
  );
  writeFixtureFile("packages/nemoclaw-future-harness/manifest.yaml", "name: future-harness\n");
  writeFixtureFile("packages/nemoclaw-future-harness/host/test-adapter.cts", moduleSource);
  return installHarnessPackage(
    { packageRoot: sourceRoot, sourceIdentity: SOURCE_IDENTITY },
    { storeRoot },
  );
}

function loadTestAdapter(moduleSource: string) {
  const installed = installTestPackage(moduleSource);
  return loadHarnessAdapter(installed.identity, TEST_CONTRACT, { storeRoot });
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(TEST_PARENT, "fixture-"));
  fs.chmodSync(fixtureRoot, 0o700);
  sourceRoot = path.join(fixtureRoot, "source");
  storeRoot = path.join(fixtureRoot, "store");
  fs.mkdirSync(storeRoot, { recursive: true, mode: 0o700 });
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("typed harness adapter loader", () => {
  it("keeps host constructors and ambient capabilities outside package operations", () => {
    const adapter = loadTestAdapter(`
module.exports = {
  buildTestPlan(request) {
    const attempts = [
      () => module.constructor.constructor("return process")(),
      () => exports.constructor.constructor("return process")(),
      () => require.constructor("return process")(),
      () => request.constructor.constructor("return process")(),
      () => Function("return process")(),
      () => eval("process"),
      () => (async () => {}).constructor("return process")(),
    ];
    let escaped = false;
    for (const attempt of attempts) {
      try {
        escaped = Boolean(attempt()) || escaped;
      } catch {}
    }
    let wasm = "blocked";
    try {
      new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
      wasm = "compiled";
    } catch {}
    return {
      value: [
        escaped ? "escaped" : "isolated",
        wasm,
        typeof process,
        typeof Buffer,
        typeof setTimeout,
        typeof setInterval,
        typeof fetch,
        typeof globalThis.require,
      ].join(":"),
    };
  },
};
`);

    expect(adapter.build({ value: "probe" })).toEqual({
      value: "isolated:blocked:undefined:undefined:undefined:undefined:undefined:undefined",
    });
  });

  it("bounds package initialization", () => {
    expect(() =>
      loadTestAdapter(`
while (true) {}
module.exports = { buildTestPlan(request) { return request; } };
`),
    ).toThrow(/could not be evaluated/u);
  });

  it("bounds every package operation", () => {
    const adapter = loadTestAdapter(`
module.exports = { buildTestPlan() { while (true) {} } };
`);

    expect(() => adapter.build({ value: "probe" })).toThrow(/buildTestPlan failed/u);
  });

  it.each([
    ["a promise", "return Promise.resolve({ value: request.value });"],
    ["a function", "return () => request.value;"],
    ["a symbol", "return Symbol(request.value);"],
    ["a bigint", "return 1n;"],
    [
      "a cyclic object",
      "const result = { value: request.value }; result.self = result; return result;",
    ],
  ])("rejects %s rather than carrying it across the JSON boundary", (_label, body) => {
    const adapter = loadTestAdapter(`
module.exports = { buildTestPlan(request) { ${body} } };
`);

    expect(() => adapter.build({ value: "probe" })).toThrow(/buildTestPlan failed/u);
  });

  it("deep-freezes the detached request and returns a frozen host value", () => {
    const adapter = loadTestAdapter(`
module.exports = {
  buildTestPlan(request) {
    let changed = false;
    try { request.value = "changed"; changed = true; } catch {}
    return { value: [Object.isFrozen(request), changed, request.value].join(":") };
  },
};
`);

    const result = adapter.build({ value: "original" });
    expect(result).toEqual({ value: "true:false:original" });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("clears call state after an adapter failure", () => {
    const adapter = loadTestAdapter(`
let callCount = 0;
module.exports = {
  buildTestPlan(request) {
    callCount += 1;
    if (callCount === 1) throw new Error("first call fails");
    return { value: request.value };
  },
};
`);

    expect(() => adapter.build({ value: "first" })).toThrow(/buildTestPlan failed/u);
    expect(adapter.build({ value: "second" })).toEqual({ value: "second" });
  });

  it("rejects results before they cross the configured size boundary", () => {
    const adapter = loadTestAdapter(`
module.exports = { buildTestPlan() { return { value: "x".repeat(2000) }; } };
`);

    expect(() => adapter.build({ value: "probe" })).toThrow(/buildTestPlan failed/u);
  });
});
