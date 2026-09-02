// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureAgentDashboardForward,
  resolveSandboxHealthPort,
  retargetAgentHealthUrl,
} from "./agent-dashboard-forward";

describe("sandbox agent health port", () => {
  it("uses the allocated dashboard port for a dashboard-backed gateway", () => {
    expect(
      resolveSandboxHealthPort(
        "openclaw",
        {
          name: "openclaw",
          forwardPort: 18789,
          healthProbe: { port: 18789 },
        },
        { getSandbox: () => ({ dashboardPort: 18791 }) },
      ),
    ).toBe(18791);
  });

  it("uses the allocated Hermes API port for a separate API gateway", () => {
    expect(
      resolveSandboxHealthPort(
        "hermes",
        {
          name: "hermes",
          forwardPort: 18789,
          forward_ports: [18789, 8642],
          healthProbe: { port: 8642 },
        },
        { getSandbox: () => ({ dashboardPort: 18791, hermesApiPort: 8643 }) },
      ),
    ).toBe(8643);
  });

  it("keeps an unrelated declared health port", () => {
    expect(
      resolveSandboxHealthPort(
        "custom",
        {
          name: "custom",
          forwardPort: 18789,
          healthProbe: { port: 9000 },
        },
        { getSandbox: () => ({ dashboardPort: 18791 }) },
      ),
    ).toBe(9000);
  });

  it("returns undefined when the package declares no health port", () => {
    expect(
      resolveSandboxHealthPort("terminal", { name: "terminal" }, { getSandbox: () => null }),
    ).toBeUndefined();
  });

  it("retargets only a URL that names the replaced default port", () => {
    expect(retargetAgentHealthUrl("http://127.0.0.1:18789/health", 18789, 18791)).toBe(
      "http://127.0.0.1:18791/health",
    );
    expect(retargetAgentHealthUrl("http://127.0.0.1:9000/health", 18789, 18791)).toBe(
      "http://127.0.0.1:9000/health",
    );
  });
});

describe("ensureAgentDashboardForward", () => {
  afterEach(() => {
    delete process.env.CHAT_UI_URL;
  });

  it("preserves additional host-forward ports during dashboard refresh", async () => {
    const ensureDashboardForward = vi.fn((_sandboxName, chatUiUrl = "http://127.0.0.1:18789") => {
      const parsed = new URL(chatUiUrl);
      return Number(parsed.port);
    });

    expect(
      await ensureAgentDashboardForward({
        sandboxName: "hm",
        agent: {
          forwardPort: 18789,
          forward_ports: [18789, 8642],
        },
        ensureDashboardForward,
        hermesApiPort: 8642,
        preserveForwardPorts: [3978],
      }),
    ).toBe(18789);

    expect(ensureDashboardForward).toHaveBeenNthCalledWith(1, "hm", "http://127.0.0.1:18789", {
      preserveSandboxPorts: [18789, 8642, 3978],
    });
    expect(ensureDashboardForward).toHaveBeenNthCalledWith(2, "hm", "http://127.0.0.1:8642", {
      preserveSandboxPorts: [18789, 8642, 3978],
      allowPortReallocation: false,
    });
  });

  it("forwards the sandbox's per-sandbox API port instead of the manifest default (#8543)", async () => {
    const ensureDashboardForward = vi.fn((_sandboxName, chatUiUrl = "http://127.0.0.1:18789") => {
      const parsed = new URL(chatUiUrl);
      return Number(parsed.port);
    });

    expect(
      await ensureAgentDashboardForward({
        sandboxName: "hm",
        agent: {
          forwardPort: 18789,
          forward_ports: [18789, 8642],
        },
        ensureDashboardForward,
        hermesApiPort: 8643,
        preserveForwardPorts: [3978],
      }),
    ).toBe(18789);

    expect(ensureDashboardForward).toHaveBeenNthCalledWith(1, "hm", "http://127.0.0.1:18789", {
      preserveSandboxPorts: [18789, 8643, 3978],
    });
    expect(ensureDashboardForward).toHaveBeenNthCalledWith(2, "hm", "http://127.0.0.1:8643", {
      preserveSandboxPorts: [18789, 8643, 3978],
      allowPortReallocation: false,
    });
    expect(ensureDashboardForward).not.toHaveBeenCalledWith(
      "hm",
      "http://127.0.0.1:8642",
      expect.anything(),
    );
  });

  it("hands off a reserved port immediately before starting its host forward", async () => {
    const events: string[] = [];
    const ensureDashboardForward = vi.fn((_sandboxName, chatUiUrl = "") => {
      const port = Number(new URL(chatUiUrl).port);
      events.push(`forward:${port}`);
      return port;
    });

    await ensureAgentDashboardForward({
      sandboxName: "hm",
      agent: {
        forwardPort: 18789,
        forward_ports: [18789, 8642],
      },
      ensureDashboardForward,
      hermesApiPort: 8643,
      beforeForwardPort: (port) => {
        events.push(`before:${port}`);
      },
    });

    expect(events).toEqual(["before:18789", "forward:18789", "before:8643", "forward:8643"]);
  });

  it("keeps an explicit effective port and omits the replaced manifest default (#6277)", async () => {
    const ensureDashboardForward = vi.fn((_sandboxName, chatUiUrl = "") => {
      return Number(new URL(chatUiUrl).port);
    });

    expect(
      await ensureAgentDashboardForward({
        sandboxName: "hm",
        agent: {
          forwardPort: 18789,
          forward_ports: [18789, 8642],
        },
        ensureDashboardForward,
        hermesApiPort: 8642,
        controlUiPort: 9120,
        preserveForwardPorts: [3978],
      }),
    ).toBe(9120);

    expect(ensureDashboardForward).toHaveBeenNthCalledWith(1, "hm", "http://127.0.0.1:9120", {
      preserveSandboxPorts: [9120, 8642, 3978],
    });
    expect(ensureDashboardForward).toHaveBeenNthCalledWith(2, "hm", "http://127.0.0.1:8642", {
      preserveSandboxPorts: [9120, 8642, 3978],
      allowPortReallocation: false,
    });
    expect(ensureDashboardForward).not.toHaveBeenCalledWith(
      "hm",
      "http://127.0.0.1:18789",
      expect.anything(),
    );
    expect(process.env.CHAT_UI_URL).toBe("http://127.0.0.1:9120");
  });

  it("preserves a remote dashboard URL while refreshing its effective port (#6277)", async () => {
    const ensureDashboardForward = vi.fn((_sandboxName, chatUiUrl = "") => {
      return Number(new URL(chatUiUrl).port);
    });

    expect(
      await ensureAgentDashboardForward({
        sandboxName: "hm",
        agent: {
          dashboard: { kind: "ui" },
          forwardPort: 18789,
          forward_ports: [18789, 8642],
        },
        ensureDashboardForward,
        hermesApiPort: 8642,
        chatUiUrl: "https://hermes.example.test:9120/ui",
        controlUiPort: 9120,
      }),
    ).toBe(9120);

    expect(ensureDashboardForward).toHaveBeenNthCalledWith(
      1,
      "hm",
      "https://hermes.example.test:9120/ui",
      { preserveSandboxPorts: [9120, 8642] },
    );
    expect(process.env.CHAT_UI_URL).toBe("https://hermes.example.test:9120/ui");
  });

  it("forwards an API-kind agent on the sandbox-owned primary port", async () => {
    const ensureDashboardForward = vi.fn((_sandboxName, chatUiUrl = "") => {
      return Number(new URL(chatUiUrl).port);
    });

    expect(
      await ensureAgentDashboardForward({
        sandboxName: "api-agent",
        agent: {
          dashboard: { kind: "api" },
          forwardPort: 8642,
          forward_ports: [8642],
        },
        ensureDashboardForward,
        hermesApiPort: 8647,
        chatUiUrl: "http://127.0.0.1:9120",
        controlUiPort: 9120,
      }),
    ).toBe(8647);

    expect(ensureDashboardForward).toHaveBeenCalledWith("api-agent", "http://127.0.0.1:8647", {
      preserveSandboxPorts: [8647],
    });
    expect(ensureDashboardForward).not.toHaveBeenCalledWith(
      "api-agent",
      "http://127.0.0.1:8642",
      expect.anything(),
    );
    expect(process.env.CHAT_UI_URL).toBeUndefined();
  });

  it("preserves the canonical WebUI forward for an API-kind agent with an optional dashboard", async () => {
    process.env.CHAT_UI_URL = "https://hermes.example.test:9120/ui";
    const ensureDashboardForward = vi.fn((_sandboxName, chatUiUrl = "") => {
      return Number(new URL(chatUiUrl).port);
    });

    expect(
      await ensureAgentDashboardForward({
        sandboxName: "legacy-hermes",
        agent: {
          dashboard: { kind: "api" },
          dashboardUi: { port: 9119 },
          forwardPort: 8642,
          forward_ports: [8642],
        },
        ensureDashboardForward,
        hermesApiPort: 8642,
        chatUiUrl: process.env.CHAT_UI_URL,
        controlUiPort: 9120,
      }),
    ).toBe(8642);

    expect(ensureDashboardForward).toHaveBeenNthCalledWith(
      1,
      "legacy-hermes",
      "http://127.0.0.1:8642",
      { preserveSandboxPorts: [8642, 9120] },
    );
    expect(ensureDashboardForward).toHaveBeenNthCalledWith(
      2,
      "legacy-hermes",
      "https://hermes.example.test:9120/ui",
      {
        preserveSandboxPorts: [8642, 9120],
        allowPortReallocation: false,
      },
    );
    expect(process.env.CHAT_UI_URL).toBe("https://hermes.example.test:9120/ui");
  });
});
