// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSandbox: vi.fn(),
  loadHostModule: vi.fn(),
  buildRegistration: vi.fn(),
  buildRemoval: vi.fn(),
}));

vi.mock("../mcp-bridge-state", () => ({
  getSandboxHarnessPackage: mocks.getSandbox,
}));

vi.mock("../../../agent-runtime/host-module", () => ({
  loadHarnessMcpAdapterHostModule: mocks.loadHostModule,
}));

import {
  buildInstalledMcpRegistrationCommand,
  buildInstalledMcpRemovalCommand,
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
  mocks.buildRegistration.mockReset().mockReturnValue(["future-register"]);
  mocks.buildRemoval.mockReset().mockReturnValue("future-remove");
  mocks.loadHostModule.mockReturnValue({
    buildMcpRegistrationCommand: mocks.buildRegistration,
    buildMcpRemovalCommand: mocks.buildRemoval,
  });
});

describe("installed MCP package command boundary", () => {
  it("keeps legacy sandboxes on their existing adapter path", () => {
    mocks.getSandbox.mockReturnValue(null);

    expect(buildInstalledMcpRegistrationCommand("alpha", "future-config", ENTRY)).toBeNull();
    expect(mocks.loadHostModule).not.toHaveBeenCalled();
  });

  it("builds registration through the exact package and opaque credential placeholder", () => {
    mocks.getSandbox.mockReturnValue(PACKAGE_IDENTITY);

    expect(
      buildInstalledMcpRegistrationCommand("alpha", "future-config", ENTRY, {
        replaceExisting: true,
        credentialRevision: "v7",
        managedEntries: [ENTRY],
        configRoot: "/sandbox/.future",
      }),
    ).toEqual(["future-register"]);
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
      configRoot: "/sandbox/.future",
    });
  });

  it("builds removal through the package without exposing a host credential", () => {
    mocks.getSandbox.mockReturnValue(PACKAGE_IDENTITY);

    expect(
      buildInstalledMcpRemovalCommand("alpha", "future-config", ENTRY, {
        force: true,
        adaptiveTeardown: true,
      }),
    ).toBe("future-remove");
    expect(mocks.buildRemoval).toHaveBeenCalledWith({
      entry: {
        server: "docs",
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer openshell:resolve:env:FUTURE_TOKEN" },
      },
      force: true,
      adaptiveTeardown: true,
      configRoot: null,
    });
  });

  it("fails closed when the registry package belongs to a different agent", () => {
    mocks.getSandbox.mockReturnValue({ ...PACKAGE_IDENTITY, id: "other-harness" });

    expect(() => buildInstalledMcpRegistrationCommand("alpha", "future-config", ENTRY)).toThrow(
      /does not match its package agent/u,
    );
    expect(mocks.loadHostModule).not.toHaveBeenCalled();
  });
});
