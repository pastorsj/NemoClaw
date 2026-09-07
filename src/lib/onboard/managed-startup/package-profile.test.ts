// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import {
  type HarnessStartupAdapterSource,
  mapManagedStartupProfileToAgentEnvironment,
} from "./agent-environment";
import {
  commitManagedStartupApplication,
  type ManagedStartupApplicationTestRuntime,
  prepareManagedStartupApplication,
} from "./application";
import {
  coordinateManagedStartupApplication,
  type ManagedStartupAgentAdapter,
  type ManagedStartupCoordinatorDependencies,
} from "./coordinator";
import {
  decodeManagedStartupDurableProfile,
  decodeManagedStartupProfile,
  encodeManagedStartupDurableProfile,
  encodeManagedStartupProfile,
  type ManagedStartupJsonObject,
  type ManagedStartupPackageProfile,
  serializeManagedStartupDurableProfile,
  serializeManagedStartupProfile,
  validateManagedStartupPackageProfile,
} from "./profile";
import {
  buildInitialManagedStartupPackageProfile,
  buildManagedStartupPackageProfile,
  managedStartupSettingsFromProfile,
} from "./package-profile";

const FUTURE_PACKAGE_ID = "future-harness";
const FUTURE_PACKAGE_IDENTITY = {
  kind: "agent-runtime",
  id: FUTURE_PACKAGE_ID,
  packageVersion: "2.3.4",
  contentDigest: "a".repeat(64),
} as const;

const PACKAGE_ADAPTER_SOURCE: HarnessStartupAdapterSource = {
  filename: "/fixture/future-startup-adapter.cjs",
  harnessPackage: FUTURE_PACKAGE_IDENTITY,
  source: `
"use strict";
module.exports = {
  buildStartupPlan(request) {
    if (
      request.profileKind !== "package" ||
      request.packageId !== request.harnessPackage.id ||
      request.harnessPackage.contentDigest.length !== 64 ||
      Object.hasOwn(request.applicationEnvironment, "UNREVIEWED_APPLICATION_SETTING")
    ) {
      throw new Error("receipt authority mismatch");
    }
    return {
      schemaVersion: 1,
      packageId: request.packageId,
      configurationEnvironment: {
        FUTURE_CONFIG_B64: { kind: "canonical-json-base64", value: request.packageConfig },
      },
      runtimeEnvironment: {
        FUTURE_PACKAGE_VERSION: request.harnessPackage.packageVersion,
        FUTURE_PACKAGE_DIGEST: request.harnessPackage.contentDigest,
        FUTURE_DEADLINE: request.applicationEnvironment.NEMOCLAW_AUTO_PAIR_DEADLINE_SECS,
      },
      applicationRuntime: { exportEnvironment: {}, unsetEnvironment: [] },
      managedState: {
        root: "/sandbox/.future-harness",
        files: ["config.json"],
        directories: [],
      },
      materials: [{
        kind: "corporate-ca-handoff",
        legacyInput: "NEMOCLAW_CORPORATE_CA_B64",
        expectedSha256: request.corporateCa.bundleSha256,
      }],
      actions: [{ kind: "generate-config", runAs: "sandbox" }],
    };
  },
};
`,
} as const;

function packageProfile(): ManagedStartupPackageProfile {
  const desiredState = futureDesiredState();
  return {
    schemaVersion: 1,
    profileKind: "package",
    agent: FUTURE_PACKAGE_ID,
    harnessPackage: FUTURE_PACKAGE_IDENTITY,
    desiredState,
    packageConfig: {
      inferenceRoute: "inference",
      model: "nvidia/future-model",
      features: { tools: true },
    },
    corporateCa: { bundleSha256: null },
  };
}

function futureDesiredState() {
  const settings = managedStartupSettingsFromProfile(managedStartupE2eProfile("pi"));
  return {
    ...settings,
    configuration: { agent: FUTURE_PACKAGE_ID },
    dashboard: { agent: FUTURE_PACKAGE_ID, mode: "disabled" as const },
  };
}

function packageMessagingSettings(placeholder: string): ManagedStartupJsonObject {
  return {
    messaging: {
      plan: { credentialBindings: [{ placeholder }] },
    },
  };
}

describe("managed startup package profile", () => {
  let fixtureRoot: string;
  let runtime: ManagedStartupApplicationTestRuntime;

  beforeEach(() => {
    vi.spyOn(process, "geteuid").mockReturnValue(0);
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-package-profile-"));
    fs.chmodSync(fixtureRoot, 0o700);
    runtime = {
      rootUid: process.getuid?.() ?? 0,
      rootGid: process.getgid?.() ?? 0,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(fixtureRoot, { force: true, recursive: true });
  });

  it("maps, commits, and replays an unknown receipt-backed package", async () => {
    const profile = packageProfile();
    const encodedProfile = encodeManagedStartupDurableProfile(profile);
    const decoded = decodeManagedStartupDurableProfile(encodedProfile);

    expect(decoded).toEqual(profile);
    const input = {
      encodedProfile,
      expectedAgent: FUTURE_PACKAGE_ID,
      stateDirectory: path.join(fixtureRoot, "state"),
    };
    const dependencies: ManagedStartupCoordinatorDependencies = {
      prepareApplication: (request) => prepareManagedStartupApplication(request, runtime),
      commitApplication: (prepared) => commitManagedStartupApplication(prepared, runtime),
    };
    const mappedPlans: ReturnType<typeof mapManagedStartupProfileToAgentEnvironment>[] = [];
    const adapter: ManagedStartupAgentAdapter = {
      packageId: FUTURE_PACKAGE_ID,
      apply(context) {
        mappedPlans.push(
          mapManagedStartupProfileToAgentEnvironment(
            context.profile,
            {
              NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "47",
              UNREVIEWED_APPLICATION_SETTING: "not-forwarded",
            },
            {
              adapterSource: PACKAGE_ADAPTER_SOURCE,
            },
          ),
        );
      },
    };

    const first = await coordinateManagedStartupApplication(input, adapter, dependencies);
    expect(first.adapterApplied).toBe(true);
    expect(first.application.status).toBe("committed");
    expect(first.application.profile).toEqual(profile);
    expect(mappedPlans).toEqual([
      expect.objectContaining({
        agent: FUTURE_PACKAGE_ID,
        configurationEnvironment: {
          FUTURE_CONFIG_B64: Buffer.from(
            '{"features":{"tools":true},"inferenceRoute":"inference","model":"nvidia/future-model"}',
            "utf8",
          ).toString("base64"),
        },
        runtimeEnvironment: {
          FUTURE_DEADLINE: "47",
          FUTURE_PACKAGE_DIGEST: "a".repeat(64),
          FUTURE_PACKAGE_VERSION: "2.3.4",
        },
      }),
    ]);

    const replayed = await coordinateManagedStartupApplication(input, adapter, dependencies);
    expect(replayed.adapterApplied).toBe(false);
    expect(replayed.application.fingerprint).toBe(first.application.fingerprint);
    expect(mappedPlans).toHaveLength(1);
  });

  it("asks an unknown receipt-backed package to build its opaque startup config", () => {
    const desiredState = futureDesiredState();
    const buildInitialStartupProfile = vi.fn(() => ({
      kind: "package-config" as const,
      packageConfig: { nativeRevision: 3, runtimeMode: "future" },
    }));
    const built = buildInitialManagedStartupPackageProfile(
      {
        harnessPackage: FUTURE_PACKAGE_IDENTITY,
        desiredState,
        credentialProxyReplayRequired: false,
        dashboardRemoteBindPrepared: false,
      },
      () => ({
        startupProfileEnvironment: [],
        prepareStartupProfile: vi.fn(),
        buildInitialStartupProfile,
        reconcileStartupProfile: vi.fn(),
      }),
    );

    expect(decodeManagedStartupDurableProfile(built.encodedProfile)).toEqual(built.profile);
    expect(buildInitialStartupProfile).toHaveBeenCalledExactlyOnceWith({
      packageId: FUTURE_PACKAGE_ID,
      harnessPackage: FUTURE_PACKAGE_IDENTITY,
      desiredState,
    });
    expect(built.profile).toMatchObject({
      agent: FUTURE_PACKAGE_ID,
      harnessPackage: FUTURE_PACKAGE_IDENTITY,
      desiredState: {
        configuration: { agent: FUTURE_PACKAGE_ID },
        dashboard: { agent: FUTURE_PACKAGE_ID, mode: "disabled" },
      },
      packageConfig: { nativeRevision: 3, runtimeMode: "future" },
    });
    expect(built.startupProfileSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(built.dashboardRemoteBindPrepared).toBe(false);
  });

  it("rejects credentials before a package startup transport is created", () => {
    const desiredState = futureDesiredState();
    expect(() =>
      buildManagedStartupPackageProfile({
        harnessPackage: FUTURE_PACKAGE_IDENTITY,
        desiredState: {
          ...desiredState,
          configuration: {
            agent: FUTURE_PACKAGE_ID,
            apiKey: "not-a-real-credential",
          } as never,
        },
        packageConfig: { nativeRevision: 3 },
        credentialProxyReplayRequired: false,
        dashboardRemoteBindPrepared: false,
      }),
    ).toThrow(/credential-shaped field name/u);
  });

  it("preserves reviewed messaging credential placeholders in package-owned settings", () => {
    const desiredState = {
      ...futureDesiredState(),
      messaging: {
        plan: {
          credentialBindings: [{ placeholder: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN" }],
        },
      },
    };

    expect(() =>
      buildManagedStartupPackageProfile({
        harnessPackage: FUTURE_PACKAGE_IDENTITY,
        desiredState,
        packageConfig: {
          settings: packageMessagingSettings("xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN"),
        },
        credentialProxyReplayRequired: true,
        dashboardRemoteBindPrepared: false,
      }),
    ).not.toThrow();

    expect(() =>
      buildManagedStartupPackageProfile({
        harnessPackage: FUTURE_PACKAGE_IDENTITY,
        desiredState,
        packageConfig: {
          settings: packageMessagingSettings("xoxb-not-a-placeholder-token"),
        },
        credentialProxyReplayRequired: true,
        dashboardRemoteBindPrepared: false,
      }),
    ).toThrow(/packageConfig[.]settings.*credential-shaped string data/u);
  });

  it("binds package configuration to the full receipt identity", () => {
    expect(() =>
      validateManagedStartupPackageProfile({
        ...packageProfile(),
        agent: "different-harness",
      }),
    ).toThrow(/agent must match harnessPackage[.]id/u);
    expect(() =>
      validateManagedStartupPackageProfile({
        ...packageProfile(),
        packageConfig: { apiKey: "not-a-real-credential" },
      }),
    ).toThrow(/credential-shaped field name/u);

    expect(() =>
      mapManagedStartupProfileToAgentEnvironment(
        packageProfile(),
        {},
        {
          adapterSource: {
            ...PACKAGE_ADAPTER_SOURCE,
            harnessPackage: {
              ...FUTURE_PACKAGE_IDENTITY,
              contentDigest: "b".repeat(64),
            },
          },
        },
      ),
    ).toThrow(/adapter source does not match the receipt-backed package identity/u);
  });

  it("fails closed when an older package profile has no persisted desired state", () => {
    const { desiredState: _desiredState, ...oldProfile } = packageProfile();

    expect(() => validateManagedStartupPackageProfile(oldProfile)).toThrow(
      /rerun onboarding to create current package startup authority/u,
    );
  });

  it("reports a package-owned unsupported initial profile explicitly", () => {
    expect(() =>
      buildInitialManagedStartupPackageProfile(
        {
          harnessPackage: FUTURE_PACKAGE_IDENTITY,
          desiredState: futureDesiredState(),
          credentialProxyReplayRequired: false,
          dashboardRemoteBindPrepared: false,
        },
        () => ({
          startupProfileEnvironment: [],
          prepareStartupProfile: vi.fn(),
          buildInitialStartupProfile: () => ({
            kind: "unsupported",
            reason: "future runtime requires an external bootstrap",
          }),
          reconcileStartupProfile: vi.fn(),
        }),
      ),
    ).toThrow(/does not support managed startup profiles.*external bootstrap/u);
  });

  it("keeps the legacy stock transport byte-for-byte compatible", () => {
    const legacyProfile = managedStartupE2eProfile("pi");

    expect(serializeManagedStartupDurableProfile(legacyProfile)).toBe(
      serializeManagedStartupProfile(legacyProfile),
    );
    expect(encodeManagedStartupDurableProfile(legacyProfile)).toBe(
      encodeManagedStartupProfile(legacyProfile),
    );
    expect(() =>
      decodeManagedStartupProfile(encodeManagedStartupDurableProfile(packageProfile())),
    ).toThrow(/unsupported fields/u);
  });
});
