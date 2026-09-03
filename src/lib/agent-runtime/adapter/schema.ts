// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AnySchemaObject, ValidateFunction } from "ajv";
import Ajv from "ajv/dist/2020.js";

const schemaValidators = new WeakMap<AnySchemaObject, ValidateFunction<unknown>>();

export class HarnessAdapterSchemaError extends Error {
  override readonly name = "HarnessAdapterSchemaError";
}

function schemaValidator(schema: AnySchemaObject): ValidateFunction<unknown> {
  const cached = schemaValidators.get(schema);
  if (cached) return cached;

  let validator: ValidateFunction<unknown>;
  try {
    validator = new Ajv({ allErrors: true, strict: true }).compile(schema);
  } catch (error) {
    throw new HarnessAdapterSchemaError("Harness adapter schema could not be initialized", {
      cause: error,
    });
  }
  schemaValidators.set(schema, validator);
  return validator;
}

function cloneJsonBoundary(value: unknown, maxBytes: number, label: string): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new HarnessAdapterSchemaError(`${label} must be JSON-compatible`, { cause: error });
  }
  if (serialized === undefined) {
    throw new HarnessAdapterSchemaError(`${label} must be JSON-compatible`);
  }
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new HarnessAdapterSchemaError(`${label} exceeds its size boundary`);
  }
  return JSON.parse(serialized) as unknown;
}

function freezeJsonBoundary(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Array.isArray(value) ? value : Object.values(value)) {
    freezeJsonBoundary(entry);
  }
  return Object.freeze(value);
}

/** Clone, bound, validate, and freeze one value before it crosses an adapter boundary. */
export function prepareHarnessAdapterValue<T>(options: {
  readonly value: unknown;
  readonly schema: AnySchemaObject;
  readonly maxBytes: number;
  readonly label: string;
}): T {
  const cloned = cloneJsonBoundary(options.value, options.maxBytes, options.label);
  const validate = schemaValidator(options.schema);
  if (!validate(cloned)) {
    // Schema errors deliberately omit paths, parameters, and rejected values. Adapter requests
    // can contain credential placeholders and adapter results can contain untrusted native output.
    throw new HarnessAdapterSchemaError(`${options.label} does not satisfy its schema`);
  }
  return freezeJsonBoundary(cloned) as T;
}
