// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const candidateAuthority = vi.hoisted(() => ({ digests: [] as string[] }));

vi.mock("../agent/candidate-authority", () => ({
  CANDIDATE_QUALIFICATION_RECEIPT_DIGESTS: { pi: candidateAuthority.digests },
  acceptedCandidateReceiptDigests: () => candidateAuthority.digests,
}));

import {
  type CandidateQualificationFixture,
  candidateQualificationEnvironment,
} from "../agent/candidate-test-fixture";
import { installHarnessPackage } from "../harness/package-install";
import { HarnessPackageStoreIntegrityError } from "../harness/package-store";
import type { HarnessPackageMigration } from "../harness/package-identity";
import {
  createPromptValidatedSandboxName,
  resolveLegacyBackupRecoveryOwner,
  resolveSandboxAgent,
} from "./sandbox-agent";

const TEST_PARENT = path.join(process.cwd(), "node_modules/.cache/nemoclaw-sandbox-agent-tests");
const SOURCE_IDENTITY = {
  kind: "bundled",
  nemoclawBuildIdentity: {
    nemoclawVersion: "0.0.113",
    sourceRevision: "a".repeat(40),
  },
} as const;
fs.mkdirSync(TEST_PARENT, { recursive: true, mode: 0o700 });

let fixtureRoot = path.join(TEST_PARENT, "unused");
let sourceRoot = path.join(fixtureRoot, "source");
let storeRoot = path.join(fixtureRoot, "store");
const qualificationFixtures: CandidateQualificationFixture[] = [];

function writeFixtureFile(relativePath: string, contents: string): void {
  const target = path.join(sourceRoot, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, contents, { mode: 0o600 });
}

function writeOpenClawPackage(packageVersion = "1.0.0", displayName = "Pinned OpenClaw"): void {
  fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
  writeFixtureFile(
    "nemoclaw-package.json",
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "agent-runtime",
      id: "openclaw",
      displayName,
      packageVersion,
      contractVersion: 1,
      manifest: "agents/openclaw/manifest.yaml",
    })}\n`,
  );
  writeFixtureFile(
    "agents/openclaw/manifest.yaml",
    `name: openclaw\ndisplay_name: ${displayName}\nbinary_path: /usr/local/bin/openclaw\n`,
  );
  writeFixtureFile("runtime/payload.txt", `${packageVersion}\n`);
}

function installOpenClawPackage() {
  return installHarnessPackage(
    { packageRoot: sourceRoot, sourceIdentity: SOURCE_IDENTITY },
    { storeRoot },
  );
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(TEST_PARENT, "fixture-"));
  fs.chmodSync(fixtureRoot, 0o700);
  sourceRoot = path.join(fixtureRoot, "source");
  storeRoot = path.join(fixtureRoot, "store");
  fs.mkdirSync(storeRoot, { mode: 0o700 });
  writeOpenClawPackage();
});

afterEach(() => {
  vi.restoreAllMocks();
  candidateAuthority.digests.splice(0, candidateAuthority.digests.length);
  while (qualificationFixtures.length > 0) qualificationFixtures.pop()?.cleanup();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("sandbox agent authority", () => {
  it("preserves the OpenClaw null sentinel while returning its exact package definition", () => {
    const installed = installOpenClawPackage();
    const migration: HarnessPackageMigration = {
      schemaVersion: 1,
      source: "legacy-current-bundle",
      legacyAgent: null,
      migratedAt: "2026-08-27T12:00:00.000Z",
    };

    const resolved = resolveSandboxAgent(
      {
        agent: null,
        harnessPackage: installed.identity,
        harnessPackageMigration: migration,
      },
      { storeRoot },
    );

    expect(resolved.recordedAgent).toBeNull();
    expect(resolved.effectiveAgentId).toBe("openclaw");
    expect(resolved.definition.name).toBe("openclaw");
    expect(resolved.definition.packageRoot).toBe(installed.packageRoot);
    expect(resolved.harnessPackage).toEqual(installed.identity);
    expect(resolved.harnessPackageMigration).toEqual(migration);
  });

  it("resolves the recorded digest after the active pointer advances", () => {
    const first = installOpenClawPackage();
    writeOpenClawPackage("1.1.0", "New Active OpenClaw");
    const second = installOpenClawPackage();

    const resolved = resolveSandboxAgent(
      { agent: null, harnessPackage: first.identity },
      { storeRoot },
    );

    expect(second.identity.contentDigest).not.toBe(first.identity.contentDigest);
    expect(resolved.harnessPackage).toEqual(first.identity);
    expect(resolved.definition.packageRoot).toBe(first.packageRoot);
    expect(resolved.definition.displayName).toBe("Pinned OpenClaw");
  });

  it("fails closed when the recorded package object is missing", () => {
    const installed = installOpenClawPackage();
    fs.rmSync(installed.packageRoot, { recursive: true });

    expect(() =>
      resolveSandboxAgent({ agent: null, harnessPackage: installed.identity }, { storeRoot }),
    ).toThrow(HarnessPackageStoreIntegrityError);
  });

  it("rejects standard rows that lack exact package migration authority", () => {
    expect(() => resolveSandboxAgent({ agent: null }, { storeRoot })).toThrow(
      /requires legacy package migration/u,
    );
    expect(() => resolveSandboxAgent({ agent: "hermes" }, { storeRoot })).toThrow(
      /requires legacy package migration/u,
    );
  });

  it("rejects malformed provenance and agent-to-package mismatches", () => {
    const installed = installOpenClawPackage();

    expect(() =>
      resolveSandboxAgent(
        {
          agent: null,
          harnessPackage: installed.identity,
          harnessPackageMigration: {
            schemaVersion: 1,
            source: "legacy-current-bundle",
            legacyAgent: "hermes",
            migratedAt: "2026-08-27T12:00:00.000Z",
          },
        },
        { storeRoot },
      ),
    ).toThrow(/malformed/u);
    expect(() =>
      resolveSandboxAgent({ agent: "hermes", harnessPackage: installed.identity }, { storeRoot }),
    ).toThrow(/does not match/u);
  });

  it.each([
    ["number", 1],
    ["empty string", ""],
    ["whitespace", " "],
    ["wrapped identifier", " openclaw "],
    ["noncanonical identifier", "OpenClaw"],
  ])("rejects a %s instead of coercing it to OpenClaw", (_label, agent) => {
    const installed = installOpenClawPackage();
    const entry = {
      agent,
      harnessPackage: installed.identity,
      harnessPackageMigration: null,
    } as unknown as Parameters<typeof resolveSandboxAgent>[0];

    expect(() => resolveSandboxAgent(entry, { storeRoot })).toThrow(/recorded agent/u);
  });

  it("keeps qualified Pi on repository authority without a fabricated package identity", () => {
    const qualification = candidateQualificationEnvironment();
    qualificationFixtures.push(qualification);
    candidateAuthority.digests.push(qualification.receiptDigest);

    const resolved = resolveSandboxAgent({ agent: "pi" }, { storeRoot, env: qualification.env });

    expect(resolved.recordedAgent).toBe("pi");
    expect(resolved.effectiveAgentId).toBe("pi");
    expect(resolved.definition.name).toBe("pi");
    expect(resolved.harnessPackage).toBeNull();
    expect(resolved.harnessPackageMigration).toBeNull();
  });

  it("re-reads qualified repository definitions as detached immutable authority", () => {
    const qualification = candidateQualificationEnvironment();
    qualificationFixtures.push(qualification);
    candidateAuthority.digests.push(qualification.receiptDigest);

    const first = resolveSandboxAgent({ agent: "pi" }, { storeRoot, env: qualification.env });
    const second = resolveSandboxAgent({ agent: "pi" }, { storeRoot, env: qualification.env });

    expect(first.definition).toEqual(second.definition);
    expect(first.definition).not.toBe(second.definition);
    expect(Object.isFrozen(first.definition)).toBe(true);
    expect(Object.isFrozen(first.definition.stateFiles)).toBe(true);
    expect(() => {
      (first.definition.stateFiles as unknown as unknown[]).push({ path: "changed" });
    }).toThrow(TypeError);
  });

  it("keeps NemoCUA behind its existing feature gate and outside package authority", () => {
    expect(() => resolveSandboxAgent({ agent: "nemocua" }, { storeRoot, env: {} })).toThrow(
      /NemoCUA is disabled/u,
    );

    const resolved = resolveSandboxAgent(
      { agent: "nemocua" },
      { storeRoot, env: { NEMOCLAW_CUA_ENABLED: "1" } },
    );
    expect(resolved.definition.name).toBe("nemocua");
    expect(resolved.harnessPackage).toBeNull();
    expect(resolved.harnessPackageMigration).toBeNull();
  });

  it("rejects package authority on a separately qualified candidate row", () => {
    const installed = installOpenClawPackage();

    expect(() =>
      resolveSandboxAgent({ agent: "pi", harnessPackage: installed.identity }, { storeRoot }),
    ).toThrow(/must not carry harness package authority/u);
  });

  it("accepts an installed legacy backup owner with matching migration provenance", () => {
    const installed = installOpenClawPackage();
    const migration: HarnessPackageMigration = {
      schemaVersion: 1,
      source: "legacy-current-bundle",
      legacyAgent: null,
      migratedAt: "2026-08-27T12:00:00.000Z",
    };

    expect(
      resolveLegacyBackupRecoveryOwner(
        {
          agent: null,
          harnessPackage: installed.identity,
          harnessPackageMigration: migration,
        },
        { storeRoot },
      ),
    ).toBeNull();
  });

  it.each([
    ["missing", undefined],
    [
      "mismatched",
      {
        schemaVersion: 1,
        source: "legacy-current-bundle",
        legacyAgent: "hermes",
        migratedAt: "2026-08-27T12:00:00.000Z",
      },
    ],
  ] as const)(
    "rejects an installed legacy backup owner with %s migration provenance",
    (_label, migration) => {
      const installed = installOpenClawPackage();

      expect(() =>
        resolveLegacyBackupRecoveryOwner(
          {
            agent: null,
            harnessPackage: installed.identity,
            harnessPackageMigration: migration,
          },
          { storeRoot },
        ),
      ).toThrow(/migration|malformed/u);
    },
  );
});

describe("sandbox name prompt", () => {
  it("waits for a validated-name checkpoint before returning it to onboarding (#8687)", async () => {
    let release: (() => void) | undefined;
    const checkpointStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    let persisted = false;
    const checkpointSandboxName = vi.fn(async () => {
      await checkpointStarted;
      persisted = true;
    });
    const promptValidatedSandboxName = createPromptValidatedSandboxName({
      promptOrDefault: vi.fn(async () => "tm"),
      cliDisplayName: () => "NemoClaw",
      isNonInteractive: () => false,
      checkpointSandboxName,
      exit: (code) => {
        throw new Error(`unexpected exit ${code}`);
      },
    });

    const result = promptValidatedSandboxName();
    await Promise.resolve();
    expect(persisted).toBe(false);
    release?.();
    await expect(result).resolves.toBe("tm");
    expect(persisted).toBe(true);
    expect(checkpointSandboxName).toHaveBeenCalledWith("tm", null);
  });

  it("propagates a checkpoint failure without treating the name as invalid (#6743)", async () => {
    const checkpointError = new Error("session write failed");
    const promptOrDefault = vi.fn(async () => "tm");
    const promptValidatedSandboxName = createPromptValidatedSandboxName({
      promptOrDefault,
      cliDisplayName: () => "NemoClaw",
      isNonInteractive: () => false,
      checkpointSandboxName: async () => {
        throw checkpointError;
      },
      exit: (code) => {
        throw new Error(`unexpected exit ${code}`);
      },
    });

    await expect(promptValidatedSandboxName()).rejects.toBe(checkpointError);
    expect(promptOrDefault).toHaveBeenCalledTimes(1);
  });

  it("uses the reviewed sandbox name as the edit default (#6005)", async () => {
    const promptOrDefault = vi.fn(async (_question, _envVar, defaultValue) => defaultValue);
    const promptValidatedSandboxName = createPromptValidatedSandboxName({
      promptOrDefault,
      cliDisplayName: () => "NemoClaw",
      isNonInteractive: () => false,
      checkpointSandboxName: vi.fn(async () => undefined),
      exit: (code) => {
        throw new Error(`unexpected exit ${code}`);
      },
    });

    await expect(promptValidatedSandboxName(null, "reviewed-name")).resolves.toBe("reviewed-name");

    expect(promptOrDefault).toHaveBeenCalledWith(
      expect.stringContaining("[reviewed-name]"),
      "NEMOCLAW_SANDBOX_NAME",
      "reviewed-name",
    );
  });
});
