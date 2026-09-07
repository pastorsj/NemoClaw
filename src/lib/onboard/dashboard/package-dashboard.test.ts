// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";

import { readDashboardUi } from "../../agent-runtime/dashboard-ui";
import { resolveHermesDashboardOnboardState } from "../hermes-dashboard";
import {
  appendPackageDashboardEnvArgs,
  createPackageDashboardOnboardForwarding,
  getPackageDashboardRegistryFields,
  hasPackageDashboardDrift,
  packageDashboardStateFromRegistry,
  resolvePackageDashboardState,
} from "./package-dashboard";

const futureDashboard = {
  label: "Future console",
  path: "/console",
  port: 9_120,
  enableEnv: "FUTURE_CONSOLE_ENABLED",
  portEnv: "FUTURE_CONSOLE_PORT",
  internalPort: 19_120,
  internalPortEnv: "FUTURE_CONSOLE_INTERNAL_PORT",
  tuiEnv: "FUTURE_CONSOLE_TUI",
} as const;

function loadHermesPackageDashboardUi() {
  const packageRoot = path.resolve(import.meta.dirname, "../../../../packages/nemoclaw-hermes");
  const manifestPath = path.join(packageRoot, "manifest.yaml");
  return readDashboardUi(parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>);
}

describe("receipt-backed package dashboard", () => {
  it("resolves, projects, forwards, and detects drift for an unknown package", () => {
    const state = resolvePackageDashboardState({
      dashboardUi: futureDashboard,
      effectivePort: 9_121,
      environment: {
        FUTURE_CONSOLE_ENABLED: "yes",
        FUTURE_CONSOLE_INTERNAL_PORT: "19121",
        FUTURE_CONSOLE_TUI: "on",
      },
    });
    expect(state).toMatchObject({
      packageOwned: true,
      enabled: true,
      config: { port: 9_121, internalPort: 19_121, tuiEnabled: true },
    });
    expect(getPackageDashboardRegistryFields(state)).toEqual({
      dashboardUi: {
        enabled: true,
        publicPort: 9_121,
        internalPort: 19_121,
        tuiEnabled: true,
      },
    });
    expect(
      hasPackageDashboardDrift({
        state,
        existing: {
          dashboardUi: {
            enabled: true,
            publicPort: 9_121,
            internalPort: 19_121,
            tuiEnabled: false,
          },
        },
      }),
    ).toBe(true);

    const envArgs: string[] = [];
    appendPackageDashboardEnvArgs(envArgs, state, (name, value) => `${name}=${value}`);
    expect(envArgs).toEqual([
      "FUTURE_CONSOLE_ENABLED=1",
      "FUTURE_CONSOLE_PORT=9121",
      "FUTURE_CONSOLE_INTERNAL_PORT=19121",
      "FUTURE_CONSOLE_TUI=1",
    ]);

    const ensureForward = vi.fn(() => true);
    const note = vi.fn();
    const revalidate = vi.fn();
    const forwarding = createPackageDashboardOnboardForwarding({
      dashboardUi: futureDashboard,
      environment: { FUTURE_CONSOLE_ENABLED: "1" },
      ensureForward,
      note,
      fail: (message): never => {
        throw new Error(message);
      },
    });
    forwarding.ensureForState(forwarding.resolveStateForPort(9_120), "future", false, revalidate);
    expect(ensureForward).toHaveBeenCalledWith("future", 9_120, "Future console", revalidate);
    expect(note).toHaveBeenCalledWith(
      "  ✓ Future console forwarded at http://127.0.0.1:9120/console",
    );
  });

  it("matches the existing Hermes environment behavior from its package declaration", () => {
    const hermesDashboardUi = loadHermesPackageDashboardUi();
    const environment = {
      NEMOCLAW_HERMES_DASHBOARD: "1",
      NEMOCLAW_HERMES_DASHBOARD_PORT: "18790",
      NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT: "19120",
      NEMOCLAW_HERMES_DASHBOARD_TUI: "true",
    };
    const legacy = resolveHermesDashboardOnboardState({
      agentName: "hermes",
      effectivePort: 18_790,
      env: environment,
    });
    const resolved = resolvePackageDashboardState({
      dashboardUi: hermesDashboardUi,
      effectivePort: 18_790,
      environment,
    });
    expect(resolved.config).toEqual(legacy.config);
  });

  it("projects an explicit disabled setting without opening a forward", () => {
    const state = resolvePackageDashboardState({
      dashboardUi: futureDashboard,
      effectivePort: 9_120,
      environment: {},
    });
    expect(getPackageDashboardRegistryFields(state)).toEqual({
      dashboardUi: { enabled: false },
    });

    const envArgs: string[] = [];
    appendPackageDashboardEnvArgs(envArgs, state, (name, value) => `${name}=${value}`);
    expect(envArgs).toEqual(["FUTURE_CONSOLE_ENABLED=0"]);

    const ensureForward = vi.fn(() => true);
    expect(
      createPackageDashboardOnboardForwarding({
        dashboardUi: futureDashboard,
        environment: {},
        ensureForward,
        note: vi.fn(),
      }).ensureForState(state, "future"),
    ).toBeUndefined();
    expect(ensureForward).not.toHaveBeenCalled();
  });

  it("fails closed for invalid ports, allocation conflicts, and mismatched persisted capability", () => {
    expect(() =>
      resolvePackageDashboardState({
        dashboardUi: futureDashboard,
        effectivePort: 9_120,
        environment: {
          FUTURE_CONSOLE_ENABLED: "1",
          FUTURE_CONSOLE_INTERNAL_PORT: "oops",
        },
      }),
    ).toThrow(/FUTURE_CONSOLE_INTERNAL_PORT/u);
    expect(() =>
      resolvePackageDashboardState({
        dashboardUi: futureDashboard,
        effectivePort: 9_120,
        environment: { FUTURE_CONSOLE_ENABLED: "1" },
        reservedPorts: { start: 9_120, end: 9_130, label: "future API" },
      }),
    ).toThrow(/reserved for future API/u);
    expect(() =>
      packageDashboardStateFromRegistry({
        declaration: null,
        state: { enabled: false },
      }),
    ).toThrow(/without a package declaration/u);
  });
});
