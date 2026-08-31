// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createHarnessPackageFixture,
  type HarnessPackageFixture,
} from "../../../../test/helpers/harness-packages";
import { loadAgent } from "../../agent/defs";
import { deriveCheckpointFromSession } from "../../state/onboard-checkpoint-migrate";
import type { CheckpointSandboxRecreateTransactionV1 } from "../../state/onboard-checkpoint-types";
import { createSession, type Session } from "../../state/onboard-session";
import type { SandboxRegistry } from "../../state/registry/types";
import { resolveSandboxAgent } from "../sandbox-agent";
import { createOnboardHarnessPackageBoundary } from "./boundary";
import type { OnboardHarnessPackageBoundaryDependencies } from "./boundary";

let fixture: HarnessPackageFixture;

function legacyTransaction(): CheckpointSandboxRecreateTransactionV1 {
  return {
    version: 1,
    id: "11111111-1111-4111-8111-111111111111",
    revision: 1,
    sandboxName: "alpha",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    sourceRegistryFingerprint: "a".repeat(64),
    sourceLiveIdentityFingerprint: null,
    sourceWorkload: null,
    targetIntentFingerprint: "b".repeat(64),
    targetGeneration: "22222222-2222-4222-8222-222222222222",
    targetLiveIdentityFingerprint: null,
    phase: "deleted",
    startedAt: "2026-08-28T05:00:00.000Z",
    updatedAt: "2026-08-28T05:00:00.000Z",
  };
}

function checkpointSession(session: Session): Session {
  session.checkpoint = {
    ...deriveCheckpointFromSession(session),
    harnessPackage: null,
    sandboxRecreate: legacyTransaction(),
  };
  return session;
}

function boundaryFor(
  readSession: () => Session,
  writeSession: (session: Session) => void,
  readRegistry: () => SandboxRegistry,
  resolveQualifiedAgent: OnboardHarnessPackageBoundaryDependencies["resolveQualifiedAgent"] = vi.fn(
    () => null,
  ),
) {
  return createOnboardHarnessPackageBoundary({
    assertOnboardLockOwned: vi.fn(),
    loadSession: readSession,
    loadRegistry: readRegistry,
    compareAndSwapSession: (matches, mutate) => {
      const current = structuredClone(readSession());
      return matches(current)
        ? (() => {
            writeSession(mutate(current) ?? current);
            return "updated" as const;
          })()
        : "mismatch";
    },
    getStoreRoot: () => fixture.storeRoot,
    resolveQualifiedAgent,
    resolveSandboxAgent,
  });
}

async function prepareResume(boundary: ReturnType<typeof boundaryFor>) {
  return boundary.prepare({
    agentFlag: null,
    canPrompt: false,
    environment: {},
    log: vi.fn(),
    prompt: vi.fn(async () => "1"),
    resume: true,
    rootDir: fixture.fixtureRoot,
  });
}

beforeEach(() => {
  fixture = createHarnessPackageFixture();
});

afterEach(() => {
  fixture.cleanup();
});

describe("pre-effect checkpoint package authority", () => {
  it("upgrades package checkpoint and v1 journal before returning bound authority", async () => {
    const installed = fixture.install("openclaw");
    let session = checkpointSession(
      createSession({
        agent: null,
        sandboxName: "alpha",
        harnessPackage: installed.identity,
      }),
    );
    const registry: SandboxRegistry = {
      defaultSandbox: null,
      sandboxes: { alpha: { name: "alpha", agent: null, harnessPackage: installed.identity } },
    };
    const boundary = boundaryFor(
      () => session,
      (next) => {
        session = next;
      },
      () => registry,
    );

    const prepared = await prepareResume(boundary);
    boundary.bind(prepared);

    expect(session.checkpoint).toMatchObject({
      harnessPackage: installed.identity,
      sandboxRecreate: { version: 2, harnessPackage: installed.identity },
    });
  });

  it("rejects owning registry drift after the checkpoint upgrade", async () => {
    const installed = fixture.install("openclaw");
    let session = checkpointSession(
      createSession({ agent: null, sandboxName: "alpha", harnessPackage: installed.identity }),
    );
    const registry: SandboxRegistry = {
      defaultSandbox: null,
      sandboxes: {
        alpha: {
          name: "alpha",
          agent: null,
          harnessPackage: { ...installed.identity, contentDigest: "f".repeat(64) },
        },
      },
    };
    const boundary = boundaryFor(
      () => session,
      (next) => {
        session = next;
      },
      () => registry,
    );

    const prepared = await prepareResume(boundary);
    expect(() => boundary.bind(prepared)).toThrow("Registry package authority");
  });

  it("upgrades qualified candidate recreate state only after requalification", async () => {
    let session = checkpointSession(createSession({ agent: "pi", sandboxName: "alpha" }));
    const resolveQualifiedAgent = vi.fn(() => ({ ...loadAgent("openclaw"), name: "pi" }));
    const boundary = boundaryFor(
      () => session,
      (next) => {
        session = next;
      },
      () => ({ defaultSandbox: null, sandboxes: { alpha: { name: "alpha", agent: "pi" } } }),
      resolveQualifiedAgent,
    );

    const prepared = await prepareResume(boundary);
    boundary.bind(prepared);

    expect(resolveQualifiedAgent).toHaveBeenCalledTimes(2);
    expect(session.checkpoint?.sandboxRecreate).toMatchObject({
      version: 2,
      harnessPackage: null,
    });
  });
});
