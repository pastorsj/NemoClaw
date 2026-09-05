// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSandbox: vi.fn(),
  loadHostModule: vi.fn(),
  buildRegistration: vi.fn(),
  buildRemoval: vi.fn(),
  buildInspection: vi.fn(),
  describeMutation: vi.fn(),
  describeTeardown: vi.fn(),
  describeIntent: vi.fn(),
  buildRuntime: vi.fn(),
}));

vi.mock("../mcp-bridge-state", () => ({
  getSandboxHarnessPackage: mocks.getSandbox,
}));

vi.mock("../../../agent-runtime/host-module", () => ({
  loadHarnessMcpAdapterHostModule: mocks.loadHostModule,
}));

import {
  buildInstalledMcpInspectionCommand,
  buildInstalledMcpRegistrationPlan,
  buildInstalledMcpRemovalPlan,
  buildInstalledMcpRuntimeCommand,
  describeInstalledMcpMutationCapability,
  describeInstalledMcpRuntimeIntentVerification,
  describeInstalledMcpTeardownCapability,
} from "./package-command";

const PACKAGE_IDENTITY = Object.freeze({
  kind: "agent-runtime" as const,
  id: "future-harness",
  packageVersion: "1.0.0",
  contentDigest: "a".repeat(64),
});

const ENTRY = Object.freeze({
  server: "docs",
  agent: "future-harness",
  adapter: "future-config",
  url: "https://example.test/mcp",
  env: ["FUTURE_TOKEN"],
  providerName: "future-provider",
  policyName: "future-policy",
  addedAt: "2026-08-30T12:00:00.000Z",
});

beforeEach(() => {
  mocks.getSandbox.mockReset();
  mocks.loadHostModule.mockReset();
  mocks.buildRegistration.mockReset().mockReturnValue({
    execution: {
      command: ["future-register"],
      timeoutSeconds: 15,
      success: { kind: "exit-zero" },
      failureMessage: "future registration failed",
    },
    verification: { kind: "inspection", failureMessage: "future verification failed" },
    credentialConvergence: { kind: "none" },
  });
  mocks.buildRemoval.mockReset().mockReturnValue({
    execution: {
      command: "future-remove",
      timeoutSeconds: 15,
      success: { kind: "exit-zero" },
      failureMessage: "future removal failed",
    },
    outcome: { kind: "removed" },
  });
  mocks.buildInspection.mockReset().mockReturnValue("future-inspect");
  mocks.describeMutation.mockReset().mockReturnValue({
    kind: "command",
    command: ["future-probe"],
    success: { kind: "exit-zero" },
    timeoutSeconds: 10,
    failureMessage: "future runtime is unavailable",
  });
  mocks.describeTeardown.mockReset().mockReturnValue({ kind: "not-required" });
  mocks.describeIntent.mockReset().mockReturnValue({ kind: "not-required" });
  mocks.buildRuntime.mockReset().mockReturnValue(["future-runtime"]);
  mocks.loadHostModule.mockReturnValue({
    buildMcpRegistrationPlan: mocks.buildRegistration,
    buildMcpRemovalPlan: mocks.buildRemoval,
    buildMcpInspectionCommand: mocks.buildInspection,
    describeMcpMutationCapability: mocks.describeMutation,
    describeMcpTeardownCapability: mocks.describeTeardown,
    describeMcpRuntimeIntentVerification: mocks.describeIntent,
    buildMcpRuntimeCommand: mocks.buildRuntime,
  });
});

describe("installed MCP package command boundary", () => {
  it("returns no package plan when central orchestration has not established authority", () => {
    mocks.getSandbox.mockReturnValue(null);

    expect(buildInstalledMcpRegistrationPlan("alpha", "future-config", ENTRY)).toBeNull();
    expect(mocks.loadHostModule).not.toHaveBeenCalled();
  });

  it("builds registration through the exact package and opaque credential placeholder", () => {
    mocks.getSandbox.mockReturnValue(PACKAGE_IDENTITY);

    expect(
      buildInstalledMcpRegistrationPlan("alpha", "future-config", ENTRY, {
        replaceExisting: true,
        credentialRevision: "v7",
        managedEntries: [ENTRY],
        configDirectory: "/sandbox/.future",
      }),
    ).toMatchObject({ execution: { command: ["future-register"] } });
    expect(mocks.loadHostModule).toHaveBeenCalledWith(PACKAGE_IDENTITY, {
      expectedAdapter: "future-config",
    });
    expect(mocks.buildRegistration).toHaveBeenCalledWith({
      entry: {
        server: "docs",
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer openshell:resolve:env:v7_FUTURE_TOKEN" },
      },
      managedEntries: [
        {
          server: "docs",
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer openshell:resolve:env:v7_FUTURE_TOKEN" },
        },
      ],
      replaceExisting: true,
      teardownRollback: false,
      configDirectory: "/sandbox/.future",
    });
  });

  it("builds removal through the package without exposing a host credential", () => {
    mocks.getSandbox.mockReturnValue(PACKAGE_IDENTITY);

    expect(
      buildInstalledMcpRemovalPlan("alpha", "future-config", ENTRY, {
        force: true,
        adaptiveTeardown: true,
      }),
    ).toMatchObject({ execution: { command: "future-remove" } });
    expect(mocks.buildRemoval).toHaveBeenCalledWith({
      entry: {
        server: "docs",
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer openshell:resolve:env:FUTURE_TOKEN" },
      },
      force: true,
      adaptiveTeardown: true,
      configDirectory: null,
    });
  });

  it("builds inspection through the package with the selected configuration root", () => {
    mocks.getSandbox.mockReturnValue(PACKAGE_IDENTITY);

    expect(
      buildInstalledMcpInspectionCommand("alpha", "future-config", ENTRY, {
        failOnMismatch: true,
        credentialRevision: "v8",
        configDirectory: "/sandbox/.future",
      }),
    ).toBe("future-inspect");
    expect(mocks.buildInspection).toHaveBeenCalledWith({
      entry: {
        server: "docs",
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer openshell:resolve:env:v8_FUTURE_TOKEN" },
      },
      failOnMismatch: true,
      configDirectory: "/sandbox/.future",
    });
  });

  it("loads capability probes and runtime commands from the sandbox package", () => {
    mocks.getSandbox.mockReturnValue(PACKAGE_IDENTITY);

    expect(describeInstalledMcpMutationCapability("alpha", "future-config", ENTRY.agent)).toEqual({
      kind: "command",
      command: ["future-probe"],
      success: { kind: "exit-zero" },
      timeoutSeconds: 10,
      failureMessage: "future runtime is unavailable",
    });
    expect(describeInstalledMcpTeardownCapability("alpha", "future-config", ENTRY.agent)).toEqual({
      kind: "not-required",
    });
    expect(
      describeInstalledMcpRuntimeIntentVerification(
        "alpha",
        "future-config",
        ENTRY.agent,
        [ENTRY],
        ["docs", "search"],
        new Map([["docs", "v9"]]),
      ),
    ).toEqual({ kind: "not-required" });
    expect(
      buildInstalledMcpRuntimeCommand("alpha", "future-config", ENTRY.agent, ["node", "probe.mjs"]),
    ).toEqual(["future-runtime"]);
    expect(mocks.describeMutation).toHaveBeenCalledWith({ sandboxName: "alpha" });
    expect(mocks.describeTeardown).toHaveBeenCalledWith({ sandboxName: "alpha" });
    expect(mocks.describeIntent).toHaveBeenCalledWith({
      entries: [
        {
          server: "docs",
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer openshell:resolve:env:v9_FUTURE_TOKEN" },
        },
      ],
      managedServerNames: ["docs", "search"],
    });
    expect(mocks.buildRuntime).toHaveBeenCalledWith({ command: ["node", "probe.mjs"] });
  });

  it("fails closed when the registry package belongs to a different agent", () => {
    mocks.getSandbox.mockReturnValue({ ...PACKAGE_IDENTITY, id: "other-harness" });

    expect(() => buildInstalledMcpRegistrationPlan("alpha", "future-config", ENTRY)).toThrow(
      /does not match its package agent/u,
    );
    expect(mocks.loadHostModule).not.toHaveBeenCalled();
  });

  it("fails closed when the package runtime-intent operation throws", () => {
    mocks.getSandbox.mockReturnValue(PACKAGE_IDENTITY);
    mocks.describeIntent.mockImplementation(() => {
      throw new Error("malformed runtime-intent probe");
    });

    expect(() =>
      describeInstalledMcpRuntimeIntentVerification(
        "alpha",
        "future-config",
        ENTRY.agent,
        [ENTRY],
        ["docs"],
      ),
    ).toThrow(/could not describe its runtime intent verification.*malformed/u);
  });
});
