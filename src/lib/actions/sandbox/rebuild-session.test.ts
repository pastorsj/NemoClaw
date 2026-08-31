// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  HarnessPackageIdentity,
  HarnessPackageMigration,
} from "../../agent-runtime/package/identity";
import { decisionSelected } from "../../state/onboard-checkpoint-decision";
import { deriveCheckpointFromSession } from "../../state/onboard-checkpoint-migrate";
import type { CheckpointGatewayAuthority } from "../../state/onboard-checkpoint-types";
import type { Session } from "../../state/onboard-session";
import * as onboardSession from "../../state/onboard-session";
import * as registry from "../../state/registry";
import type { RebuildDurableConfig } from "./rebuild-durable-config";
import { makeRebuildAgentAuthority } from "./rebuild-flow-test-fixtures";
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";
import { rebuildOnboardDependencies } from "./rebuild-onboard-dependencies";
import type { RebuildRecreateJournal } from "./rebuild-recreate-journal";
import { type RebuildRecreatePhaseInput, runRebuildRecreatePhase } from "./rebuild-recreate-phase";
import type { RebuildResumeConfig } from "./rebuild-resume-config";

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

const durableConfig: RebuildDurableConfig = {
  dcodeAutoApprovalMode: "disabled",
  dcodeAutoApprovalModeError: null,
  fromDockerfile: null,
  fromDockerfileError: null,
  hermesAuthMethod: null,
  hermesAuthMethodError: null,
  webSearchConfig: null,
  webSearchError: null,
  toolDisclosure: "progressive",
  toolDisclosureError: null,
};

const resumeConfig: RebuildResumeConfig = {
  agentAuthority: makeRebuildAgentAuthority("hermes"),
  agent: "hermes",
  provider: "nvidia",
  model: "model-a",
  nimContainer: null,
  credentialEnv: "NVIDIA_API_KEY",
  preferredInferenceApi: "openai",
  compatibleEndpointReasoning: null,
  compatibleEndpointReasoningEffort: null,
  pinEndpoint: true,
  endpointUrl: "https://integrate.api.nvidia.com/v1",
  registryInferenceRoute: null,
  ambient: { presentVars: [], agentMismatch: null },
};

const recreateOptions: RebuildRecreateOnboardOpts = {
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
  rebuildGatewayAuthority: GATEWAY_AUTHORITY,
};

const recreateJournal: RebuildRecreateJournal = {
  id: "11111111-1111-4111-8111-111111111111",
  acceptedTarget: false,
  sourceConfirmedAbsent: true,
  gatewayAuthority: GATEWAY_AUTHORITY,
  targetGeneration: "22222222-2222-4222-8222-222222222222",
  targetIntentFingerprint: "package-bound-target",
  harnessPackage: PACKAGE,
  markDeleting: vi.fn(),
  observeSourceForDelete: vi.fn((): "missing" => "missing"),
  confirmDeleted: vi.fn(),
  completeAcceptedTarget: vi.fn(),
};

function journalSession(): Session {
  const session = onboardSession.createSession({
    sandboxName: "alpha",
    agent: "hermes",
    harnessPackage: PACKAGE,
    harnessPackageMigration: MIGRATION,
  });
  session.checkpoint = {
    ...deriveCheckpointFromSession(session),
    sandboxIdentity: decisionSelected({ name: "alpha", agent: "hermes" }),
    gatewayAuthority: decisionSelected(GATEWAY_AUTHORITY),
    sandboxRecreate: {
      version: 2,
      harnessPackage: PACKAGE,
      id: recreateJournal.id,
      revision: 2,
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      sourceRegistryFingerprint: "source-registry",
      sourceLiveIdentityFingerprint: null,
      sourceWorkload: null,
      targetIntentFingerprint: recreateJournal.targetIntentFingerprint,
      targetGeneration: recreateJournal.targetGeneration,
      targetLiveIdentityFingerprint: null,
      phase: "deleted",
      startedAt: "2026-08-28T05:00:00.000Z",
      updatedAt: "2026-08-28T05:01:00.000Z",
    },
  };
  return session;
}

function makeInput(overrides: Partial<RebuildRecreatePhaseInput> = {}): RebuildRecreatePhaseInput {
  return {
    sandboxName: "alpha",
    sandboxEntry: {
      name: "alpha",
      agent: "hermes",
      harnessPackage: PACKAGE,
      harnessPackageMigration: MIGRATION,
    },
    sessionSnapshot: journalSession(),
    sessionMatchesSandbox: true,
    durableConfig,
    resumeConfig,
    recreateOptions,
    recreateJournal,
    fromDockerfile: null,
    rebuildAgent: "hermes",
    messagingPlan: null,
    rebuildsHermesSandbox: false,
    hermesToolGateways: [],
    hasHermesToolGateways: false,
    policySourcePath: "/tmp/current-policy.yaml",
    credentialEnv: "NVIDIA_API_KEY",
    baseImagePreflight: { ok: true, imageRef: null, overrideEnvVar: null },
    recoveryRecreate: false,
    registryRollback: { recordRemoval: vi.fn(), restoreForRetry: vi.fn() },
    backupManifest: null,
    mcpEntries: [],
    rebuildShieldsWindow: { relocked: false, wasLocked: false },
    relockShieldsIfNeeded: vi.fn(() => true),
    onCreated: vi.fn(),
    log: vi.fn(),
    bail: vi.fn((message: string): never => {
      throw new Error(`bail: ${message}`);
    }),
    ...overrides,
  };
}

describe("post-delete rebuild package authority", () => {
  let session: Session;

  beforeEach(() => {
    session = journalSession();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(onboardSession, "loadSession").mockImplementation(() => session);
    vi.spyOn(onboardSession, "updateSession").mockImplementation((mutator) => {
      session = mutator(session) ?? session;
      return session;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recreates after source-row removal while preserving exact Session authority", async () => {
    const registryRead = vi.spyOn(registry, "getSandbox").mockReturnValue(null);
    const onboard = vi
      .spyOn(rebuildOnboardDependencies, "onboard")
      .mockImplementation(async (options) => {
        expect(options.harnessPackage).toEqual(PACKAGE);
        expect(options.harnessPackageMigration).toEqual(MIGRATION);
        expect(session.harnessPackage).toEqual(PACKAGE);
        expect(session.harnessPackageMigration).toEqual(MIGRATION);
        expect(session.checkpoint?.harnessPackage).toEqual(PACKAGE);
        expect(session.checkpoint?.sandboxRecreate).toMatchObject({
          version: 2,
          harnessPackage: PACKAGE,
        });
      });

    await expect(runRebuildRecreatePhase(makeInput())).resolves.toBe(true);

    expect(onboard).toHaveBeenCalledOnce();
    expect(registryRead).not.toHaveBeenCalled();
    expect(session.harnessPackage).toEqual(PACKAGE);
    expect(session.harnessPackageMigration).toEqual(MIGRATION);
  });

  it("refuses a changed owner migration before invoking inner onboard", async () => {
    session.harnessPackageMigration = {
      ...MIGRATION,
      migratedAt: "2026-08-28T06:00:00.000Z",
    };
    const onboard = vi.spyOn(rebuildOnboardDependencies, "onboard");

    await expect(runRebuildRecreatePhase(makeInput())).rejects.toThrow(
      /session package authority changed/u,
    );

    expect(onboard).not.toHaveBeenCalled();
  });
});
