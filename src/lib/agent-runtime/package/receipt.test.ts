// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  assertHarnessPackageReceiptMatchesPointer,
  HARNESS_PACKAGE_POINTER_MAX_BYTES,
  HARNESS_PACKAGE_RECEIPT_MAX_BYTES,
  parseBundledHarnessPackageSourceIdentity,
  parseHarnessPackageActivePointer,
  parseHarnessPackageContentDigest,
  parseHarnessPackageId,
  parseHarnessPackageIdentity,
  parseHarnessPackageReceipt,
  parseHarnessPackageSourceIdentity,
  parseLocalHarnessPackageSourceIdentity,
  serializeHarnessPackageActivePointer,
  serializeHarnessPackageReceipt,
} from "./receipt";

const DIGEST = "a".repeat(64);
const SOURCE_REVISION = "b".repeat(40);
const IDENTITY = {
  kind: "agent-runtime",
  id: "deep-agents",
  packageVersion: "1.2.3-rc.1+build.4",
  contentDigest: DIGEST,
} as const;
const SOURCE_IDENTITY = {
  kind: "bundled",
  nemoclawBuildIdentity: {
    nemoclawVersion: "0.0.113-197-gbbbbbbb",
    sourceRevision: SOURCE_REVISION,
  },
} as const;
const RECEIPT = {
  schemaVersion: 1,
  identity: IDENTITY,
  sourceIdentity: SOURCE_IDENTITY,
  installedAt: "2026-08-27T19:04:05.006Z",
} as const;
const LOCAL_RECEIPT = {
  ...RECEIPT,
  sourceIdentity: { kind: "local" as const },
};
const POINTER = {
  schemaVersion: 1,
  id: IDENTITY.id,
  contentDigest: DIGEST,
} as const;

function receiptWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...RECEIPT, ...overrides };
}

function identityWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...IDENTITY, ...overrides };
}

function sourceIdentityWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...SOURCE_IDENTITY, ...overrides };
}

function pointerWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...POINTER, ...overrides };
}

describe("harness package receipt records", () => {
  it("parses one exact installation receipt", () => {
    expect(parseHarnessPackageReceipt(JSON.stringify(RECEIPT))).toEqual(RECEIPT);
  });

  it("parses and serializes local provenance without retaining its source path", () => {
    expect(parseHarnessPackageReceipt(JSON.stringify(LOCAL_RECEIPT))).toEqual(LOCAL_RECEIPT);
    expect(serializeHarnessPackageReceipt(LOCAL_RECEIPT)).toBe(
      `${JSON.stringify(LOCAL_RECEIPT, null, 2)}\n`,
    );
    expect(serializeHarnessPackageReceipt(LOCAL_RECEIPT)).not.toContain("sourcePath");
  });

  it("serializes a receipt with stable field order and a final newline", () => {
    expect(serializeHarnessPackageReceipt(RECEIPT)).toBe(`${JSON.stringify(RECEIPT, null, 2)}\n`);
  });

  it("parses one exact active pointer", () => {
    expect(parseHarnessPackageActivePointer(Buffer.from(JSON.stringify(POINTER)))).toEqual(POINTER);
  });

  it("serializes an active pointer with stable field order and a final newline", () => {
    expect(serializeHarnessPackageActivePointer(POINTER)).toBe(
      `${JSON.stringify(POINTER, null, 2)}\n`,
    );
  });

  it("accepts a receipt and active pointer that identify the same package bytes", () => {
    expect(() => assertHarnessPackageReceiptMatchesPointer(RECEIPT, POINTER)).not.toThrow();
  });

  it("validates path identity components before a store derives an address", () => {
    expect(parseHarnessPackageId(IDENTITY.id)).toBe(IDENTITY.id);
    expect(parseHarnessPackageContentDigest(DIGEST)).toBe(DIGEST);
  });

  it.each([
    ["an invalid ID", () => parseHarnessPackageId("../openclaw")],
    ["an invalid digest", () => parseHarnessPackageContentDigest(DIGEST.toUpperCase())],
  ])("rejects %s before package-store path derivation", (_case, parse) => {
    expect(parse).toThrow();
  });

  it.each([
    ["harness ID", pointerWith({ id: "openclaw" })],
    ["content digest", pointerWith({ contentDigest: "c".repeat(64) })],
  ])("rejects an active pointer with a different %s", (_field, pointer) => {
    expect(() => assertHarnessPackageReceiptMatchesPointer(RECEIPT, pointer)).toThrow(
      "Harness package receipt does not match its active pointer",
    );
  });

  it.each([
    ["an empty document", ""],
    ["an array", "[]"],
    ["a scalar", '"receipt"'],
    [
      "duplicate top-level fields",
      `${JSON.stringify(RECEIPT).slice(0, -1)},"installedAt":"2026-08-27T19:04:05.006Z"}`,
    ],
    [
      "duplicate escaped fields",
      '{"schemaVersion":1,"identity":{},"sourceIdentity":{},"installedAt":"2026-08-27T19:04:05.006Z","installed\\u0041t":"2026-08-27T19:04:05.006Z"}',
    ],
  ])("rejects a receipt JSON document with %s", (_case, source) => {
    expect(() => parseHarnessPackageReceipt(source)).toThrow();
  });

  it.each([
    ["text", `\uFEFF${JSON.stringify(RECEIPT)}`],
    [
      "bytes",
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(RECEIPT))]),
    ],
  ])("rejects a receipt JSON document with a byte-order mark in %s", (_case, source) => {
    expect(() => parseHarnessPackageReceipt(source)).toThrow(
      "Harness package receipt must contain valid UTF-8 JSON",
    );
  });

  it("rejects receipt bytes that are not valid UTF-8", () => {
    expect(() => parseHarnessPackageReceipt(Uint8Array.from([0xc3, 0x28]))).toThrow(
      "Harness package receipt must contain valid UTF-8 JSON",
    );
  });

  it("rejects a receipt before its JSON input exceeds the byte boundary", () => {
    const oversized = `{"padding":"${"x".repeat(HARNESS_PACKAGE_RECEIPT_MAX_BYTES)}"}`;
    expect(() => parseHarnessPackageReceipt(oversized)).toThrow(
      "Harness package receipt exceeds its JSON boundary",
    );
  });

  it("rejects an active pointer before its JSON input exceeds the byte boundary", () => {
    const oversized = `{"padding":"${"x".repeat(HARNESS_PACKAGE_POINTER_MAX_BYTES)}"}`;
    expect(() => parseHarnessPackageActivePointer(oversized)).toThrow(
      "Harness package active pointer exceeds its JSON boundary",
    );
  });

  it.each([
    ["an unknown field", receiptWith({ note: "not-authority" })],
    ["a credential-shaped field", receiptWith({ apiKey: "credential-value" })],
    ["an absolute source path", receiptWith({ sourcePath: "/private/source" })],
    ["an environment snapshot", receiptWith({ env: { HOME: "/private/home" } })],
    ["an executable value", receiptWith({ install: () => undefined })],
    ["a wrong schema version", receiptWith({ schemaVersion: 2 })],
    ["a missing identity", receiptWith({ identity: undefined })],
  ])("rejects a receipt with %s", (_case, receipt) => {
    expect(() => serializeHarnessPackageReceipt(receipt)).toThrow();
  });

  it("rejects an executable property without invoking it", () => {
    const invoked = { value: false };
    const receipt = { ...RECEIPT } as Record<string, unknown>;
    Object.defineProperty(receipt, "installedAt", {
      enumerable: true,
      get: () => {
        invoked.value = true;
        return RECEIPT.installedAt;
      },
    });
    expect(() => serializeHarnessPackageReceipt(receipt)).toThrow(
      "Harness package receipt fields must contain data values",
    );
    expect(invoked.value).toBe(false);
  });

  it.each([
    ["a wrong kind", identityWith({ kind: "runtime" })],
    ["an uppercase ID", identityWith({ id: "Deep-Agents" })],
    ["a leading separator in the ID", identityWith({ id: "-deep-agents" })],
    ["an overlong ID", identityWith({ id: `a${"b".repeat(63)}` })],
    ["a non-SemVer package version", identityWith({ packageVersion: "release" })],
    ["a leading-zero package version", identityWith({ packageVersion: "01.2.3" })],
    ["an uppercase digest", identityWith({ contentDigest: DIGEST.toUpperCase() })],
    ["a short digest", identityWith({ contentDigest: "a".repeat(63) })],
    ["an unknown field", identityWith({ receiptId: "mutable-token" })],
    ["a credential-shaped field", identityWith({ accessToken: "credential-value" })],
  ])("rejects a package identity with %s", (_case, identity) => {
    expect(() => parseHarnessPackageIdentity(identity)).toThrow();
  });

  it.each([
    ["a wrong kind", sourceIdentityWith({ kind: "local" })],
    ["an absolute source path", sourceIdentityWith({ path: "/private/source" })],
    ["a credential-shaped field", sourceIdentityWith({ token: "credential-value" })],
    [
      "an unknown build identity field",
      sourceIdentityWith({
        nemoclawBuildIdentity: {
          ...SOURCE_IDENTITY.nemoclawBuildIdentity,
          branch: "main",
        },
      }),
    ],
    [
      "an invalid NemoClaw version",
      sourceIdentityWith({
        nemoclawBuildIdentity: {
          ...SOURCE_IDENTITY.nemoclawBuildIdentity,
          nemoclawVersion: "development",
        },
      }),
    ],
    [
      "an uppercase source revision",
      sourceIdentityWith({
        nemoclawBuildIdentity: {
          ...SOURCE_IDENTITY.nemoclawBuildIdentity,
          sourceRevision: SOURCE_REVISION.toUpperCase(),
        },
      }),
    ],
    [
      "a source revision that disagrees with the described version",
      sourceIdentityWith({
        nemoclawBuildIdentity: {
          nemoclawVersion: "0.0.113-197-gccccccc",
          sourceRevision: SOURCE_REVISION,
        },
      }),
    ],
  ])("rejects a bundled source identity with %s", (_case, sourceIdentity) => {
    expect(() => parseBundledHarnessPackageSourceIdentity(sourceIdentity)).toThrow();
  });

  it("accepts only the closed local source identity", () => {
    expect(parseLocalHarnessPackageSourceIdentity({ kind: "local" })).toEqual({ kind: "local" });
    expect(parseHarnessPackageSourceIdentity({ kind: "local" })).toEqual({ kind: "local" });
    expect(() =>
      parseHarnessPackageSourceIdentity({ kind: "local", path: "/private/package" }),
    ).toThrow("source identity fields do not match");
    expect(() => parseHarnessPackageSourceIdentity({ kind: "remote" })).toThrow(
      "source identity kind is invalid",
    );
  });

  it.each([
    "2026-08-27T19:04:05Z",
    "2026-08-27T19:04:05.006+00:00",
    "2026-08-27t19:04:05.006z",
    "2026-02-30T19:04:05.006Z",
    "2026-08-27T19:04:05.006Z\n",
    "not-a-timestamp",
  ])("rejects the non-canonical installation timestamp %s", (installedAt) => {
    expect(() => parseHarnessPackageReceipt(JSON.stringify(receiptWith({ installedAt })))).toThrow(
      "Harness package installedAt must be a canonical UTC timestamp",
    );
  });

  it.each([
    ["an unknown field", pointerWith({ receiptId: "mutable-token" })],
    ["a credential-shaped field", pointerWith({ password: "credential-value" })],
    ["an absolute receipt path", pointerWith({ receiptPath: "/private/receipt.json" })],
    ["a wrong schema version", pointerWith({ schemaVersion: 2 })],
    ["an uppercase ID", pointerWith({ id: "Deep-Agents" })],
    ["an uppercase digest", pointerWith({ contentDigest: DIGEST.toUpperCase() })],
  ])("rejects an active pointer with %s", (_case, pointer) => {
    expect(() => serializeHarnessPackageActivePointer(pointer)).toThrow();
  });

  it("does not serialize ambient values that are absent from the closed receipt schema", () => {
    const serialized = serializeHarnessPackageReceipt(RECEIPT);
    expect(serialized).not.toContain(process.env.HOME);
    expect(serialized).not.toContain("sourcePath");
    expect(serialized).not.toContain("receiptId");
    expect(serialized).not.toContain("credential");
  });
});
