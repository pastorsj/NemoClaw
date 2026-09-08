// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { HarnessProviderBrokerAdapterModule } from "@nvidia/nemoclaw-harness-contract";
import { afterEach, describe, expect, it } from "vitest";

import { loadPackageHostModule } from "../helpers/host-module";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const CONTROLLER = path.join(PACKAGE_ROOT, "host", "provider-broker-control.cts");
const TEMPORARY_ROOT = process.platform === "darwin" ? "/tmp" : os.tmpdir();
const providerBrokerAdapter = loadPackageHostModule<HarnessProviderBrokerAdapterModule>(
  "provider-broker-adapter.cts",
);
let temporaryHome: string | null = null;

function runController(request: Record<string, unknown>, timeout = 5_000) {
  return spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CONTROLLER], {
    encoding: "utf8",
    env: { HOME: temporaryHome ?? "", PATH: process.env.PATH ?? "" },
    input: JSON.stringify(request),
    timeout,
  });
}

afterEach(() => {
  if (temporaryHome) {
    try {
      const pid = Number.parseInt(
        fs.readFileSync(
          path.join(temporaryHome, ".nemoclaw", "hermes-tool-gateway-broker.pid"),
          "utf8",
        ),
        10,
      );
      if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, "SIGTERM");
    } catch {
      // The controller did not start a broker.
    }
    fs.rmSync(temporaryHome, { recursive: true, force: true });
  }
  temporaryHome = null;
});

describe("Hermes provider-broker controller", () => {
  it("builds the package-owned provider broker plan", () => {
    expect(
      providerBrokerAdapter.buildProviderBrokerPlan({
        operation: "ensure-broker",
        sandboxName: "hermes-test",
      }),
    ).toEqual({ kind: "managed", providerName: "hermes-test-hermes-tool-gateway" });
  });

  it("refuses a sandbox name outside the provider broker namespace", () => {
    expect(
      providerBrokerAdapter.buildProviderBrokerPlan({
        operation: "ensure-broker",
        sandboxName: "hermes--test",
      }),
    ).toEqual({
      kind: "unsupported",
      reason: "sandbox name is not supported by this provider broker",
    });
  });

  it("persists only refresh-token proof and returns an opaque provider binding", () => {
    temporaryHome = fs.mkdtempSync(path.join(TEMPORARY_ROOT, "hermes-provider-broker-"));
    const refreshToken = "refresh-token-must-not-be-persisted";
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", CONTROLLER],
      {
        encoding: "utf8",
        env: { HOME: temporaryHome, PATH: process.env.PATH ?? "" },
        input: JSON.stringify({
          operation: "register-refresh-provider",
          sandboxName: "hermes-test",
          refreshToken,
        }),
        timeout: 5_000,
      },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain(refreshToken);
    expect(result.stdout).not.toContain(refreshToken);
    const response = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(response).toMatchObject({
      ok: true,
      providerName: "hermes-test-hermes-tool-gateway",
      credentialEnv: "NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN",
    });
    expect(String(response.credentialValue)).toMatch(/^nc_broker_/u);

    const statePath = path.join(
      temporaryHome,
      ".nemoclaw",
      "hermes-tool-gateway",
      "hermes-test.json",
    );
    const stateText = fs.readFileSync(statePath, "utf8");
    expect(stateText).not.toContain(refreshToken);
    expect(JSON.parse(stateText)).toMatchObject({
      sandbox: "hermes-test",
      provider_name: "hermes-test-hermes-tool-gateway",
      credential_env: "NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN",
    });
    expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
  });

  it("rejects operations outside the finite controller protocol", () => {
    temporaryHome = fs.mkdtempSync(path.join(TEMPORARY_ROOT, "hermes-provider-broker-"));
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", CONTROLLER],
      {
        encoding: "utf8",
        env: { HOME: temporaryHome, PATH: process.env.PATH ?? "" },
        input: JSON.stringify({
          operation: "arbitrary-command",
          sandboxName: "hermes-test",
          refreshToken: "secret",
        }),
        timeout: 5_000,
      },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      message: "provider-broker controller rejected its request",
    });
  });

  it("starts the package-owned broker and registers its in-memory refresh credential", () => {
    temporaryHome = fs.mkdtempSync(path.join(TEMPORARY_ROOT, "hermes-provider-broker-"));
    const request = (operation: string) =>
      spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CONTROLLER], {
        encoding: "utf8",
        env: { HOME: temporaryHome ?? "", PATH: process.env.PATH ?? "" },
        input: JSON.stringify({
          operation,
          sandboxName: "hermes-test",
          refreshToken: "controller-live-refresh-token",
        }),
        timeout: 20_000,
      });

    expect(request("register-refresh-provider").status).toBe(0);
    expect(
      JSON.parse(runController({ operation: "inspect-broker", sandboxName: "hermes-test" }).stdout),
    ).toEqual({
      ok: true,
      providerName: "hermes-test-hermes-tool-gateway",
      brokerReady: false,
      sandboxRegistered: false,
    });
    const ensured = request("ensure-broker");
    expect(ensured.status).toBe(0);
    expect(JSON.parse(ensured.stdout)).toEqual({
      ok: true,
      providerName: "hermes-test-hermes-tool-gateway",
    });
    expect(
      JSON.parse(runController({ operation: "inspect-broker", sandboxName: "hermes-test" }).stdout),
    ).toEqual({
      ok: true,
      providerName: "hermes-test-hermes-tool-gateway",
      brokerReady: true,
      sandboxRegistered: true,
    });
    const tornDown = runController(
      { operation: "teardown-broker", sandboxName: "hermes-test" },
      10_000,
    );
    expect(JSON.parse(tornDown.stdout)).toEqual({
      ok: true,
      providerName: "hermes-test-hermes-tool-gateway",
      teardownComplete: true,
    });
    for (const name of [
      "hermes-tool-gateway-broker.pid",
      "hermes-tool-gateway-broker.hash",
      "hermes-tool-gateway-broker.sock",
    ]) {
      expect(fs.existsSync(path.join(temporaryHome, ".nemoclaw", name))).toBe(false);
    }
  });

  it("fails closed on malformed sandbox state", () => {
    temporaryHome = fs.mkdtempSync(path.join(TEMPORARY_ROOT, "hermes-provider-broker-"));
    const stateDir = path.join(temporaryHome, ".nemoclaw", "hermes-tool-gateway");
    fs.mkdirSync(stateDir, { recursive: true });
    const state = path.join(stateDir, "hermes-test.json");
    fs.writeFileSync(state, "not-json");
    expect(
      JSON.parse(
        runController({ operation: "teardown-broker", sandboxName: "hermes-test" }).stdout,
      ),
    ).toEqual({ ok: false, message: "provider-broker sandbox state could not be validated" });
    expect(fs.existsSync(state)).toBe(true);
  });

  it("refuses to terminate an unowned process", () => {
    temporaryHome = fs.mkdtempSync(path.join(TEMPORARY_ROOT, "hermes-provider-broker-"));
    expect(
      runController({
        operation: "register-refresh-provider",
        sandboxName: "hermes-test",
        refreshToken: "refresh",
      }).status,
    ).toBe(0);
    const pidPath = path.join(temporaryHome, ".nemoclaw", "hermes-tool-gateway-broker.pid");
    fs.writeFileSync(pidPath, `${String(process.pid)}\n`);
    const response = JSON.parse(
      runController({ operation: "teardown-broker", sandboxName: "hermes-test" }).stdout,
    );
    expect(response).toEqual({
      ok: false,
      message: "provider-broker process ownership could not be proven",
    });
    expect(fs.existsSync(pidPath)).toBe(true);
    fs.unlinkSync(pidPath);
  });

  it("removes one sandbox state while retaining a broker shared by another sandbox", () => {
    temporaryHome = fs.mkdtempSync(path.join(TEMPORARY_ROOT, "hermes-provider-broker-"));
    for (const sandboxName of ["hermes-one", "hermes-two"]) {
      expect(
        runController({
          operation: "register-refresh-provider",
          sandboxName,
          refreshToken: "refresh",
        }).status,
      ).toBe(0);
    }
    expect(
      runController(
        {
          operation: "ensure-broker",
          sandboxName: "hermes-one",
          refreshToken: "refresh",
        },
        20_000,
      ).status,
    ).toBe(0);
    const response = JSON.parse(
      runController({ operation: "teardown-broker", sandboxName: "hermes-one" }).stdout,
    );
    expect(response).toMatchObject({ ok: true, teardownComplete: true });
    const stateDir = path.join(temporaryHome, ".nemoclaw", "hermes-tool-gateway");
    expect(fs.existsSync(path.join(stateDir, "hermes-one.json"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "hermes-two.json"))).toBe(true);
  });

  it("retains shared sandbox state when the in-memory credential cannot be unregistered", () => {
    temporaryHome = fs.mkdtempSync(path.join(TEMPORARY_ROOT, "hermes-provider-broker-"));
    for (const sandboxName of ["hermes-one", "hermes-two"]) {
      expect(
        runController({
          operation: "register-refresh-provider",
          sandboxName,
          refreshToken: "refresh",
        }).status,
      ).toBe(0);
    }
    expect(
      runController(
        {
          operation: "ensure-broker",
          sandboxName: "hermes-one",
          refreshToken: "refresh",
        },
        20_000,
      ).status,
    ).toBe(0);
    const stateRoot = path.join(temporaryHome, ".nemoclaw");
    fs.unlinkSync(path.join(stateRoot, "hermes-tool-gateway-broker.sock"));

    const response = JSON.parse(
      runController({ operation: "teardown-broker", sandboxName: "hermes-one" }).stdout,
    );

    expect(response).toEqual({
      ok: false,
      message: "provider-broker shared credential teardown was not confirmed",
    });
    expect(fs.existsSync(path.join(stateRoot, "hermes-tool-gateway", "hermes-one.json"))).toBe(
      true,
    );
  });

  it.each(["missing", "malformed"])(
    "retains last-owner state when the broker PID is %s",
    (pidState) => {
      temporaryHome = fs.mkdtempSync(path.join(TEMPORARY_ROOT, "hermes-provider-broker-"));
      expect(
        runController({
          operation: "register-refresh-provider",
          sandboxName: "hermes-test",
          refreshToken: "refresh",
        }).status,
      ).toBe(0);
      expect(
        runController(
          {
            operation: "ensure-broker",
            sandboxName: "hermes-test",
            refreshToken: "refresh",
          },
          20_000,
        ).status,
      ).toBe(0);
      const stateRoot = path.join(temporaryHome, ".nemoclaw");
      const pidPath = path.join(stateRoot, "hermes-tool-gateway-broker.pid");
      const ownedPid = fs.readFileSync(pidPath, "utf8");
      if (pidState === "missing") fs.unlinkSync(pidPath);
      else fs.writeFileSync(pidPath, "not-a-pid\n");

      const response = JSON.parse(
        runController({ operation: "teardown-broker", sandboxName: "hermes-test" }).stdout,
      );

      expect(response).toEqual({
        ok: false,
        message: "provider-broker process ownership could not be proven",
      });
      expect(fs.existsSync(path.join(stateRoot, "hermes-tool-gateway", "hermes-test.json"))).toBe(
        true,
      );
      fs.writeFileSync(pidPath, ownedPid);
    },
  );
});
