// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HarnessPackageIdentity } from "../../agent-runtime/package/identity";
import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { managedStartupSettingsFromProfile } from "../../onboard/managed-startup/package-profile";
import { encodeManagedStartupDurableProfile } from "../../onboard/managed-startup/profile";
import type { SandboxWorkloadReceipt } from "./types";
import { cloneSandboxWorkloadReceipt } from "./workload";

const originalHome = process.env.HOME;
const temporaryHomes: string[] = [];

const HARNESS_PACKAGE = {
  kind: "agent-runtime",
  id: "future-harness",
  packageVersion: "1.2.3",
  contentDigest: "a".repeat(64),
} as const satisfies HarnessPackageIdentity;

function packageWorkload(
  profilePackage: HarnessPackageIdentity = HARNESS_PACKAGE,
): Extract<SandboxWorkloadReceipt, { kind: "managed-image" }> {
  const packageStartupProfile = packageStartupProfileReceipt(profilePackage);
  return {
    schemaVersion: 1,
    kind: "managed-image",
    reference: `registry.example/team/future-harness@sha256:${"b".repeat(64)}`,
    platform: "linux/amd64",
    release: "v0.0.100",
    sourceRevision: "c".repeat(40),
    sourceCohort: "build-2026.09.05",
    capabilityContractVersion: 1,
    startupProfileContractVersion: 1,
    ...packageStartupProfile,
    shared: true,
  };
}

function packageStartupProfileReceipt(profilePackage: HarnessPackageIdentity = HARNESS_PACKAGE) {
  const piSettings = managedStartupSettingsFromProfile(managedStartupE2eProfile("pi"));
  const encodedProfile = encodeManagedStartupDurableProfile({
    schemaVersion: 1,
    profileKind: "package",
    agent: profilePackage.id,
    harnessPackage: profilePackage,
    desiredState: {
      ...piSettings,
      configuration: { agent: profilePackage.id },
      dashboard: { agent: profilePackage.id, mode: "disabled" },
    },
    packageConfig: { runtimeMode: "managed" },
    corporateCa: { bundleSha256: null },
  });
  return {
    encodedProfile,
    startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
    credentialProxyReplayRequired: false,
  };
}

function packageDockerfileWorkload(
  profilePackage: HarnessPackageIdentity = HARNESS_PACKAGE,
): Extract<SandboxWorkloadReceipt, { kind: "legacy-dockerfile" }> {
  return {
    schemaVersion: 1,
    kind: "legacy-dockerfile",
    reference: "nemoclaw-future-harness:local",
    packageStartupProfile: packageStartupProfileReceipt(profilePackage),
    shared: false,
  };
}

async function loadRegistryDocument(document: unknown) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-registry-workload-profile-"));
  temporaryHomes.push(home);
  const configDirectory = path.join(home, ".nemoclaw");
  fs.mkdirSync(configDirectory, { recursive: true });
  fs.writeFileSync(path.join(configDirectory, "sandboxes.json"), JSON.stringify(document), {
    mode: 0o600,
  });
  process.env.HOME = home;
  vi.resetModules();
  return import("../registry");
}

afterEach(() => {
  process.env.HOME = originalHome;
  vi.resetModules();
  for (const home of temporaryHomes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("sandbox registry package startup profile", () => {
  it("decodes a canonical package profile through the durable workload union", () => {
    const workload = packageWorkload();

    expect(cloneSandboxWorkloadReceipt(workload)).toEqual(workload);
    expect(cloneSandboxWorkloadReceipt(workload, { harnessPackage: HARNESS_PACKAGE })).toEqual(
      workload,
    );
  });

  it("does not reinterpret a package publication cohort as stock authority", () => {
    const workload = packageWorkload();

    expect(cloneSandboxWorkloadReceipt(workload)).toEqual(workload);
    expect(cloneSandboxWorkloadReceipt(workload, { harnessPackage: null })).toBeUndefined();
  });

  it("round-trips a package-bound profile on a Dockerfile workload receipt", async () => {
    const registry = await loadRegistryDocument({ sandboxes: {}, defaultSandbox: null });
    const workload = packageDockerfileWorkload();

    registry.registerSandbox({
      name: "dockerfile-package",
      agent: HARNESS_PACKAGE.id,
      harnessPackage: HARNESS_PACKAGE,
      imageTag: workload.reference,
      workload,
    });
    registry.save(registry.load());

    expect(registry.getSandbox("dockerfile-package")?.workload).toEqual(workload);
  });

  it("fails closed when a Dockerfile profile transport is tampered", () => {
    const workload = packageDockerfileWorkload();
    const packageStartupProfile = workload.packageStartupProfile!;

    expect(
      cloneSandboxWorkloadReceipt(
        {
          ...workload,
          packageStartupProfile: {
            ...packageStartupProfile,
            encodedProfile: `${packageStartupProfile.encodedProfile}A`,
          },
        },
        { harnessPackage: HARNESS_PACKAGE },
      ),
    ).toBeUndefined();
  });

  it.each([
    ["absence", null],
    ["ID", { ...HARNESS_PACKAGE, id: "other-harness" }],
    ["version", { ...HARNESS_PACKAGE, packageVersion: "1.2.4" }],
    ["digest", { ...HARNESS_PACKAGE, contentDigest: "d".repeat(64) }],
  ] as const)(
    "rejects a Dockerfile profile bound to a different package %s",
    (_case, authority) => {
      expect(
        cloneSandboxWorkloadReceipt(packageDockerfileWorkload(), { harnessPackage: authority }),
      ).toBeUndefined();
    },
  );

  it("fails closed for a receipt created before desired state was durable", () => {
    const oldProfile = {
      schemaVersion: 1,
      profileKind: "package",
      agent: HARNESS_PACKAGE.id,
      harnessPackage: HARNESS_PACKAGE,
      packageConfig: { runtimeMode: "managed" },
      corporateCa: { bundleSha256: null },
    };
    const encodedProfile = Buffer.from(JSON.stringify(oldProfile), "utf8").toString("base64url");
    const workload = {
      ...packageWorkload(),
      encodedProfile,
      startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
    };

    expect(
      cloneSandboxWorkloadReceipt(workload, { harnessPackage: HARNESS_PACKAGE }),
    ).toBeUndefined();
  });

  it.each([
    ["no entry package", null],
    [
      "a different package ID",
      { ...HARNESS_PACKAGE, id: "other-harness" } satisfies HarnessPackageIdentity,
    ],
    [
      "a different package version",
      { ...HARNESS_PACKAGE, packageVersion: "1.2.4" } satisfies HarnessPackageIdentity,
    ],
    [
      "a different package digest",
      { ...HARNESS_PACKAGE, contentDigest: "d".repeat(64) } satisfies HarnessPackageIdentity,
    ],
  ] as const)("rejects package profile authority against %s", (_case, harnessPackage) => {
    expect(cloneSandboxWorkloadReceipt(packageWorkload(), { harnessPackage })).toBeUndefined();
  });

  it("round-trips a package profile with matching registry authority", async () => {
    const registry = await loadRegistryDocument({ sandboxes: {}, defaultSandbox: null });
    const workload = packageWorkload();

    registry.registerSandbox({
      name: "alpha",
      agent: HARNESS_PACKAGE.id,
      harnessPackage: HARNESS_PACKAGE,
      imageTag: workload.reference,
      workload,
    });

    expect(registry.getSandbox("alpha")).toMatchObject({
      agent: HARNESS_PACKAGE.id,
      harnessPackage: HARNESS_PACKAGE,
      workload,
    });
    registry.save(registry.load());
    expect(registry.getSandbox("alpha")?.workload).toEqual(workload);
  });

  it("persists receipt-backed OpenClaw with an explicit canonical agent", async () => {
    const registry = await loadRegistryDocument({ sandboxes: {}, defaultSandbox: null });
    const openClawPackage = { ...HARNESS_PACKAGE, id: "openclaw" };
    const workload = packageWorkload(openClawPackage);

    registry.registerSandbox({
      name: "openclaw-sandbox",
      agent: "openclaw",
      harnessPackage: openClawPackage,
      imageTag: workload.reference,
      workload,
    });

    expect(registry.getSandbox("openclaw-sandbox")).toMatchObject({
      agent: "openclaw",
      harnessPackage: openClawPackage,
    });
  });

  it.each([
    ["no package authority", undefined],
    [
      "a different package ID",
      { ...HARNESS_PACKAGE, id: "other-harness" } satisfies HarnessPackageIdentity,
    ],
    [
      "a different package digest",
      { ...HARNESS_PACKAGE, contentDigest: "d".repeat(64) } satisfies HarnessPackageIdentity,
    ],
  ] as const)("fails closed while loading a package profile with %s", async (_case, authority) => {
    const workload = packageWorkload();
    const registry = await loadRegistryDocument({
      sandboxes: {
        alpha: {
          name: "alpha",
          agent: HARNESS_PACKAGE.id,
          ...(authority === undefined ? {} : { harnessPackage: authority }),
          imageTag: workload.reference,
          workload,
        },
      },
      defaultSandbox: "alpha",
    });

    expect(() => registry.getSandbox("alpha")).toThrow(
      "Cannot load a sandbox entry with an invalid workload receipt",
    );
  });

  it.each([
    ["is absent", undefined],
    [
      "disagrees",
      { ...HARNESS_PACKAGE, contentDigest: "d".repeat(64) } satisfies HarnessPackageIdentity,
    ],
  ] as const)(
    "rejects registration when package profile authority %s",
    async (_case, authority) => {
      const registry = await loadRegistryDocument({ sandboxes: {}, defaultSandbox: null });
      const workload = packageWorkload();

      expect(() =>
        registry.registerSandbox({
          name: "alpha",
          agent: HARNESS_PACKAGE.id,
          ...(authority === undefined ? {} : { harnessPackage: authority }),
          imageTag: workload.reference,
          workload,
        }),
      ).toThrow("Cannot register a sandbox with an invalid workload receipt");
    },
  );
});
