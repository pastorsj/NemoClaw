// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createHarnessPackageFixture,
  type HarnessPackageFixture,
} from "../../../../test/helpers/harness-packages";
import { resolveSandboxAgent } from "../sandbox-agent";
import { createSession, type Session } from "../../state/onboard-session";
import {
  prepareOnboardHarnessOperation,
  type OnboardHarnessPackageBoundaryDependencies,
} from "./boundary";
import { planSelectedAgentTransition } from "../runtime-control-flow";

let fixture: HarnessPackageFixture;

beforeEach(() => {
  fixture = createHarnessPackageFixture();
});

afterEach(() => {
  fixture.cleanup();
});

function preparePackageResume(
  loadSession: () => Session | null,
  overrides: Partial<OnboardHarnessPackageBoundaryDependencies> = {},
) {
  return prepareOnboardHarnessOperation(
    {
      agentFlag: null,
      canPrompt: false,
      environment: {},
      prompt: vi.fn(async () => "1"),
      resume: true,
      rootDir: fixture.fixtureRoot,
    },
    {
      assertWriterLockOwned: vi.fn(),
      compareAndSwapSession: vi.fn(() => "mismatch" as const),
      loadSession,
      getStoreRoot: () => fixture.storeRoot,
      resolveSandboxAgent,
      ...overrides,
    },
  );
}

describe("package-managed onboarding resume", () => {
  it("keeps the session-pinned package after the active pointer advances", async () => {
    const pinned = fixture.install("openclaw");
    const session = createSession({
      agent: null,
      harnessPackage: pinned.identity,
      harnessPackageMigration: null,
    });
    const resolveExactPackage = vi.fn(resolveSandboxAgent);
    const operation = await preparePackageResume(() => session, {
      resolveSandboxAgent: resolveExactPackage,
    });
    const active = fixture.advanceActivePointer("openclaw");

    operation.beforeRuntimeEffects();
    const authority = operation.requireBoundAuthority();
    const clearAgentScopedResumeState = vi.fn((current: Session) => current);
    const updateSession = vi.fn((mutator: (current: Session) => Session | void) => {
      return mutator(session) ?? session;
    });
    const transition = planSelectedAgentTransition(
      {
        resume: true,
        session,
        selectedAgentName: authority.selectedAgent?.name,
        routerPort: 4000,
        note: vi.fn(),
      },
      { clearAgentScopedResumeState, updateSession },
    );

    expect(authority.effectiveDefinition?.packageRoot).toBe(pinned.packageRoot);
    expect(authority.effectiveDefinition?.packageRoot).not.toBe(active.packageRoot);
    expect(resolveExactPackage).toHaveBeenCalledTimes(2);
    expect(transition.resumeAgentChanged).toBe(false);
    expect(clearAgentScopedResumeState).not.toHaveBeenCalled();

    await transition.commit();

    expect(clearAgentScopedResumeState).not.toHaveBeenCalled();
    expect(session.harnessPackage).toEqual(pinned.identity);
  });

  it.each([
    ["missing", (packageRoot: string) => fs.rmSync(packageRoot, { recursive: true, force: true })],
    [
      "corrupt",
      (packageRoot: string) =>
        fs.writeFileSync(path.join(packageRoot, "runtime/payload.txt"), "tampered\n"),
    ],
  ] as const)(
    "rejects a %s pinned object instead of following the active pointer",
    async (_failure, damagePinnedObject) => {
      const pinned = fixture.install("openclaw");
      const session = createSession({
        agent: null,
        harnessPackage: pinned.identity,
        harnessPackageMigration: null,
      });
      const active = fixture.advanceActivePointer("openclaw");
      damagePinnedObject(pinned.packageRoot);
      const portableRecovery = vi.fn();

      await expect(
        preparePackageResume(() => session).then(() => portableRecovery()),
      ).rejects.toThrow();

      expect(portableRecovery).not.toHaveBeenCalled();
      expect(fs.existsSync(active.packageRoot)).toBe(true);
    },
  );

  it.each([
    ["selected agent", { recordedAgent: null, selectedAgent: "hermes" }],
    ["recorded agent", { recordedAgent: "hermes", selectedAgent: "openclaw" }],
  ] as const)("rejects a package resume with a different %s before mutation", (_case, agents) => {
    const pinned = fixture.install("openclaw");
    const session = createSession({
      agent: agents.recordedAgent,
      harnessPackage: pinned.identity,
      harnessPackageMigration: null,
      provider: "nvidia",
      routerPid: 1234,
    });
    const before = structuredClone(session);
    const stopTrackedModelRouterForAgentChange = vi.fn(async () => undefined);
    const clearAgentScopedResumeState = vi.fn((current: Session) => current);
    const updateSession = vi.fn((mutator: (current: Session) => Session | void) => {
      return mutator(session) ?? session;
    });
    const note = vi.fn();

    expect(() =>
      planSelectedAgentTransition(
        {
          resume: true,
          session,
          selectedAgentName: agents.selectedAgent,
          routerPort: 4000,
          note,
        },
        {
          stopTrackedModelRouterForAgentChange,
          clearAgentScopedResumeState,
          updateSession,
        },
      ),
    ).toThrow("cannot transition");

    expect(stopTrackedModelRouterForAgentChange).not.toHaveBeenCalled();
    expect(clearAgentScopedResumeState).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
    expect(session).toEqual(before);
  });

  it("rejects malformed package authority before transition mutation", () => {
    const pinned = fixture.install("openclaw");
    const session = createSession({
      agent: null,
    });
    session.harnessPackage = { ...pinned.identity, contentDigest: "invalid" };
    const clearAgentScopedResumeState = vi.fn((current: Session) => current);
    const updateSession = vi.fn((mutator: (current: Session) => Session | void) => {
      return mutator(session) ?? session;
    });

    expect(() =>
      planSelectedAgentTransition(
        {
          resume: true,
          session,
          selectedAgentName: "openclaw",
          routerPort: 4000,
          note: vi.fn(),
        },
        { clearAgentScopedResumeState, updateSession },
      ),
    ).toThrow("authority is malformed");

    expect(clearAgentScopedResumeState).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
  });

  it.each(["pi", "nemocua"] as const)("keeps a qualified %s resume package-free", (agentId) => {
    const session = createSession({ agent: agentId });
    const clearAgentScopedResumeState = vi.fn((current: Session) => current);

    const transition = planSelectedAgentTransition(
      {
        resume: true,
        session,
        selectedAgentName: agentId,
        routerPort: 4000,
        note: vi.fn(),
      },
      { clearAgentScopedResumeState },
    );

    expect(transition.resumeAgentChanged).toBe(false);
    expect(transition.session.harnessPackage).toBeNull();
    expect(transition.session.harnessPackageMigration).toBeNull();
    expect(clearAgentScopedResumeState).not.toHaveBeenCalled();
  });
});
