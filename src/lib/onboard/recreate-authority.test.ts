// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { HarnessPackageIdentity } from "../harness/package-identity";
import { createSession } from "../state/onboard-session";
import type { CheckpointSandboxRecreateTransactionV2 } from "../state/onboard-checkpoint-types";
import type { SandboxEntry } from "../state/registry/types";
import {
  advanceSandboxRecreateTransaction,
  beginSandboxRecreateTransaction,
  createSandboxRecreateRuntime,
  fingerprintSandboxRecreateValue,
  matchingSandboxRecreateTransaction,
  planSandboxRecreateRecovery,
  sandboxRecreateSourceProof,
  type SandboxRecreateObservation,
} from "./sandbox-recreate-transaction";

const PACKAGE: HarnessPackageIdentity = {
  kind: "agent-runtime",
  id: "openclaw",
  packageVersion: "1.2.3",
  contractVersion: 1,
  contentDigest: "a".repeat(64),
};
const SOURCE_ID = fingerprintSandboxRecreateValue("source");
const INTENT = fingerprintSandboxRecreateValue("intent");
const ENTRY: SandboxEntry = {
  name: "alpha",
  agent: "openclaw",
  harnessPackage: PACKAGE,
  gatewayName: "nemoclaw",
  gatewayPort: 8080,
};

function packageJournal() {
  const session = createSession({
    agent: "openclaw",
    sandboxName: "alpha",
    harnessPackage: PACKAGE,
  });
  const transaction = beginSandboxRecreateTransaction(session, {
    sandboxName: "alpha",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    sourceEntry: ENTRY,
    observation: { state: "ready", liveIdentityFingerprint: SOURCE_ID },
    targetIntentFingerprint: INTENT,
    id: "11111111-1111-4111-8111-111111111111",
    targetGeneration: "22222222-2222-4222-8222-222222222222",
    now: "2026-08-28T05:00:00.000Z",
  });
  return { session, transaction };
}

describe("sandbox recreate package authority", () => {
  it("copies the owning Session identity into the v2 transaction and source proof", () => {
    const { transaction } = packageJournal();

    expect(transaction).toMatchObject({ version: 2, harnessPackage: PACKAGE });
    expect(sandboxRecreateSourceProof(transaction).harnessPackage).toEqual(PACKAGE);
  });

  it("rejects Session drift before advancing the next recreate mutation", () => {
    const { session, transaction } = packageJournal();
    session.harnessPackage = { ...PACKAGE, contentDigest: "b".repeat(64) };

    expect(() => advanceSandboxRecreateTransaction(session, transaction.id, "deleting")).toThrow(
      "checkpoint package authority does not match its Session",
    );
    expect(session.checkpoint?.sandboxRecreate?.phase).toBe("planned");
  });

  it("rejects registry identity drift during recovery", () => {
    const { transaction } = packageJournal();
    expect(
      planSandboxRecreateRecovery(
        transaction,
        { state: "ready", liveIdentityFingerprint: SOURCE_ID },
        { ...ENTRY, harnessPackage: { ...PACKAGE, contentDigest: "c".repeat(64) } },
      ),
    ).toEqual({
      action: "reject",
      reason: "the registry row package authority does not match the recreate transaction",
    });
  });

  it("requires the exact package-bound handler handoff", () => {
    const { session, transaction } = packageJournal();
    expect(() =>
      matchingSandboxRecreateTransaction(session, {
        sandboxName: "alpha",
        gatewayName: "nemoclaw",
        transactionId: transaction.id,
        targetGeneration: transaction.targetGeneration,
        targetIntentFingerprint: transaction.targetIntentFingerprint,
        version: 2,
        harnessPackage: { ...PACKAGE, contentDigest: "d".repeat(64) },
      }),
    ).toThrow("does not match the requested replacement");
  });

  it("refuses ordinary mutation of a v1 journal before explicit migration", () => {
    const { session, transaction } = packageJournal();
    expect(transaction.version).toBe(2);
    const { harnessPackage: _harnessPackage, ...legacy } =
      transaction as CheckpointSandboxRecreateTransactionV2;
    session.checkpoint = {
      ...session.checkpoint!,
      sandboxRecreate: { ...legacy, version: 1 },
    };

    expect(() => advanceSandboxRecreateTransaction(session, transaction.id, "deleting")).toThrow(
      "requires package authority migration",
    );
  });

  it("rechecks registry authority at delete and post-delete boundaries", () => {
    const { session, transaction } = packageJournal();
    let entry: SandboxEntry | null = ENTRY;
    let observation: SandboxRecreateObservation = {
      state: "ready",
      liveIdentityFingerprint: SOURCE_ID,
    };
    const runtime = createSandboxRecreateRuntime(
      {
        loadSession: () => session,
        updateSession: (mutate) => mutate(session) ?? session,
      },
      {
        version: 2,
        id: transaction.id,
        targetGeneration: transaction.targetGeneration,
        targetIntentFingerprint: transaction.targetIntentFingerprint,
        harnessPackage: PACKAGE,
      },
      "alpha",
      "nemoclaw",
      ENTRY,
      () => observation,
      () => undefined,
      () => entry,
    );

    entry = { ...ENTRY, harnessPackage: { ...PACKAGE, contentDigest: "e".repeat(64) } };
    expect(() => runtime.beginDelete()).toThrow("registry package authority changed");
    expect(session.checkpoint?.sandboxRecreate?.phase).toBe("planned");

    entry = ENTRY;
    expect(runtime.beginDelete()).toBe("source");
    observation = { state: "missing", liveIdentityFingerprint: null };
    entry = { ...ENTRY, harnessPackage: { ...PACKAGE, contentDigest: "f".repeat(64) } };
    expect(() => runtime.confirmDeleted()).toThrow("registry package authority changed");
    expect(session.checkpoint?.sandboxRecreate?.phase).toBe("deleting");

    entry = null;
    expect(() => runtime.confirmDeleted()).not.toThrow();
    expect(session.checkpoint?.sandboxRecreate?.phase).toBe("deleted");
  });
});
