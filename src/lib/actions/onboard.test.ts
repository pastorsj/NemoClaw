// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listAgents: vi.fn(() => ["openclaw"]),
  onboard: vi.fn().mockResolvedValue(undefined),
  runOnboardCommand: vi.fn(),
}));

vi.mock("../agent/defs", () => ({
  listAgents: mocks.listAgents,
}));
vi.mock("../onboard", () => ({ onboard: mocks.onboard }));
vi.mock("../onboard/command", () => ({ runOnboardCommand: mocks.runOnboardCommand }));

import { runOnboardAction } from "./onboard";
import { setInstalledAgentRegistryReaderForTest } from "../onboard/command-support";

describe("onboard action runtime composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setInstalledAgentRegistryReaderForTest(() => ["openclaw"]);
    mocks.runOnboardCommand.mockImplementation(
      async (deps: { runOnboard(options: unknown): Promise<void> }) => {
        await deps.runOnboard({ nonInteractive: true, resume: false });
      },
    );
  });

  afterEach(() => {
    setInstalledAgentRegistryReaderForTest(null);
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
    const commandDeps = mocks.runOnboardCommand.mock.calls[0]?.[0] as {
      listInstalledAgents(): string[];
    };
    expect(commandDeps.listInstalledAgents()).toEqual(["openclaw"]);
  });
});
