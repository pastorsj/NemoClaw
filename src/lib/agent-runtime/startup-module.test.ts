// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import type { HarnessStartupSettings } from "@nvidia/nemoclaw-harness-contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TEST_CONFIG_ADAPTER_SOURCE,
  TEST_MESSAGING_ADAPTER_SOURCE,
} from "../../../test/helpers/adapter-fixtures";
import { installHarnessPackage } from "./package/install";
import type { InstalledHarnessPackage } from "./package/store";
import {
  HarnessStartupModuleError,
  loadHarnessStartupProfileAdapterHostModule,
} from "./startup-module";

const TEST_PARENT = path.join(process.cwd(), "node_modules/.cache/nemoclaw-startup-module-tests");
const SOURCE_IDENTITY = Object.freeze({
  kind: "bundled" as const,
  nemoclawBuildIdentity: Object.freeze({
    nemoclawVersion: "0.0.113",
    sourceRevision: "d".repeat(40),
  }),
});
const DESIRED_STATE: HarnessStartupSettings = {
  configuration: {},
  inference: {
    routeProvider: "inference",
    upstreamProvider: "nvidia-prod",
    model: "nvidia/future-model",
    routedBaseUrl: "https://inference.local/v1",
    upstreamEndpointUrl: null,
    api: "openai-completions",
    primaryModelRef: null,
    compatibility: null,
    inputModalities: null,
  },
  proxy: {
    managedHost: "10.200.0.1",
    managedPort: 3128,
    hostHttpUrl: null,
    hostHttpsUrl: null,
    hostNoProxy: [],
  },
  dashboard: { mode: "disabled" },
  tools: { disclosure: "progressive", enabledGateways: [] },
  messaging: { plan: null },
  tuning: {
    contextWindow: null,
    maxTokens: null,
    reasoning: null,
    reasoningEffort: null,
  },
  corporateCa: { bundleSha256: null },
};
const STARTUP_MODULE = `
module.exports = {
  buildStartupPlan() { throw new Error("not used by this host contract"); },
  prepareStartupProfile(request) {
    const candidate = request.input.inference.candidates[0];
    return {
      kind: "prepared",
      desiredState: {
        configuration: { agent: request.packageId, mode: request.input.environment.FUTURE_MODE },
        inference: {
          routeProvider: candidate.routeProvider,
          upstreamProvider: request.input.inference.selectedProvider || candidate.routeProvider,
          model: request.input.inference.model,
          routedBaseUrl: candidate.routedBaseUrl,
          upstreamEndpointUrl: request.input.inference.endpointUrl,
          api: candidate.api,
          primaryModelRef: null,
          compatibility: null,
          inputModalities: null,
        },
        proxy: request.input.proxy,
        dashboard: { agent: request.packageId, mode: "disabled" },
        tools: request.input.tools,
        messaging: { plan: request.input.messagingPlan },
        tuning: { contextWindow: null, maxTokens: null, reasoning: null, reasoningEffort: null },
        corporateCa: request.input.corporateCa,
      },
      credentialProxyReplayRequired: request.input.credentialProxyPresent,
      dashboardRemoteBindPrepared: false,
    };
  },
  buildInitialStartupProfile(request) {
    return {
      kind: "package-config",
      packageConfig: { settings: request.desiredState, revision: 1 },
    };
  },
  reconcileStartupProfile(request) {
    return {
      kind: "package-config",
      packageConfig: {
        ...request.currentPackageConfig,
        settings: request.desiredState,
        revision: 2,
      },
      changed: true,
    };
  },
};
`;

fs.mkdirSync(TEST_PARENT, { recursive: true, mode: 0o700 });

let fixtureRoot = "";
let sourceRoot = "";
let storeRoot = "";

function writeFixtureFile(relativePath: string, contents: string): void {
  const target = path.join(sourceRoot, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, contents, { mode: 0o600 });
}

function installFuturePackage(startupModule = STARTUP_MODULE): InstalledHarnessPackage {
  writeFixtureFile(
    "nemoclaw-package.json",
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "agent-runtime",
      id: "future-harness",
      displayName: "Future Harness",
      packageVersion: "1.0.0",
      minimumNemoClawVersion: "0.0.113",
      maximumNemoClawVersionExclusive: "0.0.121",
      manifest: "packages/nemoclaw-future-harness/manifest.yaml",
    })}\n`,
  );
  writeFixtureFile(
    "packages/nemoclaw-future-harness/manifest.yaml",
    [
      "name: future-harness",
      "runtime:",
      "  kind: terminal",
      "  prompt_transport: stdin",
      "  headless_command: future-harness run",
      "config:",
      "  dir: /sandbox/.future-harness",
      "  config_file: config.json",
      "  format: json",
      "inference:",
      "  config_update:",
      "    support: unsupported",
      "    reason: This synthetic package receives inference through its startup adapter.",
      "messaging:",
      "  support: disabled",
      "policy:",
      "  owned_presets: []",
      "  automatic_presets: []",
      "  baseline_exclusion_impacts: {}",
      "state_lifecycle:",
      "  backup_quiescence:",
      "    kind: not-required",
      "  snapshot_restore: []",
      "  rebuild:",
      "    managed_extensions:",
      "      support: disabled",
      "      reason: Test package has no managed extensions.",
      "    scheduled_work:",
      "      support: disabled",
      "      reason: This synthetic package does not run scheduled work.",
      "    post_restore:",
      "      kind: not-required",
      "managed_image:",
      "  repository: ghcr.io/example/future-harness-sandbox",
      "  architectures:",
      "    - linux/amd64",
      "  runtime_identity:",
      "    uid: 999",
      "    gid: 999",
      "    workdir: /sandbox",
      "  startup_profile_environment:",
      "    - name: FUTURE_MODE",
      "      value_type: string",
      "      max_bytes: 16",
      "    - name: FUTURE_MAX_TOKENS",
      "      value_type: positive-integer",
      "      max_bytes: 10",
      "",
    ].join("\n"),
  );
  writeFixtureFile(
    "packages/nemoclaw-future-harness/host/config-adapter.cts",
    TEST_CONFIG_ADAPTER_SOURCE,
  );
  writeFixtureFile(
    "packages/nemoclaw-future-harness/host/messaging-adapter.cts",
    TEST_MESSAGING_ADAPTER_SOURCE,
  );
  writeFixtureFile("packages/nemoclaw-future-harness/host/startup-adapter.cts", startupModule);
  return installHarnessPackage(
    { packageRoot: sourceRoot, sourceIdentity: SOURCE_IDENTITY },
    { storeRoot },
  );
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(TEST_PARENT, "fixture-"));
  sourceRoot = path.join(fixtureRoot, "source");
  storeRoot = path.join(fixtureRoot, "store");
  fs.mkdirSync(storeRoot, { recursive: true, mode: 0o700 });
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("installed harness startup profile adapter", () => {
  it("prepares an unknown package from only its receipt-declared environment input", () => {
    const installed = installFuturePackage();
    const adapter = loadHarnessStartupProfileAdapterHostModule(installed.identity, { storeRoot });
    const input = {
      inference: {
        selectedProvider: "nvidia-prod",
        model: "nvidia/future-model",
        endpointUrl: null,
        resolvedContextWindow: null,
        reasoningEnabled: null,
        reasoningEffort: null,
        candidates: [
          {
            requestedApi: null,
            routeProvider: "inference",
            routedBaseUrl: "https://inference.local/v1",
            api: "openai-completions" as const,
            primaryModelRef: "inference/nvidia/future-model",
            compatibility: null,
          },
        ],
      },
      dashboard: {
        managed: false,
        url: "",
        port: 0,
        bindAddress: null,
        wslExposure: false,
        forwarding: { enabled: false, publicPort: null, internalPort: null, tuiEnabled: false },
      },
      webSearch: null,
      tools: { disclosure: "progressive" as const, enabledGateways: [] },
      messagingPlan: null,
      approvalMode: "disabled" as const,
      observabilityEnabled: false,
      proxy: DESIRED_STATE.proxy,
      environment: { FUTURE_MODE: "safe", FUTURE_MAX_TOKENS: "4096" },
      corporateCa: DESIRED_STATE.corporateCa,
      credentialProxyPresent: false,
    };

    expect(adapter.startupProfileEnvironment).toEqual([
      { name: "FUTURE_MODE", value_type: "string", max_bytes: 16 },
      { name: "FUTURE_MAX_TOKENS", value_type: "positive-integer", max_bytes: 10 },
    ]);
    expect(
      adapter.prepareStartupProfile({
        packageId: installed.identity.id,
        harnessPackage: installed.identity,
        phase: "initial",
        input,
        previousDesiredState: null,
      }),
    ).toMatchObject({
      kind: "prepared",
      desiredState: { configuration: { agent: "future-harness", mode: "safe" } },
    });
    expect(() =>
      adapter.prepareStartupProfile({
        packageId: installed.identity.id,
        harnessPackage: installed.identity,
        phase: "initial",
        input: { ...input, environment: { UNDECLARED_MODE: "unsafe" } },
        previousDesiredState: null,
      }),
    ).toThrow(/undeclared or oversized/u);
    expect(() =>
      adapter.prepareStartupProfile({
        packageId: installed.identity.id,
        harnessPackage: installed.identity,
        phase: "initial",
        input: {
          ...input,
          environment: { FUTURE_MODE: "safe", FUTURE_MAX_TOKENS: "004096" },
        },
        previousDesiredState: null,
      }),
    ).toThrow(/undeclared or oversized/u);
  });

  it("constructs and reconciles opaque state for an unknown receipt-backed package", () => {
    const installed = installFuturePackage();
    const adapter = loadHarnessStartupProfileAdapterHostModule(installed.identity, { storeRoot });
    const request = {
      packageId: installed.identity.id,
      harnessPackage: installed.identity,
      desiredState: DESIRED_STATE,
    };

    expect(adapter.buildInitialStartupProfile(request)).toEqual({
      kind: "package-config",
      packageConfig: { settings: DESIRED_STATE, revision: 1 },
    });
    expect(
      adapter.reconcileStartupProfile({
        ...request,
        currentPackageConfig: { extension: { retained: true }, revision: 1 },
      }),
    ).toEqual({
      kind: "package-config",
      packageConfig: {
        extension: { retained: true },
        settings: DESIRED_STATE,
        revision: 2,
      },
      changed: true,
    });
  });

  it("preserves an explicit package refusal", () => {
    const installed = installFuturePackage(
      STARTUP_MODULE.replace(
        'return {\n      kind: "package-config",\n      packageConfig: { settings: request.desiredState, revision: 1 },\n    };',
        'return { kind: "unsupported", reason: "Profile construction is unavailable." };',
      ),
    );
    const adapter = loadHarnessStartupProfileAdapterHostModule(installed.identity, { storeRoot });

    expect(
      adapter.buildInitialStartupProfile({
        packageId: installed.identity.id,
        harnessPackage: installed.identity,
        desiredState: DESIRED_STATE,
      }),
    ).toEqual({ kind: "unsupported", reason: "Profile construction is unavailable." });
  });

  it("rejects cross-package dispatch before invoking adapter code", () => {
    const installed = installFuturePackage();
    const adapter = loadHarnessStartupProfileAdapterHostModule(installed.identity, { storeRoot });

    expect(() =>
      adapter.buildInitialStartupProfile({
        packageId: "another-harness",
        harnessPackage: { ...installed.identity, id: "another-harness" },
        desiredState: DESIRED_STATE,
      }),
    ).toThrow(/does not match its installed harness package identity/u);
  });

  it("rejects a stale version or digest before invoking adapter code", () => {
    const installed = installFuturePackage();
    const adapter = loadHarnessStartupProfileAdapterHostModule(installed.identity, { storeRoot });

    [
      { ...installed.identity, packageVersion: "0.9.0" },
      { ...installed.identity, contentDigest: "e".repeat(64) },
    ].forEach((harnessPackage) => {
      expect(() =>
        adapter.buildInitialStartupProfile({
          packageId: installed.identity.id,
          harnessPackage,
          desiredState: DESIRED_STATE,
        }),
      ).toThrow(/does not match its installed harness package identity/u);
    });
  });

  it("rejects invalid reconciliation metadata from the package", () => {
    const installed = installFuturePackage(
      STARTUP_MODULE.replace("changed: true", 'changed: "yes"'),
    );
    const adapter = loadHarnessStartupProfileAdapterHostModule(installed.identity, { storeRoot });

    expect(() =>
      adapter.reconcileStartupProfile({
        packageId: installed.identity.id,
        harnessPackage: installed.identity,
        desiredState: DESIRED_STATE,
        currentPackageConfig: {},
      }),
    ).toThrow(/returned an invalid reconciled startup profile result/u);
  });

  it("rejects an unnormalized desired-state request at the JSON contract", () => {
    const installed = installFuturePackage();
    const adapter = loadHarnessStartupProfileAdapterHostModule(installed.identity, { storeRoot });

    expect(() =>
      adapter.buildInitialStartupProfile({
        packageId: installed.identity.id,
        harnessPackage: installed.identity,
        desiredState: { ...DESIRED_STATE, unknownSetting: true } as HarnessStartupSettings,
      }),
    ).toThrow(/does not satisfy its schema/u);
  });

  it("rejects an uninstalled package identity", () => {
    expect(() =>
      loadHarnessStartupProfileAdapterHostModule(
        {
          kind: "agent-runtime",
          id: "missing-harness",
          packageVersion: "1.0.0",
          contentDigest: "f".repeat(64),
        },
        { storeRoot },
      ),
    ).toThrow(HarnessStartupModuleError);
  });
});
