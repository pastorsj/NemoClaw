// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HarnessSecondaryForwardAllocationDeclaration } from "@nvidia/nemoclaw-harness-contract";

import { getSandbox as readSandboxFromRegistry } from "../../state/registry/read";
import { isRouteOnlySandboxReservation } from "../../state/registry/route-reservation";
import {
  type DashboardPortReservation,
  findAvailablePortInRange,
  getOccupiedPorts,
  getRegistryOccupiedSecondaryForwardPorts,
  isPortBoundOnHost,
  type ListSandboxesFn,
  reserveDashboardPort,
} from "../dashboard-port";

export type SecondaryForwardAllocation = HarnessSecondaryForwardAllocationDeclaration;

export type SecondaryForwardSandboxLookup = {
  secondaryForwardPort?: number | null;
  pendingRouteReservation?: true;
  createdAt?: string;
};

export interface ReservedSecondaryForwardPort {
  readonly effectivePort: number;
  readonly reservation: DashboardPortReservation | null;
}

function isValidTcpPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function isPortInsideAllocation(port: number, allocation: SecondaryForwardAllocation): boolean {
  return port >= allocation.range_start && port <= allocation.range_end;
}

function isAddressInUse(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "EADDRINUSE";
}

/** Route-only registry rows are locks, not durable sandbox endpoint ownership. */
function durableSecondaryForwardSandbox(
  registered: SecondaryForwardSandboxLookup | null | undefined,
): SecondaryForwardSandboxLookup | null {
  if (registered == null || isRouteOnlySandboxReservation(registered)) return null;
  return registered;
}

/** Read a package-declared port override without accepting values outside its bounded range. */
export function readRequestedSecondaryForwardPort(
  allocation: SecondaryForwardAllocation,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[allocation.environment_variable];
  if (raw === undefined || raw.trim() === "") return allocation.preferred_port;
  const trimmed = raw.trim();
  const parsed = /^\d+$/u.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!isValidTcpPort(parsed) || !isPortInsideAllocation(parsed, allocation)) {
    throw new Error(
      `Invalid port: ${allocation.environment_variable} must be an integer from ${String(allocation.range_start)} through ${String(allocation.range_end)}`,
    );
  }
  return parsed;
}

/** Select one free port using only the receipt-pinned allocation declaration and host state. */
export function findAvailableSecondaryForwardPort(
  sandboxName: string,
  allocation: SecondaryForwardAllocation,
  forwardListOutput: string | null = null,
  isPortBoundCheck: (port: number) => boolean = isPortBoundOnHost,
  registryOccupiedPorts?: ReadonlyMap<string, string>,
  listSandboxesFn?: ListSandboxesFn,
): number {
  return findAvailablePortInRange(
    sandboxName,
    allocation.preferred_port,
    forwardListOutput,
    {
      start: allocation.range_start,
      end: allocation.range_end,
      label: allocation.label,
      remedy: allocation.remedy,
    },
    isPortBoundCheck,
    registryOccupiedPorts ?? getRegistryOccupiedSecondaryForwardPorts(sandboxName, listSandboxesFn),
  );
}

/**
 * Resolve a durable receipt-backed sandbox endpoint. Missing or out-of-range state fails closed;
 * the manifest default is only an allocation preference, not proof of the running endpoint.
 */
export function resolveRecordedSecondaryForwardPort(
  sandbox: SecondaryForwardSandboxLookup,
  allocation: SecondaryForwardAllocation,
): number {
  const port = sandbox.secondaryForwardPort;
  if (!isValidTcpPort(port) || !isPortInsideAllocation(port, allocation)) {
    throw new Error(
      `Recorded ${allocation.label} port is missing or outside ${String(allocation.range_start)}-${String(allocation.range_end)}. ${allocation.remedy}`,
    );
  }
  return port;
}

/** Resolve one onboarding allocation and publish it through the package-declared environment. */
export function resolveOnboardSecondaryForwardPort(
  sandboxName: string,
  allocation: SecondaryForwardAllocation,
  options: {
    env?: NodeJS.ProcessEnv;
    getSandbox?: (name: string) => SecondaryForwardSandboxLookup | null | undefined;
    allowRegisteredOverride?: boolean;
    forwardListOutput?: string | null;
    findAvailablePort?: typeof findAvailableSecondaryForwardPort;
    warn?: (message: string) => void;
  } = {},
): number {
  const env = options.env ?? process.env;
  const hasRequestedPort = Boolean(env[allocation.environment_variable]?.trim());
  const requested = readRequestedSecondaryForwardPort(allocation, env);
  const publish = (port: number): number => {
    env[allocation.environment_variable] = String(port);
    return port;
  };
  const registered = durableSecondaryForwardSandbox(
    (options.getSandbox ?? readSandboxFromRegistry)(sandboxName),
  );
  if (registered) {
    const registeredPort = resolveRecordedSecondaryForwardPort(registered, allocation);
    if (
      hasRequestedPort &&
      requested !== registeredPort &&
      options.allowRegisteredOverride !== true
    ) {
      throw new Error(
        `${allocation.environment_variable}=${String(requested)} conflicts with sandbox ${JSON.stringify(sandboxName)}, whose ${allocation.label} endpoint is port ${String(registeredPort)}. Rerun onboarding with --recreate-sandbox to apply a different port.`,
      );
    }
    return publish(hasRequestedPort ? requested : registeredPort);
  }
  if (hasRequestedPort) return publish(requested);
  const port = (options.findAvailablePort ?? findAvailableSecondaryForwardPort)(
    sandboxName,
    allocation,
    options.forwardListOutput ?? null,
  );
  if (port !== allocation.preferred_port) {
    options.warn?.(
      `  ! Port ${String(allocation.preferred_port)} is taken. Using port ${String(port)} instead.`,
    );
  }
  return publish(port);
}

/** Reserve the selected host port until the OpenShell forward takes ownership. */
export async function reserveCreateSandboxSecondaryForwardPort(options: {
  allocation: SecondaryForwardAllocation;
  sandboxName: string;
  env?: NodeJS.ProcessEnv;
  getSandbox?: (name: string) => SecondaryForwardSandboxLookup | null | undefined;
  allowRegisteredOverride?: boolean;
  forwardListOutput?: string | null;
  isPortBoundCheck?: (port: number) => boolean;
  registryOccupiedPorts?: ReadonlyMap<string, string>;
  reservePort?: (port: number) => Promise<DashboardPortReservation>;
  warn?: (message: string) => void;
}): Promise<ReservedSecondaryForwardPort> {
  const { allocation } = options;
  const env = options.env ?? process.env;
  const getSandbox = options.getSandbox ?? readSandboxFromRegistry;
  const registered = durableSecondaryForwardSandbox(getSandbox(options.sandboxName));
  const hasRequestedPort = Boolean(env[allocation.environment_variable]?.trim());
  const forwardListOutput = options.forwardListOutput ?? null;
  const forwardOwners = getOccupiedPorts(forwardListOutput);
  const reservePort = options.reservePort ?? reserveDashboardPort;
  const reserveSelectedPort = async (
    effectivePort: number,
  ): Promise<ReservedSecondaryForwardPort> =>
    forwardOwners.get(String(effectivePort)) === options.sandboxName
      ? { effectivePort, reservation: null }
      : { effectivePort, reservation: await reservePort(effectivePort) };

  if (hasRequestedPort || registered) {
    return reserveSelectedPort(
      resolveOnboardSecondaryForwardPort(options.sandboxName, allocation, {
        env,
        getSandbox,
        allowRegisteredOverride: options.allowRegisteredOverride,
        forwardListOutput,
      }),
    );
  }

  const occupied = new Map(
    options.registryOccupiedPorts ?? getRegistryOccupiedSecondaryForwardPorts(options.sandboxName),
  );
  while (true) {
    const effectivePort = findAvailableSecondaryForwardPort(
      options.sandboxName,
      allocation,
      forwardListOutput,
      options.isPortBoundCheck ?? isPortBoundOnHost,
      occupied,
    );
    try {
      const result = await reserveSelectedPort(effectivePort);
      env[allocation.environment_variable] = String(effectivePort);
      if (effectivePort !== allocation.preferred_port) {
        options.warn?.(
          `  ! Port ${String(allocation.preferred_port)} is taken. Using port ${String(effectivePort)} instead.`,
        );
      }
      return result;
    } catch (error) {
      if (!isAddressInUse(error)) throw error;
      occupied.set(String(effectivePort), "non-OpenShell host listener");
    }
  }
}
