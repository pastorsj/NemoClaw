// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { HarnessPackageIdentity } from "../agent-runtime/package/identity";
import { deriveCheckpointFromSession } from "../state/onboard-checkpoint-migrate";
import { createSession, type Session } from "../state/onboard-session";
import {
  recordCheckpointEffectGroup,
  recordCheckpointMessaging,
  recordCheckpointProviderEffectGroup,
  recordCheckpointProviderEffectGroups,
  recordCheckpointResourceProfile,
  recordCheckpointSandboxIdentity,
  recordCheckpointWebSearch,
} from "./checkpoint-record";

const PACKAGE: HarnessPackageIdentity = {
  kind: "agent-runtime",
  id: "openclaw",
  packageVersion: "1.2.3",
  contentDigest: "a".repeat(64),
};

function packageSession(): Session {
  const session = createSession({ agent: "openclaw", harnessPackage: PACKAGE });
  session.checkpoint = deriveCheckpointFromSession(session);
  return session;
}

const RECORDERS: readonly [string, (session: Session) => void][] = [
  ["sandbox identity", (session) => recordCheckpointSandboxIdentity(session, "alpha", "openclaw")],
  ["effect group", (session) => recordCheckpointEffectGroup(session, "sandbox_create", "fp")],
  ["web search", (session) => recordCheckpointWebSearch(session, null)],
  ["messaging", (session) => recordCheckpointMessaging(session, null)],
  ["resource profile", (session) => recordCheckpointResourceProfile(session, null)],
  [
    "provider groups",
    (session) => recordCheckpointProviderEffectGroups(session, { webSearch: [], messaging: [] }),
  ],
  [
    "provider group",
    (session) => recordCheckpointProviderEffectGroup(session, "web_search_provider", []),
  ],
];

describe("checkpoint writer package authority", () => {
  it.each(RECORDERS)("retains exact identity through the %s writer", (_name, record) => {
    const session = packageSession();
    record(session);
    expect(session.checkpoint?.harnessPackage).toEqual(PACKAGE);
  });

  it.each(RECORDERS)("rejects authority drift before the %s writer", (_name, record) => {
    const session = packageSession();
    session.checkpoint = { ...session.checkpoint!, harnessPackage: null };
    const before = session.checkpoint;

    expect(() => record(session)).toThrow("harness package authority does not match Session");
    expect(session.checkpoint).toBe(before);
  });

  it("rejects a legacy recreate transaction before recording another receipt", () => {
    const session = packageSession();
    session.checkpoint = {
      ...session.checkpoint!,
      sandboxRecreate: {
        version: 1,
        id: "11111111-1111-4111-8111-111111111111",
        revision: 0,
        sandboxName: "alpha",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        sourceRegistryFingerprint: "b".repeat(64),
        sourceLiveIdentityFingerprint: null,
        sourceWorkload: null,
        targetIntentFingerprint: "c".repeat(64),
        targetGeneration: "22222222-2222-4222-8222-222222222222",
        targetLiveIdentityFingerprint: null,
        phase: "deleted",
        startedAt: "2026-08-28T05:00:00.000Z",
        updatedAt: "2026-08-28T05:00:00.000Z",
      },
    };

    expect(() => recordCheckpointEffectGroup(session, "sandbox_create", "fp")).toThrow(
      "requires authority migration",
    );
  });
});
