// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDashboardUi } from "../../agent-runtime/dashboard-ui";
import type { SandboxEntry } from "../../state/registry";
import type { SandboxDashboardUiState } from "../../state/registry/dashboard-ui";

export interface PackageDashboardConfig {
  readonly enabled: boolean;
  readonly port: number;
  readonly internalPort: number;
  readonly tuiEnabled: boolean;
}

/** Shared state shape passed through sandbox creation and managed startup. */
export interface DashboardUiOnboardState {
  readonly enabled: boolean;
  readonly config: PackageDashboardConfig | null;
  readonly packageOwned?: true;
  readonly declaration?: AgentDashboardUi | null;
}

/** One resolved package declaration; the package ID never affects the result. */
export interface PackageDashboardState extends DashboardUiOnboardState {
  readonly packageOwned: true;
  readonly declaration: AgentDashboardUi | null;
  readonly enabled: boolean;
  readonly config: PackageDashboardConfig | null;
}

export interface PackageDashboardReservedPorts {
  readonly start: number;
  readonly end: number;
  readonly label: string;
}

type RevalidateSandboxIdentity = (operation: string) => void;
type EnsureForward = (
  sandboxName: string,
  port: number,
  label: string,
  revalidateSandboxIdentity?: RevalidateSandboxIdentity,
) => boolean;

function isDashboardPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65_535;
}

function environmentFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseDashboardPort(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const normalized = raw.trim();
  if (!/^\d+$/u.test(normalized) || !isDashboardPort(Number(normalized))) {
    throw new Error(`Invalid port: ${name}="${raw}" must be an integer between 1024 and 65535`);
  }
  return Number(normalized);
}

function failDashboardResolution(
  message: string,
  fail: ((message: string) => never) | undefined,
): never {
  if (fail) return fail(message);
  throw new Error(message);
}

function rejectReservedDashboardPort(
  port: number | undefined,
  reserved: PackageDashboardReservedPorts | null | undefined,
  fail: ((message: string) => never) | undefined,
): void {
  if (port === undefined || !reserved || port < reserved.start || port > reserved.end) return;
  failDashboardResolution(
    `[SECURITY] Invalid dashboard port ${String(port)} - reserved for ${reserved.label}`,
    fail,
  );
}

/** Resolve optional UI intent entirely from a receipt-pinned package declaration. */
export function resolvePackageDashboardState(input: {
  readonly dashboardUi: AgentDashboardUi | null;
  readonly effectivePort: number;
  readonly environment: NodeJS.ProcessEnv;
  readonly reservedPorts?: PackageDashboardReservedPorts | null;
  readonly fail?: (message: string) => never;
}): PackageDashboardState {
  const { dashboardUi, effectivePort, environment, reservedPorts, fail } = input;
  const rawPrimaryPort = environment.NEMOCLAW_DASHBOARD_PORT?.trim();
  rejectReservedDashboardPort(
    rawPrimaryPort && /^\d+$/u.test(rawPrimaryPort) ? Number(rawPrimaryPort) : undefined,
    reservedPorts,
    fail,
  );
  rejectReservedDashboardPort(effectivePort, reservedPorts, fail);
  if (!dashboardUi) {
    return { packageOwned: true, declaration: null, enabled: false, config: null };
  }

  let configuredPublicPort: number;
  let internalPort: number;
  try {
    configuredPublicPort = parseDashboardPort(environment, dashboardUi.portEnv, dashboardUi.port);
    internalPort = parseDashboardPort(
      environment,
      dashboardUi.internalPortEnv,
      dashboardUi.internalPort,
    );
  } catch (error) {
    return failDashboardResolution(error instanceof Error ? error.message : String(error), fail);
  }
  const enabled = environmentFlag(environment[dashboardUi.enableEnv]);
  if (!enabled) {
    return { packageOwned: true, declaration: dashboardUi, enabled: false, config: null };
  }
  if (!isDashboardPort(effectivePort)) {
    return failDashboardResolution("The allocated package dashboard port is invalid.", fail);
  }
  if (environment[dashboardUi.portEnv]?.trim() && configuredPublicPort !== effectivePort) {
    return failDashboardResolution(
      `${dashboardUi.portEnv} must match the NemoClaw dashboard port (${String(effectivePort)}). Set NEMOCLAW_DASHBOARD_PORT or pass --control-ui-port <N> to change the package dashboard port.`,
      fail,
    );
  }
  if (internalPort === effectivePort) {
    return failDashboardResolution(
      `${dashboardUi.internalPortEnv} must not equal the package dashboard port (${String(effectivePort)}).`,
      fail,
    );
  }
  return {
    packageOwned: true,
    declaration: dashboardUi,
    enabled: true,
    config: {
      enabled: true,
      port: effectivePort,
      internalPort,
      tuiEnabled: dashboardUi.tuiEnv ? environmentFlag(environment[dashboardUi.tuiEnv]) : false,
    },
  };
}

export function getPackageDashboardRegistryFields(
  state: DashboardUiOnboardState,
): Pick<SandboxEntry, "dashboardUi"> {
  if (state.packageOwned !== true) {
    throw new Error("Package dashboard state requires receipt-backed package authority.");
  }
  if (!state.declaration) return { dashboardUi: undefined };
  if (!state.enabled || !state.config) return { dashboardUi: { enabled: false } };
  return {
    dashboardUi: {
      enabled: true,
      publicPort: state.config.port,
      internalPort: state.config.internalPort,
      tuiEnabled: state.config.tuiEnabled,
    },
  };
}

export function hasPackageDashboardDrift(input: {
  readonly existing: Pick<SandboxEntry, "dashboardUi"> | null | undefined;
  readonly state: DashboardUiOnboardState;
}): boolean {
  const expected = getPackageDashboardRegistryFields(input.state).dashboardUi;
  const recorded = input.existing?.dashboardUi;
  if (expected === undefined) return recorded !== undefined;
  if (recorded?.enabled !== expected.enabled) return true;
  if (!expected.enabled || !recorded.enabled) return false;
  return (
    recorded.publicPort !== expected.publicPort ||
    recorded.internalPort !== expected.internalPort ||
    recorded.tuiEnabled !== expected.tuiEnabled
  );
}

export function appendPackageDashboardEnvArgs(
  envArgs: string[],
  state: DashboardUiOnboardState,
  formatEnvironmentAssignment: (name: string, value: string) => string,
): void {
  const declaration = state.declaration;
  if (!declaration) return;
  envArgs.push(
    formatEnvironmentAssignment(declaration.enableEnv, state.enabled && state.config ? "1" : "0"),
  );
  if (!state.enabled || !state.config) return;
  envArgs.push(formatEnvironmentAssignment(declaration.portEnv, String(state.config.port)));
  envArgs.push(
    formatEnvironmentAssignment(declaration.internalPortEnv, String(state.config.internalPort)),
  );
  if (declaration.tuiEnv) {
    envArgs.push(
      formatEnvironmentAssignment(declaration.tuiEnv, state.config.tuiEnabled ? "1" : "0"),
    );
  }
}

export function ensurePackageDashboardForward(input: {
  readonly state: DashboardUiOnboardState;
  readonly sandboxName: string;
  readonly ensureForward: EnsureForward;
  readonly note: (message: string) => void;
  readonly revalidateSandboxIdentity?: RevalidateSandboxIdentity;
}): boolean {
  const { state, sandboxName, ensureForward, note, revalidateSandboxIdentity } = input;
  if (state.packageOwned !== true) {
    throw new Error("Package dashboard forwarding requires receipt-backed package authority.");
  }
  if (!state.enabled || !state.config || !state.declaration) return true;
  const label = state.declaration.label;
  if (!ensureForward(sandboxName, state.config.port, label, revalidateSandboxIdentity)) {
    return false;
  }
  revalidateSandboxIdentity?.(`report ${label} forward for sandbox '${sandboxName}'`);
  note(
    `  ✓ ${label} forwarded at http://127.0.0.1:${String(state.config.port)}${state.declaration.path}`,
  );
  return true;
}

export function formatPackageDashboardForwardFailure(state: DashboardUiOnboardState): string {
  const port = state.config?.port ?? "unknown";
  const label = state.declaration?.label ?? "Package dashboard";
  return `Failed to start ${label} forward on port ${String(port)}. NemoClaw left the sandbox and any established OpenShell service forwards running. Free the port and re-run onboarding, set NEMOCLAW_DASHBOARD_PORT, or pass --control-ui-port <N> to choose another port.`;
}

/** Compose package-declared dashboard resolution and forwarding without package callbacks. */
export function createPackageDashboardOnboardForwarding(input: {
  readonly dashboardUi: AgentDashboardUi | null;
  readonly reservedPorts?: PackageDashboardReservedPorts | null;
  readonly environment: NodeJS.ProcessEnv;
  readonly ensureForward: EnsureForward;
  readonly note: (message: string) => void;
  readonly fail?: (message: string) => never;
}) {
  const fail =
    input.fail ??
    ((message: string): never => {
      console.error(`  ${message}`);
      process.exit(1);
    });
  const resolveStateForPort = (effectivePort: number): PackageDashboardState =>
    resolvePackageDashboardState({
      dashboardUi: input.dashboardUi,
      effectivePort,
      environment: input.environment,
      reservedPorts: input.reservedPorts,
      fail,
    });
  const ensureForState = (
    state: DashboardUiOnboardState,
    sandboxName: string,
    _rollback = false,
    revalidateSandboxIdentity?: RevalidateSandboxIdentity,
  ): void => {
    if (state.packageOwned !== true) {
      fail("Package dashboard forwarding requires receipt-backed package authority.");
    }
    if (
      ensurePackageDashboardForward({
        state,
        sandboxName,
        ensureForward: input.ensureForward,
        note: input.note,
        revalidateSandboxIdentity,
      })
    ) {
      return;
    }
    fail(formatPackageDashboardForwardFailure(state));
  };
  return { resolveStateForPort, ensureForState };
}

export function packageDashboardStateFromRegistry(input: {
  readonly declaration: AgentDashboardUi | null;
  readonly state: SandboxDashboardUiState | undefined;
}): PackageDashboardState {
  if (!input.declaration) {
    if (input.state !== undefined) {
      throw new Error("Sandbox records package dashboard state without a package declaration.");
    }
    return { packageOwned: true, declaration: null, enabled: false, config: null };
  }
  if (!input.state || !input.state.enabled) {
    return {
      packageOwned: true,
      declaration: input.declaration,
      enabled: false,
      config: null,
    };
  }
  return {
    packageOwned: true,
    declaration: input.declaration,
    enabled: true,
    config: {
      enabled: true,
      port: input.state.publicPort,
      internalPort: input.state.internalPort,
      tuiEnabled: input.state.tuiEnabled,
    },
  };
}

/** Give a snapshot clone its own public forward while retaining package-native settings. */
export function rebindPackageDashboardPort(
  state: PackageDashboardState,
  publicPort: number,
): PackageDashboardState {
  if (!state.enabled || !state.config) return state;
  if (!isDashboardPort(publicPort) || publicPort === state.config.internalPort) {
    throw new Error("Cannot rebind package dashboard state to an invalid public port.");
  }
  return {
    ...state,
    config: { ...state.config, port: publicPort },
  };
}
