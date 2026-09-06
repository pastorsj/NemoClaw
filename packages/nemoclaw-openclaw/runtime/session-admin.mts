// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SUPPORTED_METHODS = new Set(["sessions.delete", "sessions.reset"]);
const RETRYABLE_PAIRING_FAILURE = /scope upgrade pending|pairing required|device is not approved/i;
const AUTO_PAIR_HELPER = "/usr/local/lib/nemoclaw/openclaw-startup/auto-pair.py";

function findOnPath(command: string): string {
  for (const directory of (process.env.PATH || "").split(":")) {
    if (!directory) continue;
    const candidate = join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error(`Could not find ${command} on PATH`);
}

function requireCanonicalGatewayPort(value: string | undefined, label: string): string {
  if (!/^[1-9][0-9]{0,4}$/.test(value || "")) {
    throw new Error(`${label} must be a canonical TCP port in 1..65535`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535 || String(parsed) !== value) {
    throw new Error(`${label} must be a canonical TCP port in 1..65535`);
  }
  return String(parsed);
}

function requireSessionParams(
  method: string,
  serialized: string,
): Readonly<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("session admin parameters must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("session admin parameters must be a JSON object");
  }
  const params = value as Record<string, unknown>;
  const keys = Object.keys(params).sort();
  const expectedKeys =
    method === "sessions.delete" ? ["deleteTranscript", "key"] : ["key", "reason"];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`unexpected parameters for ${method}`);
  }
  if (typeof params.key !== "string" || params.key.length < 1 || params.key.length > 256) {
    throw new Error("session key must contain 1..256 characters");
  }
  if (method === "sessions.delete" && typeof params.deleteTranscript !== "boolean") {
    throw new Error("deleteTranscript must be boolean");
  }
  if (method === "sessions.reset" && params.reason !== "reset" && params.reason !== "new") {
    throw new Error("reset reason must be reset or new");
  }
  return params;
}

function runBoundedAutoPairPass(): void {
  spawnSync("/usr/bin/python3", ["-I", AUTO_PAIR_HELPER, "--once"], {
    env: {
      ...process.env,
      NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "10",
      NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS: "2",
    },
    stdio: "ignore",
    timeout: 12_000,
  });
}

const [method, paramsJson, ...extraArguments] = process.argv.slice(2);
if (!method || paramsJson === undefined || extraArguments.length > 0) {
  throw new Error("expected one session admin method and one JSON parameter object");
}
if (!SUPPORTED_METHODS.has(method)) {
  throw new Error(`unsupported session admin method: ${method}`);
}
const params = requireSessionParams(method, paramsJson);

const rawPort = process.env.OPENCLAW_GATEWAY_PORT || process.env.NEMOCLAW_DASHBOARD_PORT || "18789";
const portLabel = process.env.OPENCLAW_GATEWAY_PORT
  ? "OPENCLAW_GATEWAY_PORT"
  : process.env.NEMOCLAW_DASHBOARD_PORT
    ? "NEMOCLAW_DASHBOARD_PORT"
    : "default gateway port";
const port = requireCanonicalGatewayPort(rawPort, portLabel);
const token = process.env.OPENCLAW_GATEWAY_TOKEN;
if (!token) throw new Error("OPENCLAW_GATEWAY_TOKEN is required for session admin operations");

const openclawBinary = realpathSync(process.env.OPENCLAW_BIN || findOnPath("openclaw"));
const requireFromOpenclaw = createRequire(openclawBinary);
const gatewayRuntimePath = requireFromOpenclaw.resolve("openclaw/plugin-sdk/gateway-runtime");
const { callGatewayFromCli } = await import(pathToFileURL(gatewayRuntimePath).href);

async function callSessionAdmin(): Promise<unknown> {
  return callGatewayFromCli(
    method,
    {
      url: `ws://127.0.0.1:${port}`,
      token,
      timeout: process.env.NEMOCLAW_GATEWAY_RPC_TIMEOUT_MS || "30000",
      json: true,
    },
    params,
    {
      clientName: "gateway-client",
      mode: "backend",
      scopes: ["operator.admin"],
      progress: false,
    },
  );
}

runBoundedAutoPairPass();
let result: unknown;
try {
  result = await callSessionAdmin();
} catch (error) {
  if (!RETRYABLE_PAIRING_FAILURE.test(error instanceof Error ? error.message : String(error))) {
    throw error;
  }
  runBoundedAutoPairPass();
  result = await callSessionAdmin();
}

const output = JSON.stringify(result);
if (output === undefined) throw new Error("session admin operation returned no JSON result");
process.stdout.write(`${output}\n`);
