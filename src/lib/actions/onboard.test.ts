// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listAgents: vi.fn(() => ["openclaw"]),
  onboard: vi.fn().mockResolvedValue(undefined),
  readSelectableAgentRegistryEntries: vi.fn(() => [
    {
      name: "future-harness",
      displayName: "Future Harness",
      aliases: ["future"],
      aliasSummary: null,
      isDefaultOnboardingChoice: false,
      defaultSandboxName: "future-sandbox",
    },
  ]),
  runOnboardCommand: vi.fn(),
}));

vi.mock("../agent/defs", () => ({ listAgents: mocks.listAgents }));
vi.mock("../onboard", () => ({ onboard: mocks.onboard }));
vi.mock("../onboard/command", () => ({ runOnboardCommand: mocks.runOnboardCommand }));
vi.mock("../onboard/command-support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../onboard/command-support")>()),
  readSelectableAgentRegistryEntries: mocks.readSelectableAgentRegistryEntries,
}));

import { runOnboardAction } from "./onboard";

describe("onboard action runtime composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runOnboardCommand.mockImplementation(
      async (deps: { runOnboard(options: unknown): Promise<void> }) => {
        await deps.runOnboard({ nonInteractive: true, resume: false });
      },
    );
  });

  it("passes host-only Google Chat dependencies into legacy onboarding", async () => {
    const googlechatTunnelRuntime = {
      loadServices: vi.fn(),
      loadWebhookProxy: vi.fn(),
    };

    await runOnboardAction({ "non-interactive": true }, { googlechatTunnelRuntime });

    expect(mocks.onboard).toHaveBeenCalledWith({
      nonInteractive: true,
      resume: false,
      googlechatTunnelRuntime,
    });
  });

  it("validates onboarding selectors against installed-only package metadata", async () => {
    mocks.runOnboardCommand.mockImplementation(
      async (deps: {
        listAgents(): readonly string[];
        listAgentAliasTargets(): readonly { readonly name: string }[];
      }) => {
        expect(deps.listAgents()).toEqual(["future-harness"]);
        expect(deps.listAgentAliasTargets().map(({ name }) => name)).toEqual(["future-harness"]);
      },
    );

    await runOnboardAction({ agent: "future" });

    expect(mocks.readSelectableAgentRegistryEntries).toHaveBeenCalledOnce();
  });
});
