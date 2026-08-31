// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveGatewayRebuildAuthority: vi.fn(),
}));

vi.mock("../../onboard/gateway-teardown-authority", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../onboard/gateway-teardown-authority")>()),
  resolveGatewayRebuildAuthority: mocks.resolveGatewayRebuildAuthority,
}));

import { REPOSITORY_ROOT } from "../../core/repository-root";
import type {
  HarnessPackageIdentity,
  HarnessPackageMigration,
} from "../../agent-runtime/package/identity";
import { resolveSandboxAgent, type ResolvedSandboxAgent } from "../../onboard/sandbox-agent";
import type { CheckpointGatewayAuthority } from "../../state/onboard-checkpoint-types";
import type { CheckpointSandboxRecreateTransactionV2 } from "../../state/onboard-checkpoint-types";
import type { Session } from "../../state/onboard-session";
import * as onboardSession from "../../state/onboard-session";
import * as registry from "../../state/registry";
import {
  buildRebuildRecreateOnboardOpts,
  type RebuildRecreateOnboardOpts,
} from "./rebuild-gpu-opt-out";
import {
  assertCurrentRebuildPackageAuthority,
  fingerprintLegacyRebuildRecreateTargetIntent,
  fingerprintRebuildRecreateTargetIntent,
  openRebuildRecreateJournal,
} from "./rebuild-recreate-journal";

const PACKAGE: HarnessPackageIdentity = {
  kind: "agent-runtime",
  id: "hermes",
  packageVersion: "2.0.0",
  contentDigest: "a".repeat(64),
};

const MIGRATION: HarnessPackageMigration = {
  schemaVersion: 1,
  source: "legacy-current-bundle",
  legacyAgent: "hermes",
  migratedAt: "2026-08-28T05:00:00.000Z",
};

const GATEWAY_AUTHORITY: CheckpointGatewayAuthority = {
  gatewayName: "nemoclaw",
  gatewayPort: 8080,
  mode: "nemoclaw-managed",
  source: "standalone",
  endpoint: null,
  stateDir: null,
  supervisor: null,
  requiredCapabilities: [],
};

function pinnedAgentAuthority(
  recordedAgent: string | null,
  harnessPackage: HarnessPackageIdentity | null,
  harnessPackageMigration: HarnessPackageMigration | null = null,
): ResolvedSandboxAgent {
  const effectiveAgentId = recordedAgent ?? "openclaw";
  return {
    recordedAgent,
    effectiveAgentId,
    definition: {
      name: effectiveAgentId,
      packageRoot: `/pinned/${effectiveAgentId}`,
      runtime: { kind: "terminal" },
      forward_ports: [],
    } as unknown as ResolvedSandboxAgent["definition"],
    harnessPackage,
    harnessPackageMigration,
  };
}

function buildOptions(
  overrides: Partial<RebuildRecreateOnboardOpts> = {},
): RebuildRecreateOnboardOpts {
  return {
    resume: true,
    nonInteractive: true,
    recreateSandbox: true,
    authoritativeResumeConfig: true,
    acceptThirdPartySoftware: true,
    agent: "hermes",
    recreateProvider: "nvidia",
    recreateModel: "model-a",
    recreatePreferredInferenceApi: "openai",
    fromDockerfile: null,
    sandboxGpu: null,
    sandboxGpuDevice: null,
    controlUiPort: 18789,
    targetGatewayName: "nemoclaw",
    targetGatewayPort: 8080,
    onboardLockAlreadyHeld: true,
    harnessPackage: PACKAGE,
    harnessPackageMigration: MIGRATION,
    autoYes: true,
    toolDisclosure: "progressive",
    dcodeAutoApprovalMode: "disabled",
    dcodeAutoApprovalRequestedExplicitly: false,
    observabilityEnabled: false,
    observabilityRequestedExplicitly: false,
    baseImageResolutionHint: null,
    ...overrides,
  };
}

describe("rebuild package authority selection", () => {
  it.each([null, "hermes", "langchain-deepagents-code"])(
    "rejects standard agent %s without package authority",
    (recordedAgent) => {
      expect(() =>
        buildRebuildRecreateOnboardOpts({
          sb: { agent: recordedAgent, dashboardPort: 18789 },
          agentAuthority: pinnedAgentAuthority(recordedAgent, null),
          storedFromDockerfile: null,
          autoYes: true,
          usageNoticeAccepted: true,
        }),
      ).toThrow(/requires legacy package migration/u);
    },
  );

  it.each([
    ["NemoCUA", "nemocua", { NEMOCLAW_CUA_ENABLED: "1" }],
    [
      "Pi",
      "pi",
      {
        NEMOCLAW_CANDIDATE_AGENTS: "1",
        NEMOCLAW_CANDIDATE_QUALIFICATION_RECEIPT: path.join(
          REPOSITORY_ROOT,
          "ci/pi-agent-qualification-v1-linux-amd64.json",
        ),
      },
    ],
  ] as const)(
    "carries the repository-qualified %s definition with explicit null package authority",
    (_label, agent, env) => {
      const agentAuthority = resolveSandboxAgent({ agent }, { env });

      const options = buildRebuildRecreateOnboardOpts({
        sb: { agent, dashboardPort: 18789 },
        agentAuthority,
        storedFromDockerfile: null,
        autoYes: true,
        usageNoticeAccepted: true,
      });

      expect(agentAuthority.definition).toMatchObject({
        name: agent,
        packageRoot: REPOSITORY_ROOT,
        manifestPath: path.join(REPOSITORY_ROOT, "agents", agent, "manifest.yaml"),
        runtime: { kind: "terminal" },
      });
      expect(Object.isFrozen(agentAuthority.definition)).toBe(true);
      expect(options).toMatchObject({
        agent,
        controlUiPort: null,
        harnessPackage: null,
        harnessPackageMigration: null,
      });
    },
  );

  it("carries the exact installed identity and owner migration into recreate options", () => {
    const options = buildRebuildRecreateOnboardOpts({
      sb: {
        agent: "hermes",
        dashboardPort: 18789,
        harnessPackage: PACKAGE,
        harnessPackageMigration: MIGRATION,
      },
      agentAuthority: pinnedAgentAuthority("hermes", PACKAGE, MIGRATION),
      storedFromDockerfile: null,
      autoYes: true,
      usageNoticeAccepted: true,
    });

    expect(options.harnessPackage).toEqual(PACKAGE);
    expect(options.harnessPackageMigration).toEqual(MIGRATION);
  });
});

describe("rebuild package-bound journal", () => {
  let session: Session;
  let sourceEntry: registry.SandboxEntry | null;

  beforeEach(() => {
    session = onboardSession.createSession({ sandboxName: "alpha" });
    sourceEntry = {
      name: "alpha",
      agent: "hermes",
      harnessPackage: PACKAGE,
      harnessPackageMigration: MIGRATION,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
    };
    vi.spyOn(onboardSession, "loadSession").mockImplementation(() => session);
    vi.spyOn(onboardSession, "updateSession").mockImplementation((mutator) => {
      session = mutator(session) ?? session;
      return session;
    });
    vi.spyOn(registry, "getSandbox").mockImplementation(() => sourceEntry);
    mocks.resolveGatewayRebuildAuthority.mockReturnValue(GATEWAY_AUTHORITY);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mocks.resolveGatewayRebuildAuthority.mockReset();
  });

  it("binds identity into the fingerprint, Session, checkpoint, and v2 transaction", () => {
    const options = buildOptions();
    const observe = vi.fn(() => ({
      state: "ready" as const,
      liveIdentityFingerprint: "b".repeat(64),
    }));

    const journal = openRebuildRecreateJournal({
      target: { sandboxName: "alpha", gatewayName: "nemoclaw", gatewayPort: 8080 },
      expectedGatewayAuthority: GATEWAY_AUTHORITY,
      agentName: "hermes",
      targetIntentFingerprint: fingerprintRebuildRecreateTargetIntent(options),
      packageAuthority: { harnessPackage: PACKAGE, harnessPackageMigration: MIGRATION },
      observe,
      log: vi.fn(),
    });

    expect(journal.harnessPackage).toEqual(PACKAGE);
    expect(session.harnessPackage).toEqual(PACKAGE);
    expect(session.harnessPackageMigration).toEqual(MIGRATION);
    expect(session.checkpoint?.harnessPackage).toEqual(PACKAGE);
    expect(session.checkpoint?.sandboxRecreate).toMatchObject({
      version: 2,
      harnessPackage: PACKAGE,
    });
    expect(
      fingerprintRebuildRecreateTargetIntent({
        ...options,
        harnessPackage: { ...PACKAGE, contentDigest: "c".repeat(64) },
      }),
    ).not.toBe(journal.targetIntentFingerprint);
  });

  it("stops at the delete edge if identity or migration authority drifts", () => {
    const observe = vi.fn(() => ({
      state: "ready" as const,
      liveIdentityFingerprint: "b".repeat(64),
    }));
    const options = buildOptions();
    const journal = openRebuildRecreateJournal({
      target: { sandboxName: "alpha", gatewayName: "nemoclaw", gatewayPort: 8080 },
      expectedGatewayAuthority: GATEWAY_AUTHORITY,
      agentName: "hermes",
      targetIntentFingerprint: fingerprintRebuildRecreateTargetIntent(options),
      packageAuthority: { harnessPackage: PACKAGE, harnessPackageMigration: MIGRATION },
      observe,
      log: vi.fn(),
    });
    sourceEntry = {
      ...sourceEntry!,
      harnessPackageMigration: {
        ...MIGRATION,
        migratedAt: "2026-08-28T06:00:00.000Z",
      },
    };

    expect(() => journal.observeSourceForDelete()).toThrow(/package authority changed/u);
    expect(observe).toHaveBeenCalledOnce();
    expect(session.checkpoint?.sandboxRecreate?.phase).toBe("planned");
  });

  it("confirms deletion from durable Session authority after the source row is absent", () => {
    let sourceMissing = false;
    const observe = vi.fn(() =>
      sourceMissing
        ? ({ state: "missing", liveIdentityFingerprint: null } as const)
        : ({ state: "ready", liveIdentityFingerprint: "b".repeat(64) } as const),
    );
    const options = buildOptions();
    const journal = openRebuildRecreateJournal({
      target: { sandboxName: "alpha", gatewayName: "nemoclaw", gatewayPort: 8080 },
      expectedGatewayAuthority: GATEWAY_AUTHORITY,
      agentName: "hermes",
      targetIntentFingerprint: fingerprintRebuildRecreateTargetIntent(options),
      legacyTargetIntentFingerprint: fingerprintLegacyRebuildRecreateTargetIntent(options),
      packageAuthority: { harnessPackage: PACKAGE, harnessPackageMigration: MIGRATION },
      observe,
      log: vi.fn(),
    });

    journal.markDeleting();
    sourceEntry = null;
    sourceMissing = true;
    journal.confirmDeleted();

    expect(session.checkpoint?.sandboxRecreate?.phase).toBe("deleted");
  });

  it("upgrades an exact active v1 fingerprint without changing its target", () => {
    const options = buildOptions();
    const legacyFingerprint = fingerprintLegacyRebuildRecreateTargetIntent(options);
    const observe = vi.fn(() => ({
      state: "ready" as const,
      liveIdentityFingerprint: "b".repeat(64),
    }));
    const first = openRebuildRecreateJournal({
      target: { sandboxName: "alpha", gatewayName: "nemoclaw", gatewayPort: 8080 },
      expectedGatewayAuthority: GATEWAY_AUTHORITY,
      agentName: "hermes",
      targetIntentFingerprint: fingerprintRebuildRecreateTargetIntent(options),
      legacyTargetIntentFingerprint: legacyFingerprint,
      packageAuthority: { harnessPackage: PACKAGE, harnessPackageMigration: MIGRATION },
      observe,
      log: vi.fn(),
    });
    const checkpoint = session.checkpoint!;
    const transaction = checkpoint.sandboxRecreate as CheckpointSandboxRecreateTransactionV2;
    expect(transaction).toMatchObject({ version: 2 });
    const { harnessPackage: _harnessPackage, ...legacyTransaction } = transaction;
    session.checkpoint = {
      ...checkpoint,
      sandboxRecreate: {
        ...legacyTransaction,
        version: 1,
        targetIntentFingerprint: legacyFingerprint,
      },
    };

    const resumed = openRebuildRecreateJournal({
      target: { sandboxName: "alpha", gatewayName: "nemoclaw", gatewayPort: 8080 },
      expectedGatewayAuthority: GATEWAY_AUTHORITY,
      agentName: "hermes",
      targetIntentFingerprint: fingerprintRebuildRecreateTargetIntent(options),
      legacyTargetIntentFingerprint: legacyFingerprint,
      packageAuthority: { harnessPackage: PACKAGE, harnessPackageMigration: MIGRATION },
      observe,
      log: vi.fn(),
    });

    expect(resumed.id).toBe(first.id);
    expect(resumed.targetIntentFingerprint).toBe(legacyFingerprint);
    expect(session.checkpoint?.sandboxRecreate).toMatchObject({
      version: 2,
      harnessPackage: PACKAGE,
      targetIntentFingerprint: legacyFingerprint,
    });
  });

  it("revalidates the exact replacement registry authority before journal retirement", () => {
    expect(() =>
      assertCurrentRebuildPackageAuthority("alpha", {
        harnessPackage: PACKAGE,
        harnessPackageMigration: MIGRATION,
      }),
    ).not.toThrow();

    sourceEntry = {
      ...sourceEntry!,
      harnessPackage: { ...PACKAGE, contentDigest: "d".repeat(64) },
    };
    expect(() =>
      assertCurrentRebuildPackageAuthority("alpha", {
        harnessPackage: PACKAGE,
        harnessPackageMigration: MIGRATION,
      }),
    ).toThrow(/package authority changed/u);
  });
});
