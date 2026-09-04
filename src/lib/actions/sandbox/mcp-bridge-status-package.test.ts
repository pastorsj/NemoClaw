// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadAgent: vi.fn(),
  ensureGateway: vi.fn(),
  inspectRuntimeIntent: vi.fn(),
  buildInstalledInspection: vi.fn(),
  executeSandboxCommand: vi.fn(),
  legacyOpenClawInspection: vi.fn(),
  legacyHermesInspection: vi.fn(),
  legacyDeepAgentsInspection: vi.fn(),
  getSandbox: vi.fn(),
}));

vi.mock("../../agent/defs", () => ({ loadAgent: mocks.loadAgent }));

vi.mock("./mcp-bridge-adapters", () => ({
  buildDeepAgentsMcpStatusCommand: mocks.legacyDeepAgentsInspection,
  buildHermesMcpStatusCommand: mocks.legacyHermesInspection,
  buildOpenClawMcporterInspectCommand: mocks.legacyOpenClawInspection,
  DEFAULT_OPENCLAW_CONFIG_DIR: "/sandbox/.openclaw",
  inspectAgentMcpRuntimeIntent: mocks.inspectRuntimeIntent,
  openClawMcporterRoot: (directory: string) => directory,
}));

vi.mock("./mcp-bridge-policy", () => ({
  getRegisteredGeneratedPolicy: () => ({ name: "mcp-bridge-docs", content: "policy" }),
  getPolicyPresence: () => true,
}));

vi.mock("./mcp-bridge-provider", () => ({
  inspectMcpProvider: () => ({ exists: true }),
  observeMcpCredentialRevision: () => "v7",
  providerAttached: () => true,
  providerMatchesCredential: () => true,
  providerShapeDetail: () => undefined,
}));

vi.mock("./mcp-bridge-resolution-probe", () => ({
  credentialResolutionWarning: () => undefined,
  probeCredentialResolution: vi.fn(),
}));

vi.mock("./mcp-bridge-state", () => ({
  bridgeState: (sandbox: { mcp?: { bridges?: Record<string, unknown> } }) =>
    sandbox.mcp?.bridges ?? {},
  ensureSandboxGatewaySelected: mocks.ensureGateway,
  getAgentConfigDir: () => "/sandbox/.future",
  getSandboxAgent: (sandbox: { definition: unknown }) => sandbox.definition,
  getSandboxOrThrow: mocks.getSandbox,
}));

vi.mock("./mcp-bridge-tool-discovery", () => ({ discoverMcpTools: vi.fn() }));
vi.mock("./mcp-bridge-url-validation", () => ({ inspectMcpRecordedTargetPins: vi.fn() }));
vi.mock("./process-recovery", () => ({ executeSandboxCommand: mocks.executeSandboxCommand }));
vi.mock("./mcp-bridge/package-command", () => ({
  buildInstalledMcpInspectionCommand: mocks.buildInstalledInspection,
}));

import { statusMcpBridge } from "./mcp-bridge-status";

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
  allowedIps: ["8.8.8.8"],
  providerName: "future-provider",
  providerId: "11111111-2222-4333-8444-555555555555",
  policyName: "mcp-bridge-docs",
  addedAt: "2026-08-30T12:00:00.000Z",
});
const SEARCH_ENTRY = Object.freeze({
  ...ENTRY,
  server: "search",
  env: ["SEARCH_TOKEN"],
  providerName: "future-search-provider",
  providerId: "22222222-3333-4444-8555-666666666666",
  policyName: "mcp-bridge-search",
});

const SYNTHETIC_DEFINITION = Object.freeze({
  name: "future-harness",
  mcpCapability: Object.freeze({
    support: "bridge" as const,
    adapter: "future-config",
    policy_binaries: Object.freeze(["/opt/future/bin/runtime"]),
  }),
});

const SYNTHETIC_SANDBOX = Object.freeze({
  name: "alpha",
  agent: "future-harness",
  harnessPackage: PACKAGE_IDENTITY,
  definition: SYNTHETIC_DEFINITION,
  mcp: Object.freeze({
    bridges: Object.freeze({ docs: ENTRY }),
    managedServerNames: Object.freeze(["docs"]),
  }),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSandbox.mockReturnValue(SYNTHETIC_SANDBOX);
  mocks.inspectRuntimeIntent.mockReturnValue(undefined);
  mocks.buildInstalledInspection.mockReturnValue("future-inspect");
  mocks.executeSandboxCommand.mockReturnValue({ status: 0, stdout: "registered\n", stderr: "" });
});

describe("receipt-backed MCP status", () => {
  it("inspects a synthetic unknown package without selecting a core harness branch", async () => {
    const [status] = await statusMcpBridge("alpha", "docs");

    expect(status?.agent).toBe("future-harness");
    expect(status?.support).toMatchObject({
      supported: true,
      mode: "bridge",
      adapter: "future-config",
    });
    expect(status?.adapter).toEqual({ registered: true });
    expect(mocks.inspectRuntimeIntent).toHaveBeenCalledWith("alpha", "future-config", {
      entries: [ENTRY],
      managedServerNames: ["docs"],
      credentialRevisions: new Map([["docs", "v7"]]),
    });
    expect(mocks.buildInstalledInspection).toHaveBeenCalledWith("alpha", "future-config", ENTRY, {
      credentialRevision: "v7",
      configDirectory: "/sandbox/.future",
    });
    expect(mocks.executeSandboxCommand).toHaveBeenCalledWith("alpha", "future-inspect");
    expect(mocks.legacyOpenClawInspection).not.toHaveBeenCalled();
    expect(mocks.legacyHermesInspection).not.toHaveBeenCalled();
    expect(mocks.legacyDeepAgentsInspection).not.toHaveBeenCalled();
    expect(mocks.loadAgent).not.toHaveBeenCalled();
  });

  it("verifies complete package intent while presenting one selected server", async () => {
    mocks.getSandbox.mockReturnValue({
      ...SYNTHETIC_SANDBOX,
      mcp: {
        bridges: { docs: ENTRY, search: SEARCH_ENTRY },
        managedServerNames: ["docs", "search"],
      },
    });

    const status = await statusMcpBridge("alpha", "docs");

    expect(status).toHaveLength(1);
    expect(status[0]?.server).toBe("docs");
    expect(mocks.inspectRuntimeIntent).toHaveBeenCalledWith("alpha", "future-config", {
      entries: [ENTRY, SEARCH_ENTRY],
      managedServerNames: ["docs", "search"],
      credentialRevisions: new Map([
        ["docs", "v7"],
        ["search", "v7"],
      ]),
    });
    expect(mocks.buildInstalledInspection).toHaveBeenCalledOnce();
  });
});
