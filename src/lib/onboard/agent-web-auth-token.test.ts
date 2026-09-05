// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { loadAgent } from "../agent/defs";
import { fetchAgentDashboardTokenFromSandbox } from "./agent-web-auth-token";

describe("fetchAgentDashboardTokenFromSandbox", () => {
  it("reads a token from the manifest-declared package config path", () => {
    const agent = loadAgent("openclaw");
    const readConfig = vi.fn(() => ({ custom: { browser: { secret: "package-token" } } }));
    const token = fetchAgentDashboardTokenFromSandbox(readConfig, "alpha", {
      ...agent,
      name: "synthetic-harness",
      dashboard: {
        ...agent.dashboard,
        auth: "url_token",
        tokenPath: ["custom", "browser", "secret"],
      },
    });

    expect(token).toBe("package-token");
    expect(readConfig).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        agentName: "synthetic-harness",
        configPath: "/sandbox/.openclaw/openclaw.json",
        format: "json",
      }),
    );
  });

  it("does not read config when the package does not declare URL-token auth", () => {
    const agent = loadAgent("hermes");
    const readConfig = vi.fn();
    expect(fetchAgentDashboardTokenFromSandbox(readConfig, "alpha", agent)).toBeNull();
    expect(readConfig).not.toHaveBeenCalled();
  });
});
