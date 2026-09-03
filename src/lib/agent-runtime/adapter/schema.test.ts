// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { HarnessAdapterSchemaError, prepareHarnessAdapterValue } from "./schema";

const REQUEST_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["name", "entries"],
  properties: {
    name: { type: "string", minLength: 1 },
    entries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["enabled"],
        properties: { enabled: { type: "boolean" } },
      },
    },
  },
});

describe("harness adapter schema boundary", () => {
  it("returns a detached and deeply frozen JSON value", () => {
    const request = { name: "future-harness", entries: [{ enabled: true }] };
    const prepared = prepareHarnessAdapterValue<typeof request>({
      value: request,
      schema: REQUEST_SCHEMA,
      maxBytes: 1024,
      label: "Harness adapter request",
    });

    expect(prepared).toEqual(request);
    expect(prepared).not.toBe(request);
    expect(prepared.entries).not.toBe(request.entries);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.entries)).toBe(true);
    expect(Object.isFrozen(prepared.entries[0])).toBe(true);
  });

  it("rejects malformed values without including rejected data in the error", () => {
    const rejectedValue = "private-credential-sentinel";

    expect(() =>
      prepareHarnessAdapterValue({
        value: { name: rejectedValue, entries: [{ enabled: "yes" }] },
        schema: REQUEST_SCHEMA,
        maxBytes: 1024,
        label: "Harness adapter request",
      }),
    ).toThrowError(HarnessAdapterSchemaError);

    try {
      prepareHarnessAdapterValue({
        value: { name: rejectedValue, entries: [{ enabled: "yes" }] },
        schema: REQUEST_SCHEMA,
        maxBytes: 1024,
        label: "Harness adapter request",
      });
    } catch (error) {
      expect(String(error)).not.toContain(rejectedValue);
      expect(String(error)).not.toContain("enabled");
    }
  });

  it("rejects a valid-shaped value that exceeds the operation boundary", () => {
    expect(() =>
      prepareHarnessAdapterValue({
        value: { name: "x".repeat(100), entries: [] },
        schema: REQUEST_SCHEMA,
        maxBytes: 32,
        label: "Harness adapter request",
      }),
    ).toThrow(/exceeds its size boundary/u);
  });
});
