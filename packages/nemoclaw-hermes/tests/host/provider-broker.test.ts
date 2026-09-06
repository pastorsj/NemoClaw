// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const CONTROLLER = path.join(PACKAGE_ROOT, "host", "provider-broker-control.cts");
const TEMPORARY_ROOT = process.platform === "darwin" ? "/tmp" : os.tmpdir();
let temporaryHome: string | null = null;

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
    const ensured = request("ensure-broker");
    expect(ensured.status).toBe(0);
    expect(JSON.parse(ensured.stdout)).toEqual({
      ok: true,
      providerName: "hermes-test-hermes-tool-gateway",
    });
  });
});
