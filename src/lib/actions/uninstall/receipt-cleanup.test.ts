// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarnessPackageFixture } from "../../../../test/helpers/harness-packages";
import type { GatewayRegistryEntry } from "../../state/gateway-registry";
import type { PreparedProviderBrokerCleanup } from "./receipt-cleanup";
import { type RunResult, runUninstallPlanProduction, type UninstallRunDeps } from "./run-plan";

const temporaryHomes: string[] = [];

function temporaryHome(): string {
  const home = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-receipt-")),
  );
  temporaryHomes.push(home);
  return home;
}

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function managedGatewayDeps(home: string): UninstallRunDeps {
  return {
    commandExists: (command) => command === "openshell",
    env: { HOME: home } as NodeJS.ProcessEnv,
    error: vi.fn(),
    existsSync: (target) => target.startsWith(home) && fs.existsSync(target),
    hasPortableRuntimeCleanup: () => false,
    isTty: false,
    log: vi.fn(),
    resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
      gatewayName,
      gatewayPort,
      mode: "nemoclaw-managed",
      source: "standalone",
      endpoint: null,
      stateDir: null,
      supervisor: null,
      requiredCapabilities: [],
    }),
    rmSync: fs.rmSync,
    run: (command, args) =>
      command === "openshell" && args[0] === "gateway" && args[1] === "list"
        ? ok(JSON.stringify([{ name: "nemoclaw" }, { name: "nemoclaw-9123" }]))
        : ok(),
    runDocker: () => ok(),
    withSandboxMutationLock: async (_sandboxName, operation) => await operation(),
  };
}

function writeRegistry(home: string, sandboxes: Record<string, GatewayRegistryEntry>): string {
  const stateDir = path.join(home, ".nemoclaw");
  fs.mkdirSync(path.join(stateDir, "gateways", "9123"), { recursive: true, mode: 0o700 });
  const registryFile = path.join(stateDir, "sandboxes.json");
  fs.writeFileSync(
    registryFile,
    `${JSON.stringify({ defaultSandbox: Object.keys(sandboxes)[0] ?? null, sandboxes })}\n`,
    { mode: 0o600 },
  );
  return registryFile;
}

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    fs.rmSync(home, { force: true, recursive: true });
  }
});

describe("receipt-backed uninstall cleanup", () => {
  it("removes a prepared broker before shared providers and its gateway registration", async () => {
    const home = temporaryHome();
    const packageFixture = createHarnessPackageFixture({
      fixtureParent: path.join(home, "package-fixtures"),
      storeRoot: path.join(home, ".nemoclaw", "harnesses"),
    });
    const installed = packageFixture.install("pi");
    const providerBroker = {
      schemaVersion: 1 as const,
      harnessPackage: installed.identity,
      providerName: "receipt-box-future-tools",
      providerType: "generic" as const,
      credentialEnv: "FUTURE_REFRESH",
    };
    const receiptRow = {
      name: "receipt-box",
      agent: "pi",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      harnessPackage: installed.identity,
      lifecycleGeneration: "generation-a",
      openshellDriver: "docker",
      providerBroker,
    } satisfies GatewayRegistryEntry;
    const registryFile = writeRegistry(home, { "receipt-box": receiptRow });
    const preparedBroker = {
      sandboxName: "receipt-box",
      ownership: providerBroker,
      providerState: { kind: "exact" as const },
    } satisfies PreparedProviderBrokerCleanup;
    const events: string[] = [];
    let gatewayAvailable = true;
    const run: NonNullable<UninstallRunDeps["run"]> = (command, args) => {
      const operation = args.join(" ");
      const availableResult = () =>
        gatewayAvailable ? ok() : { status: 1, stdout: "", stderr: "gateway unavailable" };
      const handlers: Record<string, () => RunResult> = {
        "gateway list -o json": () =>
          gatewayAvailable
            ? ok(JSON.stringify([{ name: "nemoclaw" }]))
            : { status: 1, stdout: "", stderr: "gateway unavailable" },
        "sandbox delete --all": () => {
          events.push("bulk-sandbox-delete");
          return ok();
        },
        [`provider get ${providerBroker.providerName}`]: () => {
          events.push("broker-provider-inspect");
          return availableResult();
        },
        [`provider delete ${providerBroker.providerName}`]: () => {
          events.push("broker-provider-delete");
          return availableResult();
        },
        "gateway remove nemoclaw": () => {
          events.push("gateway-remove");
          gatewayAvailable = false;
          return ok();
        },
      };
      const sharedProviderDelete = () => {
        events.push(`shared-provider-delete:${args[2] ?? ""}`);
        return availableResult();
      };
      const openshellHandler =
        handlers[operation] ??
        (operation.startsWith("provider delete ") ? sharedProviderDelete : availableResult);
      return command === "openshell" ? openshellHandler() : ok();
    };
    const removePreparedBroker: NonNullable<UninstallRunDeps["removePreparedProviderBroker"]> = (
      _prepared,
      deps,
    ) => {
      expect(deps.getSandbox("receipt-box")).toEqual(receiptRow);
      const inspected = deps.runOpenshell(["provider", "get", providerBroker.providerName]);
      expect(inspected.status, "provider inspection is unavailable").toBe(0);
      const removed = deps.runOpenshell(["provider", "delete", providerBroker.providerName]);
      expect(removed.status, "provider deletion is unavailable").toBe(0);
      events.push("broker-controller-cleanup");
    };

    const result = await runUninstallPlanProduction(
      {
        assumeYes: true,
        deleteModels: false,
        destroyUserData: true,
        keepOpenShell: true,
      },
      {
        ...managedGatewayDeps(home),
        destroySandboxForUninstall: async () => {
          events.push("receipt-sandbox-delete");
          fs.writeFileSync(
            registryFile,
            `${JSON.stringify({ defaultSandbox: null, sandboxes: {} })}\n`,
            { mode: 0o600 },
          );
          return { ok: true };
        },
        prepareProviderBrokerCleanup: () => preparedBroker,
        removePreparedProviderBroker: removePreparedBroker,
        run,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(events).toContain("shared-provider-delete:nvidia-nim");
    expect(events.indexOf("receipt-sandbox-delete")).toBeLessThan(
      events.indexOf("bulk-sandbox-delete"),
    );
    expect(events.indexOf("bulk-sandbox-delete")).toBeLessThan(
      events.indexOf("broker-provider-inspect"),
    );
    expect(events.indexOf("broker-provider-inspect")).toBeLessThan(
      events.indexOf("broker-provider-delete"),
    );
    expect(events.indexOf("broker-provider-delete")).toBeLessThan(
      events.indexOf("broker-controller-cleanup"),
    );
    expect(events.indexOf("broker-controller-cleanup")).toBeLessThan(
      events.indexOf("shared-provider-delete:nvidia-nim"),
    );
    expect(events.indexOf("shared-provider-delete:nvidia-nim")).toBeLessThan(
      events.indexOf("gateway-remove"),
    );
  });

  it("stops before pruning when the confirmed destroy transaction leaves its row present", async () => {
    const home = temporaryHome();
    const packageFixture = createHarnessPackageFixture({
      fixtureParent: path.join(home, "package-fixtures"),
      storeRoot: path.join(home, ".nemoclaw", "harnesses"),
    });
    const installed = packageFixture.install("pi");
    const receiptRow = {
      name: "receipt-box",
      agent: "pi",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      harnessPackage: installed.identity,
      lifecycleGeneration: "generation-a",
      openshellDriver: "docker",
    } satisfies GatewayRegistryEntry;
    const registryFile = writeRegistry(home, {
      "receipt-box": receiptRow,
      "sibling-box": {
        name: "sibling-box",
        gatewayName: "nemoclaw-9123",
        gatewayPort: 9123,
      },
    });
    const destroySandboxForUninstall = vi.fn(async () => ({ ok: true as const }));
    const run = vi.fn(managedGatewayDeps(home).run);
    const errors: string[] = [];

    const result = await runUninstallPlanProduction(
      {
        assumeYes: true,
        deleteModels: false,
        destroyUserData: true,
        keepOpenShell: true,
      },
      {
        ...managedGatewayDeps(home),
        destroySandboxForUninstall,
        error: (message) => errors.push(message),
        run,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(destroySandboxForUninstall).toHaveBeenCalledWith("receipt-box", receiptRow);
    expect(run.mock.calls.map(([, args]) => args)).not.toContainEqual([
      "sandbox",
      "delete",
      "-g",
      "nemoclaw",
      "receipt-box",
    ]);
    expect(JSON.parse(fs.readFileSync(registryFile, "utf8"))).toHaveProperty(
      "sandboxes.receipt-box",
    );
    expect(fs.existsSync(path.join(home, ".nemoclaw", "harnesses"))).toBe(true);
    expect(errors.join("\n")).toContain("returned without retiring its exact registry row");
  });

  it("preserves receipt authority when the confirmed destroy transaction fails", async () => {
    const home = temporaryHome();
    const packageFixture = createHarnessPackageFixture({
      fixtureParent: path.join(home, "package-fixtures"),
      storeRoot: path.join(home, ".nemoclaw", "harnesses"),
    });
    const installed = packageFixture.install("pi");
    const registryFile = writeRegistry(home, {
      "receipt-box": {
        name: "receipt-box",
        agent: "pi",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        harnessPackage: installed.identity,
        lifecycleGeneration: "generation-a",
        openshellDriver: "docker",
      },
      "sibling-box": {
        name: "sibling-box",
        gatewayName: "nemoclaw-9123",
        gatewayPort: 9123,
      },
    });
    const errors: string[] = [];

    const result = await runUninstallPlanProduction(
      {
        assumeYes: true,
        deleteModels: false,
        destroyUserData: true,
        keepOpenShell: true,
      },
      {
        ...managedGatewayDeps(home),
        destroySandboxForUninstall: async () => ({ ok: false, exitCode: 7 }),
        error: (message) => errors.push(message),
      },
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(fs.readFileSync(registryFile, "utf8"))).toHaveProperty(
      "sandboxes.receipt-box",
    );
    expect(fs.existsSync(path.join(home, ".nemoclaw", "harnesses"))).toBe(true);
    expect(errors.join("\n")).toContain("exit 7");
  });
});

describe("full uninstall cleanup confirmation", () => {
  it("preserves registry and package objects when OpenShell sandbox deletion is unreachable", async () => {
    const home = temporaryHome();
    const registryFile = writeRegistry(home, {
      "legacy-box": {
        name: "legacy-box",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
      },
    });
    const packageObject = path.join(home, ".nemoclaw", "harnesses", "objects", "keep");
    fs.mkdirSync(path.dirname(packageObject), { recursive: true, mode: 0o700 });
    fs.writeFileSync(packageObject, "package authority\n", { mode: 0o600 });
    const run = vi.fn((command: string, args: string[]) => {
      const operation = `${command} ${args.join(" ")}`;
      const results: Record<string, RunResult> = {
        "openshell gateway list -o json": ok(JSON.stringify([{ name: "nemoclaw" }])),
        "openshell sandbox delete --all": {
          status: 7,
          stdout: "",
          stderr: "gateway unavailable",
        },
      };
      return results[operation] ?? ok();
    });
    const errors: string[] = [];

    const result = await runUninstallPlanProduction(
      {
        assumeYes: true,
        deleteModels: false,
        destroyUserData: true,
        keepOpenShell: true,
      },
      {
        ...managedGatewayDeps(home),
        error: (message) => errors.push(message),
        run,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(fs.existsSync(registryFile)).toBe(true);
    expect(fs.readFileSync(packageObject, "utf8")).toBe("package authority\n");
    expect(run.mock.calls.some(([command]) => command === "npm")).toBe(false);
    expect(run.mock.calls.map(([, args]) => args)).not.toContainEqual([
      "gateway",
      "remove",
      "nemoclaw",
    ]);
    expect(errors.join("\n")).toContain("preserving NemoClaw registry and package state");
  });

  it.each([
    ["provider deletion", "provider"],
    ["gateway removal", "gateway"],
  ] as const)("preserves local authority when %s is not confirmed", async (_label, failure) => {
    const home = temporaryHome();
    const registryFile = writeRegistry(home, {
      "legacy-box": {
        name: "legacy-box",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
      },
    });
    const packageObject = path.join(home, ".nemoclaw", "harnesses", "objects", "keep");
    fs.mkdirSync(path.dirname(packageObject), { recursive: true, mode: 0o700 });
    fs.writeFileSync(packageObject, "package authority\n", { mode: 0o600 });
    const run = vi.fn((command: string, args: string[]) => {
      const operation = args.join(" ");
      const failedOperation =
        failure === "provider" ? "provider delete nvidia-nim" : "gateway remove nemoclaw";
      const failedResult =
        failure === "provider"
          ? { status: 8, stdout: "", stderr: "provider service unavailable" }
          : { status: 9, stdout: "", stderr: "gateway service unavailable" };
      const results: Record<string, RunResult> = {
        "gateway list -o json": ok(JSON.stringify([{ name: "nemoclaw" }])),
        [failedOperation]: failedResult,
      };
      return command === "openshell" ? (results[operation] ?? ok()) : ok();
    });

    const result = await runUninstallPlanProduction(
      {
        assumeYes: true,
        deleteModels: false,
        destroyUserData: true,
        keepOpenShell: true,
      },
      { ...managedGatewayDeps(home), run },
    );

    expect(result.exitCode).toBe(1);
    expect(fs.existsSync(registryFile)).toBe(true);
    expect(fs.existsSync(packageObject)).toBe(true);
    expect(run.mock.calls.some(([command]) => command === "npm")).toBe(false);
    expect(
      run.mock.calls.filter(([, args]) => args.join(" ") === "gateway remove nemoclaw"),
    ).toHaveLength(failure === "provider" ? 0 : 1);
  });
});
