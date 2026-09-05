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
  type ManagedStartupPackageProfile,
  serializeManagedStartupDurableProfile,
  serializeManagedStartupProfile,
  validateManagedStartupPackageProfile,
} from "./profile";

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
  return {
    schemaVersion: 1,
    profileKind: "package",
    agent: FUTURE_PACKAGE_ID,
    harnessPackage: FUTURE_PACKAGE_IDENTITY,
    packageConfig: {
      inferenceRoute: "inference",
      model: "nvidia/future-model",
      features: { tools: true },
    },
    corporateCa: { bundleSha256: null },
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
