// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  assertMatchingHarnessIdentity,
  harnessPackageIdentitiesEqual,
  inspectHarnessPackageState,
  isHarnessPackageIdentity,
  parseHarnessPackageIdentity,
  parseHarnessPackageMigration,
  serializeHarnessPackageIdentity,
  serializeHarnessPackageMigration,
} from "./identity";

const DIGEST = "a".repeat(64);
const IDENTITY = {
  kind: "agent-runtime",
  id: "openclaw",
  packageVersion: "1.2.3-beta.1+build.7",
  contentDigest: DIGEST,
} as const;
const MIGRATION = {
  schemaVersion: 1,
  source: "legacy-current-bundle",
  legacyAgent: null,
  migratedAt: "2026-08-28T02:00:00.000Z",
} as const;

describe("harness package identity", () => {
  it("parses, freezes, and serializes one exact canonical identity", () => {
    const parsed = parseHarnessPackageIdentity(IDENTITY);

    expect(parsed).toEqual(IDENTITY);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(serializeHarnessPackageIdentity(IDENTITY)).toBe(JSON.stringify(IDENTITY));
    expect(isHarnessPackageIdentity(IDENTITY)).toBe(true);
  });

  it.each([
    { ...IDENTITY, kind: "runtime" },
    { ...IDENTITY, id: "DeepAgents" },
    { ...IDENTITY, id: "../openclaw" },
    { ...IDENTITY, id: "https://example.invalid/openclaw" },
    { ...IDENTITY, id: "open\u0000claw" },
    { ...IDENTITY, packageVersion: "v1.2.3" },
    { ...IDENTITY, contentDigest: DIGEST.toUpperCase() },
    { ...IDENTITY, apiKey: "secret" },
    { kind: "agent-runtime", id: "openclaw" },
  ])("rejects a non-canonical or non-closed identity", (candidate) => {
    expect(isHarnessPackageIdentity(candidate)).toBe(false);
    expect(() => parseHarnessPackageIdentity(candidate)).toThrow();
  });

  it("accepts a canonical identity without limiting package IDs to the bundled examples", () => {
    expect(parseHarnessPackageIdentity({ ...IDENTITY, id: "deepagents" })).toEqual({
      ...IDENTITY,
      id: "deepagents",
    });
  });

  it("accepts a field-for-field identity match", () => {
    expect(harnessPackageIdentitiesEqual(IDENTITY, { ...IDENTITY })).toBe(true);
    expect(() => assertMatchingHarnessIdentity(IDENTITY, { ...IDENTITY })).not.toThrow();
  });

  it.each([
    { ...IDENTITY, id: "hermes" },
    { ...IDENTITY, packageVersion: "1.2.4" },
    { ...IDENTITY, contentDigest: "b".repeat(64) },
  ])("rejects an identity that differs in any authority field", (candidate) => {
    expect(harnessPackageIdentitiesEqual(IDENTITY, candidate)).toBe(false);
    expect(() => assertMatchingHarnessIdentity(IDENTITY, candidate)).toThrow(/do not match/u);
  });
});

describe("harness package migration provenance", () => {
  it("accepts null legacy agent only for OpenClaw", () => {
    expect(parseHarnessPackageMigration(MIGRATION, IDENTITY)).toEqual(MIGRATION);
  });

  it.each(["openclaw", "hermes", "langchain-deepagents-code"] as const)(
    "accepts same-name standard legacy mapping for %s",
    (id) => {
      const identity = { ...IDENTITY, id };
      const migration = { ...MIGRATION, legacyAgent: id };
      expect(parseHarnessPackageMigration(migration, identity)).toEqual(migration);
    },
  );

  it.each([
    [
      { ...MIGRATION, legacyAgent: null },
      { ...IDENTITY, id: "hermes" },
    ],
    [{ ...MIGRATION, legacyAgent: "hermes" }, IDENTITY],
    [
      { ...MIGRATION, legacyAgent: "deepagents" },
      { ...IDENTITY, id: "langchain-deepagents-code" },
    ],
    [
      { ...MIGRATION, legacyAgent: "pi" },
      { ...IDENTITY, id: "pi" },
    ],
    [
      { ...MIGRATION, legacyAgent: "nemocua" },
      { ...IDENTITY, id: "nemocua" },
    ],
    [{ ...MIGRATION, legacyAgent: "../openclaw" }, IDENTITY],
    [{ ...MIGRATION, legacyAgent: "https://example.invalid" }, IDENTITY],
    [{ ...MIGRATION, migratedAt: "2026-08-28T02:00:00Z" }, IDENTITY],
    [{ ...MIGRATION, migratedAt: "2026-08-28T02:00:00.000Z\u2028" }, IDENTITY],
    [{ ...MIGRATION, token: "secret" }, IDENTITY],
    [{ schemaVersion: 1, source: "legacy-current-bundle" }, IDENTITY],
  ])(
    "rejects unsafe, incomplete, candidate, alias, or mismatched provenance",
    (migration, identity) => {
      expect(() => parseHarnessPackageMigration(migration, identity)).toThrow();
    },
  );

  it("serializes only the four canonical migration fields", () => {
    expect(serializeHarnessPackageMigration(MIGRATION, IDENTITY)).toBe(JSON.stringify(MIGRATION));
    expect(Object.keys(parseHarnessPackageMigration(MIGRATION, IDENTITY))).toEqual([
      "schemaVersion",
      "source",
      "legacyAgent",
      "migratedAt",
    ]);
  });
});

describe("optional harness package state", () => {
  it("distinguishes legacy absence from valid and malformed present state", () => {
    expect(inspectHarnessPackageState(undefined, undefined)).toEqual({ status: "absent" });
    expect(inspectHarnessPackageState(null, null)).toEqual({ status: "absent" });
    expect(inspectHarnessPackageState(IDENTITY, null)).toEqual({
      status: "valid",
      harnessPackage: IDENTITY,
      harnessPackageMigration: null,
    });
    expect(inspectHarnessPackageState(IDENTITY, MIGRATION)).toEqual({
      status: "valid",
      harnessPackage: IDENTITY,
      harnessPackageMigration: MIGRATION,
    });
    expect(inspectHarnessPackageState(null, MIGRATION)).toEqual({ status: "invalid" });
    expect(inspectHarnessPackageState({ id: "openclaw" }, null)).toEqual({ status: "invalid" });
    expect(inspectHarnessPackageState(IDENTITY, { ...MIGRATION, legacyAgent: "hermes" })).toEqual({
      status: "invalid",
    });
  });
});
