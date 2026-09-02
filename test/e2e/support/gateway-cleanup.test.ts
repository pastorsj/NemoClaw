// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  cleanupIsolatedGateway,
  type IsolatedGatewayCleanupOptions,
} from "../fixtures/gateway-cleanup.ts";
import type { ShellProbeResult, ShellProbeRunOptions } from "../fixtures/shell-probe.ts";

const GATEWAY_PORT = 18_133;
const GATEWAY_NAME = `nemoclaw-${String(GATEWAY_PORT)}`;
const testHomes: string[] = [];

type GatewayCleanupHost = Pick<HostCliClient, "cleanupGatewayRegistration" | "command">;

function privateTestHome(): string {
  const parentHome = fs.realpathSync(os.homedir());
  const home = fs.mkdtempSync(path.join(parentHome, ".nemoclaw-gateway-cleanup-home-"));
  fs.chmodSync(home, 0o700);
  testHomes.push(home);
  return home;
}

function probeResult(exitCode = 0, stderr = "", stdout = ""): ShellProbeResult {
  return {
    artifacts: { result: "", stderr: "", stdout: "" },
    command: ["node"],
    durationMs: 1,
    exitCode,
    signal: null,
    stderr,
    stdout,
    timedOut: false,
  };
}

function cleanupOptions(home: string): IsolatedGatewayCleanupOptions {
  return {
    artifactName: "isolated-gateway-cleanup",
    environment: {
      HOME: home,
      NEMOCLAW_GATEWAY_PORT: String(GATEWAY_PORT),
      OPENSHELL_GATEWAY: GATEWAY_NAME,
    },
    gatewayName: GATEWAY_NAME,
    gatewayPort: GATEWAY_PORT,
    home,
    portReleaseTimeoutMs: 1_000,
    redactionValues: ["cleanup-secret"],
    timeoutMs: 2_000,
  };
}

function fakeHost(results: ShellProbeResult[]): {
  command: ReturnType<typeof vi.fn>;
  cleanupRegistration: ReturnType<typeof vi.fn>;
  host: GatewayCleanupHost;
} {
  const command = vi.fn(
    async (_command: string, _args: string[], _options: ShellProbeRunOptions) =>
      results.shift() ?? probeResult(),
  );
  const cleanupRegistration = vi.fn(
    async (_name: string, _options?: ShellProbeRunOptions) => undefined,
  );
  return {
    command,
    cleanupRegistration,
    host: {
      command,
      cleanupGatewayRegistration: cleanupRegistration,
    },
  };
}

afterEach(() => {
  for (const home of testHomes.splice(0)) {
    fs.rmSync(home, { force: true, recursive: true });
  }
});

describe("isolated gateway cleanup", () => {
  it("stops the owned runtime, proves the exact port is free, then removes registration and HOME", async () => {
    const home = privateTestHome();
    const calls: string[] = [];
    const command = vi.fn(
      async (_command: string, args: string[], options: ShellProbeRunOptions) => {
        calls.push(args.includes(String(GATEWAY_PORT)) ? "port" : "runtime");
        expect(options.env).toEqual(cleanupOptions(home).environment);
        return probeResult();
      },
    );
    const cleanupRegistration = vi.fn(async () => {
      calls.push("registration");
    });
    const host: GatewayCleanupHost = {
      command,
      cleanupGatewayRegistration: cleanupRegistration,
    };

    await cleanupIsolatedGateway(host, cleanupOptions(home));

    expect(calls).toEqual(["runtime", "port", "registration"]);
    expect(cleanupRegistration).toHaveBeenCalledWith(
      GATEWAY_NAME,
      expect.objectContaining({
        artifactName: "isolated-gateway-cleanup-registration",
        env: cleanupOptions(home).environment,
      }),
    );
    expect(fs.existsSync(home)).toBe(false);
  });

  it("preserves registration and HOME when owned runtime cleanup fails", async () => {
    const home = privateTestHome();
    const { cleanupRegistration, command, host } = fakeHost([
      probeResult(1, "ownership could not be proven"),
    ]);

    await expect(cleanupIsolatedGateway(host, cleanupOptions(home))).rejects.toThrow(
      "gateway registration and private HOME",
    );

    expect(command).toHaveBeenCalledTimes(1);
    expect(cleanupRegistration).not.toHaveBeenCalled();
    expect(fs.existsSync(home)).toBe(true);
  });

  it("preserves registration and HOME when the exact port remains occupied", async () => {
    const home = privateTestHome();
    const { cleanupRegistration, command, host } = fakeHost([
      probeResult(),
      probeResult(1, "EADDRINUSE"),
    ]);

    await expect(cleanupIsolatedGateway(host, cleanupOptions(home))).rejects.toThrow(
      `Gateway port ${String(GATEWAY_PORT)} release proof failed`,
    );

    expect(command).toHaveBeenCalledTimes(2);
    expect(cleanupRegistration).not.toHaveBeenCalled();
    expect(fs.existsSync(home)).toBe(true);
  });

  it("preserves HOME when registration removal fails after port release", async () => {
    const home = privateTestHome();
    const { cleanupRegistration, host } = fakeHost([probeResult(), probeResult()]);
    cleanupRegistration.mockRejectedValueOnce(new Error("registration is busy"));

    await expect(cleanupIsolatedGateway(host, cleanupOptions(home))).rejects.toThrow(
      "private HOME",
    );

    expect(cleanupRegistration).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(home)).toBe(true);
  });

  it.each([
    {
      label: "default gateway",
      mutate: (options: IsolatedGatewayCleanupOptions) => ({
        ...options,
        environment: {
          ...options.environment,
          NEMOCLAW_GATEWAY_PORT: "8080",
          OPENSHELL_GATEWAY: "nemoclaw",
        },
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
      }),
    },
    {
      label: "noncanonical gateway name",
      mutate: (options: IsolatedGatewayCleanupOptions) => ({
        ...options,
        environment: { ...options.environment, OPENSHELL_GATEWAY: "test-gateway" },
        gatewayName: "test-gateway",
      }),
    },
  ])("rejects a $label before running any cleanup command", async ({ mutate }) => {
    const home = privateTestHome();
    const { cleanupRegistration, command, host } = fakeHost([]);

    await expect(cleanupIsolatedGateway(host, mutate(cleanupOptions(home)))).rejects.toThrow(
      /non-default port|canonical gateway/u,
    );

    expect(command).not.toHaveBeenCalled();
    expect(cleanupRegistration).not.toHaveBeenCalled();
    expect(fs.existsSync(home)).toBe(true);
  });

  it("rejects an ordinary absolute HOME before running any cleanup command", async () => {
    const unsafeHome = fs.mkdtempSync(path.join(fs.realpathSync(os.homedir()), "ordinary-home-"));
    testHomes.push(unsafeHome);
    const { cleanupRegistration, command, host } = fakeHost([]);

    await expect(
      cleanupIsolatedGateway(host, {
        ...cleanupOptions(unsafeHome),
        environment: {
          HOME: unsafeHome,
          NEMOCLAW_GATEWAY_PORT: String(GATEWAY_PORT),
          OPENSHELL_GATEWAY: GATEWAY_NAME,
        },
      }),
    ).rejects.toThrow("private .nemoclaw-*-home-* directory");

    expect(command).not.toHaveBeenCalled();
    expect(cleanupRegistration).not.toHaveBeenCalled();
    expect(fs.existsSync(unsafeHome)).toBe(true);
  });
});
