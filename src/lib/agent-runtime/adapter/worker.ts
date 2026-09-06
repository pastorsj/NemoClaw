// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import vm from "node:vm";

const MAX_INPUT_BYTES = 70 * 1024 * 1024;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_BYTES = 64 * 1024 * 1024;
const MAX_OPERATIONS = 32;
const EVALUATION_TIMEOUT_MS = 500;

interface AdapterWorkerRequest {
  readonly source: string;
  readonly filename: string;
  readonly operations: readonly (readonly [string, string])[];
  readonly operationName?: string;
  readonly request?: unknown;
  readonly resultMaxBytes: number;
}

function fail(code: string): never {
  fs.writeFileSync(1, `error:${code}`);
  process.exit(0);
}

function readBoundedInput(): string {
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let totalBytes = 0;
  while (true) {
    const count = fs.readSync(0, buffer, 0, buffer.length, null);
    if (count === 0) break;
    totalBytes += count;
    if (totalBytes > MAX_INPUT_BYTES) fail("input");
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

function parseRequest(): AdapterWorkerRequest {
  let value: unknown;
  try {
    value = JSON.parse(readBoundedInput()) as unknown;
  } catch {
    fail("input");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("input");
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "source",
    "filename",
    "operations",
    "operationName",
    "request",
    "resultMaxBytes",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) fail("input");
  if (
    typeof record.source !== "string" ||
    Buffer.byteLength(record.source, "utf8") > MAX_SOURCE_BYTES ||
    typeof record.filename !== "string" ||
    record.filename.length === 0 ||
    record.filename.length > 4096 ||
    !Array.isArray(record.operations) ||
    record.operations.length === 0 ||
    record.operations.length > MAX_OPERATIONS ||
    !Number.isSafeInteger(record.resultMaxBytes) ||
    (record.resultMaxBytes as number) <= 0 ||
    (record.resultMaxBytes as number) > MAX_RESULT_BYTES
  ) {
    fail("input");
  }
  const operations = record.operations as unknown[];
  if (
    operations.some(
      (entry) =>
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        entry.some(
          (item) =>
            typeof item !== "string" ||
            item.length === 0 ||
            item.length > 128 ||
            !/^[A-Za-z_$][A-Za-z0-9_$-]*$/u.test(item),
        ),
    )
  ) {
    fail("input");
  }
  if (
    record.operationName !== undefined &&
    (typeof record.operationName !== "string" ||
      !operations.some((entry) => (entry as unknown[])[0] === record.operationName))
  ) {
    fail("input");
  }
  return record as unknown as AdapterWorkerRequest;
}

function buildRuntimeSource(input: AdapterWorkerRequest): string {
  const invoke =
    input.operationName === undefined
      ? "return 'ready';"
      : `
  try {
    const request = freezeJson(${JSON.stringify(input.request)});
    const result = builders[${JSON.stringify(input.operationName)}](request);
    if (
      result instanceof promiseConstructor ||
      (result !== null &&
        (typeof result === "object" || typeof result === "function") &&
        (reflectApply(objectToString, result, []) === "[object Promise]" ||
          typeof result.then === "function"))
    ) {
      return "error:async";
    }
    const resultJson = jsonStringify(result);
    if (typeof resultJson !== "string") return "error:serialization";
    return "ok:" + resultJson;
  } catch {
    return "error:operation";
  }`;
  return `
"use strict";
(() => {
  const arrayIsArray = Array.isArray;
  const jsonStringify = JSON.stringify;
  const objectCreate = Object.create;
  const objectFreeze = Object.freeze;
  const objectIsFrozen = Object.isFrozen;
  const objectValues = Object.values;
  const reflectApply = Reflect.apply;
  const objectToString = Object.prototype.toString;
  const promiseConstructor = Promise;
  const operationEntries = ${JSON.stringify(input.operations)};
  const moduleRecord = objectCreate(null);
  const initialExports = objectCreate(null);
  moduleRecord.exports = initialExports;
  const unavailableRequire = (specifier) => {
    const error = new Error("Harness adapter imports are unavailable");
    error.code = "NEMOCLAW_ADAPTER_IMPORT_UNAVAILABLE";
    error.specifier = String(specifier);
    throw error;
  };

  try {
    (function (exports, require, module, __filename, __dirname) {
      "use strict";
${input.source}
    })(initialExports, unavailableRequire, moduleRecord, ${JSON.stringify(input.filename)}, "<adapter>");
  } catch (error) {
    return error && error.code === "NEMOCLAW_ADAPTER_IMPORT_UNAVAILABLE"
      ? "error:import"
      : "error:evaluation";
  }

  const moduleExports = moduleRecord.exports;
  if (moduleExports === null || typeof moduleExports !== "object" || arrayIsArray(moduleExports)) {
    return "error:exports";
  }
  const builders = objectCreate(null);
  try {
    for (let index = 0; index < operationEntries.length; index += 1) {
      const operationName = operationEntries[index][0];
      const exportName = operationEntries[index][1];
      const builder = moduleExports[exportName];
      if (typeof builder !== "function") return "error:missing:" + String(index);
      builders[operationName] = builder;
    }
  } catch {
    return "error:evaluation";
  }
  objectFreeze(builders);
  const freezeJson = (value) => {
    if (value === null || typeof value !== "object" || objectIsFrozen(value)) return value;
    for (const entry of objectValues(value)) freezeJson(entry);
    return objectFreeze(value);
  };
  ${invoke}
})()
`;
}

const input = parseRequest();
try {
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: "afterEvaluate",
  });
  const result = new vm.Script(buildRuntimeSource(input), {
    filename: input.filename,
  }).runInContext(context, { timeout: EVALUATION_TIMEOUT_MS, displayErrors: false });
  if (typeof result !== "string") fail("evaluation");
  if (result.startsWith("ok:")) {
    const resultJson = result.slice("ok:".length);
    if (Buffer.byteLength(resultJson, "utf8") > input.resultMaxBytes) fail("oversized");
  }
  fs.writeFileSync(1, result);
} catch {
  fail("evaluation");
}
