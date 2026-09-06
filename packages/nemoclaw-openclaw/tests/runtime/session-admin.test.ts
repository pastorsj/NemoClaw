// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const SESSION_ADMIN_MODULE = path.join(PACKAGE_ROOT, "runtime/session-admin.mts");
const SESSION_ADMIN_WRAPPER = path.join(PACKAGE_ROOT, "runtime/session-admin.sh");
const DOCKERFILE = path.join(PACKAGE_ROOT, "Dockerfile");
const fixtureRoots: string[] = [];

function createFakeOpenClawRuntime(gatewayModuleSource: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-session-admin-"));
  fixtureRoots.push(root);
  const binaryDirectory = path.join(root, "bin");
  const packageDirectory = path.join(root, "node_modules/openclaw");
  fs.mkdirSync(binaryDirectory, { recursive: true });
  fs.mkdirSync(path.join(packageDirectory, "plugin-sdk"), { recursive: true });
  fs.writeFileSync(path.join(binaryDirectory, "openclaw"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(packageDirectory, "package.json"),
    JSON.stringify({
      name: "openclaw",
      type: "module",
      exports: { "./plugin-sdk/gateway-runtime": "./plugin-sdk/gateway-runtime.mjs" },
    }),
  );
  fs.writeFileSync(
    path.join(packageDirectory, "plugin-sdk/gateway-runtime.mjs"),
    gatewayModuleSource,
  );
  return binaryDirectory;
}

function runSessionAdmin(
  binaryDirectory: string,
  method: string,
  params: Record<string, unknown>,
  env: NodeJS.ProcessEnv = {},
) {
  return spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings",
      SESSION_ADMIN_MODULE,
      method,
      JSON.stringify(params),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
        OPENCLAW_GATEWAY_PORT: "19100",
        OPENCLAW_GATEWAY_TOKEN: "test-gateway-token",
        ...env,
      },
      timeout: 30_000,
    },
  );
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("OpenClaw session admin helper", () => {
  it("calls the package-native gateway SDK with bounded admin authority", () => {
    const binaryDirectory = createFakeOpenClawRuntime(`
export async function callGatewayFromCli(method, options, params, client) {
  return {
    ok: true,
    key: params.key,
    method,
    url: options.url,
    mode: client.mode,
    scopes: client.scopes,
  };
}
`);

    const result = runSessionAdmin(binaryDirectory, "sessions.delete", {
      key: "agent:main:slot",
      deleteTranscript: true,
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      key: "agent:main:slot",
      method: "sessions.delete",
      url: "ws://127.0.0.1:19100",
      mode: "backend",
      scopes: ["operator.admin"],
    });
  });

  it("retries one pairing transition without exposing the gateway token", () => {
    const binaryDirectory = createFakeOpenClawRuntime(`
let calls = 0;
export async function callGatewayFromCli(_method, _options, params) {
  calls += 1;
  if (calls === 1) throw new Error("pairing required");
  return { ok: true, key: params.key, calls };
}
`);

    const result = runSessionAdmin(binaryDirectory, "sessions.reset", {
      key: "agent:main:slot",
      reason: "new",
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, key: "agent:main:slot", calls: 2 });
    expect(result.stderr).not.toContain("test-gateway-token");
  });

  it("rejects unrecognized methods and unsafe ports before loading OpenClaw", () => {
    const binaryDirectory = createFakeOpenClawRuntime(
      'throw new Error("gateway runtime must not load");',
    );
    const unsupported = runSessionAdmin(binaryDirectory, "devices.approve", {
      key: "agent:main:slot",
      reason: "reset",
    });
    const unsafePort = runSessionAdmin(
      binaryDirectory,
      "sessions.reset",
      { key: "agent:main:slot", reason: "reset" },
      { OPENCLAW_GATEWAY_PORT: "19100@attacker.example" },
    );

    expect(unsupported.status).not.toBe(0);
    expect(unsupported.stderr).toContain("unsupported session admin method");
    expect(unsafePort.status).not.toBe(0);
    expect(unsafePort.stderr).toContain("must be a canonical TCP port");
    expect(`${unsupported.stderr}${unsafePort.stderr}`).not.toContain("test-gateway-token");
    expect(`${unsupported.stderr}${unsafePort.stderr}`).not.toContain(
      "gateway runtime must not load",
    );
  });

  // source-shape-contract: security -- Exact COPY modes bind the behavior-tested proxy wrapper and helper to immutable shipped image paths
  it("installs a trusted proxy wrapper and immutable helper in the OpenClaw image", () => {
    const wrapper = fs.readFileSync(SESSION_ADMIN_WRAPPER, "utf8");
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf8");
    const validateIndex = wrapper.indexOf('if [[ -L "$proxy_env" || ! -f "$proxy_env" ]]');
    const sourceIndex = wrapper.indexOf('source "$proxy_env"');
    const execIndex = wrapper.indexOf("exec /usr/local/bin/node");

    expect(validateIndex).toBeGreaterThan(-1);
    expect(sourceIndex).toBeGreaterThan(validateIndex);
    expect(execIndex).toBeGreaterThan(sourceIndex);
    expect(dockerfile).toContain(
      "COPY --chmod=0555 packages/nemoclaw-openclaw/runtime/session-admin.sh /usr/local/bin/nemoclaw-openclaw-session-admin",
    );
    expect(dockerfile).toContain(
      "COPY --chmod=0444 packages/nemoclaw-openclaw/runtime/session-admin.mts /usr/local/lib/nemoclaw/openclaw-session-admin.mts",
    );
  });
});
