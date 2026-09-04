// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  HarnessMcpRegistrationPlan,
  HarnessMcpRemovalPlan,
} from "../../../agent-runtime/host-module";
import type { McpBridgeEntry } from "../../../state/registry";

const mocks = vi.hoisted(() => ({
  buildInspection: vi.fn(),
  buildRegistration: vi.fn(),
  buildRemoval: vi.fn(),
  executeArgv: vi.fn(),
  executeShell: vi.fn(),
  getSandbox: vi.fn(),
  inspectRegistration: vi.fn(),
  observeCredentialRevision: vi.fn(),
}));

vi.mock("../../../state/registry", () => ({
  getSandbox: mocks.getSandbox,
}));

vi.mock("../mcp-bridge-adapter-inspection", () => ({
  inspectAdapterRegistrationCommand: mocks.inspectRegistration,
}));

vi.mock("../mcp-bridge-provider-readiness", () => ({
  observeMcpCredentialRevision: mocks.observeCredentialRevision,
}));

vi.mock("./command-execution", () => ({
  executeMcpArgvCommand: mocks.executeArgv,
  executeMcpShellCommand: mocks.executeShell,
}));

vi.mock("./package-command", () => ({
  buildInstalledMcpInspectionCommand: mocks.buildInspection,
  buildInstalledMcpRegistrationPlan: mocks.buildRegistration,
  buildInstalledMcpRemovalPlan: mocks.buildRemoval,
}));

import { registerInstalledMcpAdapter, unregisterInstalledMcpAdapter } from "./package-mutation";

const ENTRY: McpBridgeEntry = Object.freeze({
  server: "docs",
  agent: "future-harness",
  adapter: "future-config",
  url: "https://example.test/mcp",
  env: ["FUTURE_TOKEN"],
  providerName: "future-provider",
  policyName: "future-policy",
  addedAt: "2026-08-30T12:00:00.000Z",
});
const runtimeSelection = { gatewayName: "nemoclaw-8091", workspace: "default" } as const;

function registrationPlan(
  overrides: Partial<HarnessMcpRegistrationPlan> = {},
): HarnessMcpRegistrationPlan {
  return {
    execution: {
      command: "future-register",
      timeoutSeconds: 15,
      success: { kind: "exit-zero" },
      failureMessage: "Future registration failed.",
    },
    verification: {
      kind: "inspection",
      failureMessage: "Future registration verification failed",
    },
    credentialConvergence: { kind: "none" },
    ...overrides,
  };
}

function removalPlan(overrides: Partial<HarnessMcpRemovalPlan> = {}): HarnessMcpRemovalPlan {
  return {
    execution: {
      command: "future-remove",
      timeoutSeconds: 15,
      success: { kind: "exit-zero" },
      failureMessage: "Future removal failed.",
    },
    outcome: { kind: "removed" },
    ...overrides,
  };
}

beforeEach(() => {
  mocks.buildInspection.mockReset().mockReturnValue("future-inspect");
  mocks.buildRegistration.mockReset().mockReturnValue(registrationPlan());
  mocks.buildRemoval.mockReset().mockReturnValue(removalPlan());
  mocks.executeArgv.mockReset().mockReturnValue({ status: 0, stdout: "", stderr: "" });
  mocks.executeShell.mockReset().mockReturnValue({ status: 0, stdout: "", stderr: "" });
  mocks.getSandbox.mockReset().mockReturnValue({
    mcp: {
      bridges: {
        search: {
          ...ENTRY,
          server: "search",
          url: "https://search.test/mcp",
        },
      },
    },
  });
  mocks.inspectRegistration.mockReset().mockReturnValue({ state: "registered" });
  mocks.observeCredentialRevision.mockReset().mockReturnValue("v12");
});

describe("installed MCP package mutation", () => {
  it("registers an unknown package adapter through one shell plan", () => {
    registerInstalledMcpAdapter(
      "alpha",
      "future-config",
      ENTRY,
      runtimeSelection,
      { FUTURE_TOKEN: "host-only-secret" },
      { credentialRevision: "v12", configDirectory: "/sandbox/.future" },
    );

    expect(mocks.buildRegistration).toHaveBeenCalledWith(
      "alpha",
      "future-config",
      ENTRY,
      expect.objectContaining({
        credentialRevision: "v12",
        configDirectory: "/sandbox/.future",
        managedEntries: expect.arrayContaining([
          expect.objectContaining({ server: "docs" }),
          expect.objectContaining({ server: "search" }),
        ]),
      }),
    );
    expect(mocks.executeShell).toHaveBeenCalledWith(
      "alpha",
      "future-register",
      15,
      runtimeSelection,
    );
    expect(mocks.executeArgv).not.toHaveBeenCalled();
    expect(mocks.inspectRegistration).toHaveBeenCalledWith(
      "alpha",
      ENTRY,
      "future-inspect",
      runtimeSelection,
    );
  });

  it("executes argv lifecycle plans and requires a valid reload response", () => {
    mocks.buildRegistration.mockReturnValue(
      registrationPlan({
        execution: {
          command: ["future-helper", "add"],
          timeoutSeconds: 620,
          success: {
            kind: "lifecycle-json",
            requireReload: true,
            invalidResponseMessage: "Future lifecycle response was invalid.",
            reloadRequiredMessage: "Future runtime did not reload.",
          },
          failureMessage: "Future lifecycle failed.",
        },
        credentialConvergence: {
          kind: "after-runtime-reload",
          unavailableMessage: "Future revision was unavailable.",
          unstableMessage: "Future revision did not converge.",
        },
      }),
    );
    mocks.executeArgv.mockReturnValue({
      status: 0,
      stdout: 'framing\n{"ok":true,"changed":true,"reloaded":true}\n',
      stderr: "",
    });

    registerInstalledMcpAdapter(
      "alpha",
      "future-config",
      ENTRY,
      runtimeSelection,
      {},
      {
        credentialRevision: "v12",
      },
    );

    expect(mocks.executeArgv).toHaveBeenCalledWith(
      "alpha",
      ["future-helper", "add"],
      620,
      runtimeSelection,
    );
    expect(mocks.executeShell).not.toHaveBeenCalled();
  });

  it("rebuilds a registration plan when runtime reload advances the credential revision", () => {
    const reloadPlan = registrationPlan({
      credentialConvergence: {
        kind: "after-runtime-reload",
        unavailableMessage: "Future revision was unavailable.",
        unstableMessage: "Future revision did not converge.",
      },
    });
    mocks.buildRegistration.mockReturnValue(reloadPlan);
    mocks.observeCredentialRevision.mockReturnValueOnce("v13").mockReturnValue("v13");

    registerInstalledMcpAdapter(
      "alpha",
      "future-config",
      ENTRY,
      runtimeSelection,
      {},
      {
        credentialRevision: "v12",
      },
    );

    expect(mocks.buildRegistration).toHaveBeenCalledTimes(2);
    expect(mocks.buildRegistration.mock.calls[1]?.[3]).toMatchObject({
      replaceExisting: true,
      credentialRevision: "v13",
    });
    expect(mocks.executeShell).toHaveBeenCalledTimes(2);
    expect(mocks.inspectRegistration).toHaveBeenCalledTimes(2);
  });

  it("rejects a lifecycle response that does not prove runtime reload", () => {
    mocks.buildRegistration.mockReturnValue(
      registrationPlan({
        execution: {
          command: ["future-helper", "add"],
          timeoutSeconds: 620,
          success: {
            kind: "lifecycle-json",
            requireReload: true,
            invalidResponseMessage: "Future lifecycle response was invalid.",
            reloadRequiredMessage: "Future runtime did not reload.",
          },
          failureMessage: "Future lifecycle failed.",
        },
      }),
    );
    mocks.executeArgv.mockReturnValue({
      status: 0,
      stdout: '{"ok":true,"changed":true,"reloaded":false}\n',
      stderr: "",
    });

    expect(() =>
      registerInstalledMcpAdapter("alpha", "future-config", ENTRY, runtimeSelection, {}),
    ).toThrow("Future runtime did not reload.");
    expect(mocks.inspectRegistration).not.toHaveBeenCalled();
  });

  it("accepts the standardized rollback confirmation without inspection", () => {
    mocks.buildRegistration.mockReturnValue(
      registrationPlan({
        verification: {
          kind: "rollback-restored",
          failureMessage: "Future rollback was not restored.",
        },
      }),
    );
    mocks.executeShell.mockReturnValue({
      status: 0,
      stdout: "NEMOCLAW_MCP_ROLLBACK_RESTORED=1\n",
      stderr: "",
    });

    registerInstalledMcpAdapter(
      "alpha",
      "future-config",
      ENTRY,
      runtimeSelection,
      {},
      {
        teardownRollback: true,
      },
    );

    expect(mocks.inspectRegistration).not.toHaveBeenCalled();
  });

  it("returns the package-reported removal outcome", () => {
    mocks.buildRemoval.mockReturnValue(
      removalPlan({ outcome: { kind: "stdout-removal-outcome" } }),
    );
    mocks.executeShell.mockReturnValue({
      status: 0,
      stdout: "NEMOCLAW_MCP_REMOVAL_OUTCOME=absent\n",
      stderr: "",
    });

    expect(unregisterInstalledMcpAdapter("alpha", "future-config", ENTRY, runtimeSelection)).toBe(
      "absent",
    );
  });

  it("redacts credentials from a package mutation failure", () => {
    mocks.executeShell.mockReturnValue({
      status: 2,
      stdout: "",
      stderr: "Authorization=Bearer host-only-secret",
    });

    expect(() =>
      unregisterInstalledMcpAdapter("alpha", "future-config", ENTRY, runtimeSelection, {
        envValues: { FUTURE_TOKEN: "host-only-secret" },
      }),
    ).toThrow("Authorization=Bearer ***REDACTED***");
    try {
      unregisterInstalledMcpAdapter("alpha", "future-config", ENTRY, runtimeSelection, {
        envValues: { FUTURE_TOKEN: "host-only-secret" },
      });
    } catch (error) {
      expect(String(error)).not.toContain("host-only-secret");
    }
  });

  it("preserves best-effort removal outcomes after command failure", () => {
    mocks.executeShell.mockReturnValue({ status: 2, stdout: "", stderr: "failed" });

    expect(
      unregisterInstalledMcpAdapter("alpha", "future-config", ENTRY, runtimeSelection, {
        bestEffort: true,
      }),
    ).toBe("removed");

    mocks.buildRemoval.mockReturnValue(
      removalPlan({ outcome: { kind: "stdout-removal-outcome" } }),
    );
    expect(
      unregisterInstalledMcpAdapter("alpha", "future-config", ENTRY, runtimeSelection, {
        bestEffort: true,
      }),
    ).toBe("unowned");
  });
});
