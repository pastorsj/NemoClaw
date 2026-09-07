// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadAdapter: vi.fn(),
  readAuthority: vi.fn(),
  resolvePackage: vi.fn(),
}));

vi.mock("../../../agent-runtime/roster-module", () => ({
  loadHarnessAgentRosterAdapterHostModule: mocks.loadAdapter,
}));
vi.mock("../../../onboard/package/package-authority", () => ({
  readRegisteredSandboxAuthority: mocks.readAuthority,
  resolvePackageBackedSandboxAgent: mocks.resolvePackage,
}));

import { resolveAgentRosterCommandAuthority } from "./command-authority";

const identity = {
  id: "future-roster",
  packageVersion: "1.0.0",
  contentDigest: "sha256:" + "a".repeat(64),
  source: {
    kind: "bundled",
    nemoclawBuildIdentity: { nemoclawVersion: "0.0.113", sourceRevision: "b".repeat(40) },
  },
} as const;

beforeEach(() => {
  mocks.loadAdapter.mockReturnValue({ buildAgentRosterCommand: vi.fn() });
});

describe("agent roster command authority", () => {
  it("loads a synthetic future package solely from its declared capability and receipt", () => {
    mocks.readAuthority.mockReturnValue({
      agent: "future-roster",
      harnessPackage: identity,
      harnessPackageMigration: null,
    });
    mocks.resolvePackage.mockReturnValue({
      harnessPackage: identity,
      definition: {
        name: "future-roster",
        displayName: "Future Roster",
        agentRosterCapability: {
          support: "managed",
          adapter: "agent-roster",
          onboarding_environment: "NEMOCLAW_EXTRA_AGENTS_JSON",
        },
      },
    });

    expect(resolveAgentRosterCommandAuthority("alpha")).toMatchObject({
      kind: "package",
      identity,
      displayName: "Future Roster",
    });
    expect(mocks.loadAdapter).toHaveBeenCalledWith(identity);
  });

  it("returns typed unsupported and never loads an adapter when a receipt omits the capability", () => {
    mocks.readAuthority.mockReturnValue({
      agent: "future-harness",
      harnessPackage: identity,
      harnessPackageMigration: null,
    });
    mocks.resolvePackage.mockReturnValue({
      harnessPackage: identity,
      definition: {
        name: "future-harness",
        displayName: "Future Harness",
        agentRosterCapability: null,
      },
    });

    expect(resolveAgentRosterCommandAuthority("alpha")).toEqual({
      kind: "unsupported",
      displayName: "Future Harness",
      reason: "Future Harness does not declare managed agent roster support.",
    });
    expect(mocks.loadAdapter).not.toHaveBeenCalled();
  });

  it("uses legacy behavior only when the registry has no package receipt", () => {
    mocks.readAuthority.mockReturnValue({
      agent: null,
      harnessPackage: null,
      harnessPackageMigration: null,
    });

    expect(resolveAgentRosterCommandAuthority("alpha")).toEqual({ kind: "legacy" });
    expect(mocks.resolvePackage).not.toHaveBeenCalled();
    expect(mocks.loadAdapter).not.toHaveBeenCalled();
  });

  it("does not reinterpret a malformed receipt as legacy behavior", () => {
    mocks.readAuthority.mockReturnValue({
      agent: "future-roster",
      harnessPackage: null,
      harnessPackageMigration: { legacyAgent: "future-roster" },
    });
    mocks.resolvePackage.mockImplementation(() => {
      throw new Error("receipt is incomplete");
    });

    expect(() => resolveAgentRosterCommandAuthority("alpha")).toThrow(/receipt is incomplete/u);
    expect(mocks.loadAdapter).not.toHaveBeenCalled();
  });
});
