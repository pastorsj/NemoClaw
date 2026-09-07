// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TEST_CONFIG_ADAPTER_SOURCE,
  TEST_MESSAGING_ADAPTER_SOURCE,
  TEST_STARTUP_ADAPTER_SOURCE,
} from "../../../test/helpers/adapter-fixtures";
import { installHarnessPackage } from "./package/install";
import {
  buildHarnessProviderBrokerPlan,
  describeHarnessProviderBroker,
  inspectHarnessProviderBroker,
  runHarnessProviderBrokerController,
} from "./provider-broker";
import {
  prepareProviderBrokerCleanup,
  removePreparedProviderBroker,
} from "./provider-broker-cleanup";

const TEST_PARENT = path.join(process.cwd(), ".tmp/provider-broker-tests");
const SOURCE_IDENTITY = Object.freeze({
  kind: "bundled" as const,
  nemoclawBuildIdentity: Object.freeze({
    nemoclawVersion: "0.0.113",
    sourceRevision: "e".repeat(40),
  }),
});
let root = "";
let sourceRoot = "";
let storeRoot = "";

function write(relativePath: string, contents: string): void {
  const target = path.join(sourceRoot, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, contents, { mode: 0o600 });
}

function persistentControllerSource(): string {
  return [
    'const { spawn, spawnSync } = require("node:child_process");',
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const SCRIPT = path.join(__dirname, "future-broker.ts");',
    "const runtimeRoot = path.dirname(__dirname);",
    "const runtimeBase = path.dirname(path.dirname(runtimeRoot));",
    'const stateDirectory = path.join(runtimeBase, "test-state");',
    "const pidPath = path.join(stateDirectory, `${path.basename(runtimeRoot)}.pid`);",
    "const providerName = sandboxName => `${sandboxName}-future-tools`;",
    'const readPid = () => { try { const pid = Number.parseInt(fs.readFileSync(pidPath, "utf8"), 10); return Number.isSafeInteger(pid) && pid > 0 ? pid : null; } catch { return null; } };',
    'const processExists = pid => spawnSync("kill", ["-0", String(pid)], { stdio: "ignore" }).status === 0;',
    'const ownsProcess = pid => { const result = spawnSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" }); return result.status === 0 && result.stdout.includes(SCRIPT); };',
    'const request = JSON.parse(fs.readFileSync(0, "utf8"));',
    "let result = { ok: true, providerName: providerName(request.sandboxName) };",
    'if (request.operation === "register-refresh-provider") {',
    '  result = { ...result, credentialEnv: "FUTURE_REFRESH", credentialValue: "opaque-broker-value" };',
    '} else if (request.operation === "ensure-broker") {',
    "  const existing = readPid();",
    "  if (existing && processExists(existing) && !ownsProcess(existing)) {",
    '    result = { ok: false, message: "future broker ownership changed" };',
    "  } else if (!existing || !ownsProcess(existing)) {",
    "    fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });",
    "    if (existing) fs.unlinkSync(pidPath);",
    '    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", SCRIPT], { detached: true, stdio: "ignore" });',
    "    child.unref();",
    "    fs.writeFileSync(pidPath, `${String(child.pid)}\\n`, { mode: 0o600 });",
    "  }",
    '} else if (request.operation === "inspect-broker") {',
    "  const pid = readPid();",
    "  const ready = Boolean(pid && ownsProcess(pid));",
    "  result = { ...result, brokerReady: ready, sandboxRegistered: ready };",
    '} else if (request.operation === "teardown-broker") {',
    "  const pid = readPid();",
    "  if (pid && processExists(pid) && !ownsProcess(pid)) {",
    '    result = { ok: false, message: "future broker ownership changed" };',
    "  } else {",
    "    if (pid && ownsProcess(pid)) {",
    '      spawnSync("kill", [String(pid)], { stdio: "ignore" });',
    "      for (let attempt = 0; attempt < 20 && processExists(pid); attempt += 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);",
    "    }",
    "    if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);",
    "    result = { ...result, teardownComplete: true };",
    "  }",
    "}",
    "process.stdout.write(JSON.stringify(result));",
    "",
  ].join("\n");
}

function installFuturePackage(
  options: {
    readonly packageVersion?: string;
    readonly persistentBroker?: boolean;
  } = {},
) {
  write(
    "nemoclaw-package.json",
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "agent-runtime",
      id: "future-harness",
      displayName: "Future Harness",
      packageVersion: options.packageVersion ?? "1.0.0",
      minimumNemoClawVersion: "0.0.113",
      maximumNemoClawVersionExclusive: "0.0.121",
      manifest: "packages/nemoclaw-future/manifest.yaml",
    })}\n`,
  );
  write(
    "packages/nemoclaw-future/manifest.yaml",
    [
      "name: future-harness",
      "runtime:",
      "  kind: terminal",
      "  prompt_transport: stdin",
      "  prompt_protocol: fabric-cli",
      "  headless_command: future --prompt",
      "config:",
      "  dir: /sandbox/.future",
      "  config_file: config.json",
      "  format: json",
      "inference:",
      "  config_update:",
      "    support: unsupported",
      "    reason: fixed configuration",
      "messaging:",
      "  support: disabled",
      "policy:",
      "  owned_presets: []",
      "  automatic_presets: []",
      "  baseline_exclusion_impacts: {}",
      "provider_broker:",
      "  support: managed",
      "  adapter: provider-broker",
      "  operations: [describe-provider, register-refresh-provider, ensure-broker, inspect-broker, teardown-broker]",
      "state_lifecycle:",
      "  backup_quiescence:",
      "    kind: not-required",
      "  snapshot_restore: []",
      "  rebuild:",
      "    managed_extensions:",
      "      support: disabled",
      "      reason: Test package has no managed extensions.",
      "    scheduled_work:",
      "      support: disabled",
      "      reason: no scheduled work",
      "    post_restore:",
      "      kind: not-required",
      "",
    ].join("\n"),
  );
  write("packages/nemoclaw-future/host/config-adapter.cts", TEST_CONFIG_ADAPTER_SOURCE);
  write("packages/nemoclaw-future/host/messaging-adapter.cts", TEST_MESSAGING_ADAPTER_SOURCE);
  write("packages/nemoclaw-future/host/startup-adapter.cts", TEST_STARTUP_ADAPTER_SOURCE);
  write(
    "packages/nemoclaw-future/host/provider-broker-adapter.cts",
    `module.exports = { buildProviderBrokerPlan(request) { return { kind: "managed", providerName: request.sandboxName + "-future-tools" }; } };\n`,
  );
  write(
    "packages/nemoclaw-future/host/provider-broker-control.cts",
    options.persistentBroker
      ? persistentControllerSource()
      : [
          'let input = "";',
          'process.stdin.setEncoding("utf8");',
          'process.stdin.on("data", chunk => { input += chunk; });',
          'process.stdin.on("end", () => {',
          "  const request = JSON.parse(input);",
          "  if (process.env.NOUS_PORTAL_BASE_URL) {",
          '    process.stdout.write(JSON.stringify({ ok: false, message: "received an undeclared host input" }));',
          "    return;",
          "  }",
          '  if (request.refreshToken === "echo-secret") {',
          "    process.stdout.write(JSON.stringify({ ok: false, message: request.refreshToken }));",
          "    return;",
          "  }",
          '  if (request.refreshToken === "invalid-env") {',
          '    process.stdout.write(JSON.stringify({ ok: true, providerName: request.sandboxName + "-future-tools", credentialEnv: "bad-env", credentialValue: "value" }));',
          "    return;",
          "  }",
          '  if (request.refreshToken === "empty-value") {',
          '    process.stdout.write(JSON.stringify({ ok: true, providerName: request.sandboxName + "-future-tools", credentialEnv: "FUTURE_REFRESH", credentialValue: "" }));',
          "    return;",
          "  }",
          "  process.stdout.write(JSON.stringify({",
          "    ok: true,",
          '    providerName: request.sandboxName + "-future-tools",',
          '    ...(request.operation === "register-refresh-provider"',
          '      ? { credentialEnv: "FUTURE_REFRESH", credentialValue: "opaque-broker-value" }',
          '      : request.operation === "inspect-broker"',
          "        ? { brokerReady: true, sandboxRegistered: true }",
          '      : request.operation === "teardown-broker"',
          "          ? { teardownComplete: true }",
          "          : {}),",
          "  }));",
          "});",
          "",
        ].join("\n"),
  );
  options.persistentBroker
    ? write(
        "packages/nemoclaw-future/host/future-broker.ts",
        ['process.on("SIGTERM", () => process.exit(0));', "setInterval(() => {}, 1_000);", ""].join(
          "\n",
        ),
      )
    : undefined;
  return installHarnessPackage(
    { packageRoot: sourceRoot, sourceIdentity: SOURCE_IDENTITY },
    { storeRoot },
  );
}

beforeEach(() => {
  fs.mkdirSync(TEST_PARENT, { recursive: true, mode: 0o700 });
  root = fs.mkdtempSync(path.join(TEST_PARENT, "fixture-"));
  sourceRoot = path.join(root, "source");
  storeRoot = path.join(root, "store");
  fs.mkdirSync(storeRoot, { recursive: true, mode: 0o700 });
});

function stopFixtureBrokers(): void {
  const stateDirectory = path.join(root, "provider-broker-runtimes", "test-state");
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(stateDirectory);
  } catch {
    return;
  }
  entries
    .filter((entry) => entry.endsWith(".pid"))
    .forEach((entry) => {
      const digest = entry.slice(0, -4);
      const pid = Number.parseInt(fs.readFileSync(path.join(stateDirectory, entry), "utf8"), 10);
      const script = path.join(
        root,
        "provider-broker-runtimes",
        "sha256",
        digest,
        "host/future-broker.ts",
      );
      const processResult = spawnSync("ps", ["-p", String(pid), "-o", "args="], {
        encoding: "utf8",
      });
      processResult.status === 0 &&
        processResult.stdout.includes(script) &&
        spawnSync("kill", [String(pid)], { stdio: "ignore" });
    });
}

afterEach(() => {
  stopFixtureBrokers();
  fs.rmSync(root, { recursive: true, force: true });
});

const PROVIDER_BROKER_MODULE_URL = pathToFileURL(
  path.join(process.cwd(), "src/lib/agent-runtime/provider-broker.ts"),
).href;

function runProviderBrokerSubprocess(input: Record<string, unknown>) {
  const source = [
    `const imported = await import(${JSON.stringify(PROVIDER_BROKER_MODULE_URL)});`,
    "const { runHarnessProviderBrokerController } = imported.default ?? imported;",
    'let input = "";',
    "for await (const chunk of process.stdin) input += chunk;",
    "const payload = JSON.parse(input);",
    "const result = runHarnessProviderBrokerController(payload.identity, payload.request, { storeRoot: payload.storeRoot });",
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    encoding: "utf8",
    env: { NODE_NO_WARNINGS: "1", PATH: process.env.PATH ?? "" },
    input: JSON.stringify(input),
    timeout: 30_000,
  });
}

describe("receipt-bound provider-broker capability", () => {
  it("supports an unknown future package through all five finite operations", () => {
    const installed = installFuturePackage();
    expect(describeHarnessProviderBroker(installed.identity, "future-box", { storeRoot })).toBe(
      "future-box-future-tools",
    );
    expect(
      buildHarnessProviderBrokerPlan(
        installed.identity,
        { operation: "register-refresh-provider", sandboxName: "future-box" },
        { storeRoot },
      ),
    ).toEqual({ kind: "managed", providerName: "future-box-future-tools" });
    expect(
      runHarnessProviderBrokerController(
        installed.identity,
        {
          operation: "register-refresh-provider",
          sandboxName: "future-box",
          refreshToken: "secret-never-enters-the-adapter",
        },
        { storeRoot },
      ),
    ).toEqual({
      ok: true,
      providerName: "future-box-future-tools",
      credentialEnv: "FUTURE_REFRESH",
      credentialValue: "opaque-broker-value",
    });
    expect(
      runHarnessProviderBrokerController(
        installed.identity,
        {
          operation: "ensure-broker",
          sandboxName: "future-box",
          refreshToken: "secret-never-enters-the-adapter",
        },
        { storeRoot },
      ),
    ).toEqual({ ok: true, providerName: "future-box-future-tools" });
    expect(inspectHarnessProviderBroker(installed.identity, "future-box", { storeRoot })).toEqual({
      ok: true,
      providerName: "future-box-future-tools",
      brokerReady: true,
      sandboxRegistered: true,
    });
    expect(
      runHarnessProviderBrokerController(
        installed.identity,
        { operation: "teardown-broker", sandboxName: "future-box" },
        { storeRoot },
      ),
    ).toEqual({
      ok: true,
      providerName: "future-box-future-tools",
      teardownComplete: true,
    });
  });

  it("fails closed when the exact installed package tree changes", () => {
    const installed = installFuturePackage();
    const controller = path.join(
      storeRoot,
      "objects",
      "sha256",
      installed.identity.contentDigest,
      "packages/nemoclaw-future/host/provider-broker-control.cts",
    );
    fs.chmodSync(controller, 0o600);
    fs.appendFileSync(controller, "// changed\n");
    expect(() =>
      describeHarnessProviderBroker(installed.identity, "future-box", { storeRoot }),
    ).toThrow(/integrity|receipt|changed/u);
  });

  it("does not surface a package-controlled failure after sending a refresh credential", () => {
    const installed = installFuturePackage();

    expect(() =>
      runHarnessProviderBrokerController(
        installed.identity,
        {
          operation: "register-refresh-provider",
          sandboxName: "future-box",
          refreshToken: "echo-secret",
        },
        { storeRoot },
      ),
    ).toThrow("Provider-broker controller reported a failure");
    try {
      runHarnessProviderBrokerController(
        installed.identity,
        {
          operation: "register-refresh-provider",
          sandboxName: "future-box",
          refreshToken: "echo-secret",
        },
        { storeRoot },
      );
    } catch (error) {
      expect(error).not.toHaveProperty("message", expect.stringContaining("echo-secret"));
    }
  });

  it.each(["invalid-env", "empty-value"])(
    "rejects an invalid credential result before provider mutation (%s)",
    (refreshToken) => {
      const installed = installFuturePackage();

      expect(() =>
        runHarnessProviderBrokerController(
          installed.identity,
          { operation: "register-refresh-provider", sandboxName: "future-box", refreshToken },
          { storeRoot },
        ),
      ).toThrow("Provider-broker controller returned an invalid result");
    },
  );

  it("keeps unchanged broker bytes manageable across CLI processes and package receipts", () => {
    const installed = installFuturePackage({ persistentBroker: true });
    const ensure = runProviderBrokerSubprocess({
      identity: installed.identity,
      storeRoot,
      request: {
        operation: "ensure-broker",
        sandboxName: "future-box",
        refreshToken: "test-refresh-token",
      },
    });
    expect(ensure.status, ensure.stderr).toBe(0);
    expect(JSON.parse(ensure.stdout)).toEqual({
      ok: true,
      providerName: "future-box-future-tools",
    });

    const updated = installFuturePackage({
      packageVersion: "1.0.1",
      persistentBroker: true,
    });
    expect(updated.identity.contentDigest).not.toBe(installed.identity.contentDigest);
    expect(fs.readdirSync(path.join(root, "provider-broker-runtimes", "sha256"))).toHaveLength(1);

    const inspect = runProviderBrokerSubprocess({
      identity: updated.identity,
      storeRoot,
      request: { operation: "inspect-broker", sandboxName: "future-box" },
    });
    expect(inspect.status, inspect.stderr).toBe(0);
    expect(JSON.parse(inspect.stdout)).toEqual({
      ok: true,
      providerName: "future-box-future-tools",
      brokerReady: true,
      sandboxRegistered: true,
    });
    expect(fs.readdirSync(path.join(root, "provider-broker-runtimes", "sha256"))).toHaveLength(1);

    const teardown = runProviderBrokerSubprocess({
      identity: updated.identity,
      storeRoot,
      request: { operation: "teardown-broker", sandboxName: "future-box" },
    });
    expect(teardown.status, teardown.stderr).toBe(0);
    expect(JSON.parse(teardown.stdout)).toEqual({
      ok: true,
      providerName: "future-box-future-tools",
      teardownComplete: true,
    });
  });

  it("rejects a modified persistent host runtime instead of replacing it", () => {
    const installed = installFuturePackage();
    expect(inspectHarnessProviderBroker(installed.identity, "future-box", { storeRoot })).toEqual({
      ok: true,
      providerName: "future-box-future-tools",
      brokerReady: true,
      sandboxRegistered: true,
    });
    const controller = path.join(
      root,
      "provider-broker-runtimes",
      "sha256",
      fs.readdirSync(path.join(root, "provider-broker-runtimes", "sha256"))[0]!,
      "host/provider-broker-control.cts",
    );
    fs.chmodSync(controller, 0o600);
    fs.appendFileSync(controller, "// modified after publication\n");

    expect(() =>
      inspectHarnessProviderBroker(installed.identity, "future-box", { storeRoot }),
    ).toThrow(/does not match its exact package receipt/u);
    expect(fs.readFileSync(controller, "utf8")).toContain("modified after publication");
  });

  it("tears down an unknown receipt package from exact persisted ownership", () => {
    const installed = installFuturePackage();
    const row = {
      name: "future-box",
      harnessPackage: installed.identity,
      providerBroker: {
        schemaVersion: 1 as const,
        harnessPackage: installed.identity,
        providerName: "future-box-future-tools",
        providerType: "generic" as const,
        credentialEnv: "FUTURE_REFRESH",
      },
    };
    const commands: string[][] = [];
    const inspections = [
      { kind: "exact" as const },
      { kind: "exact" as const },
      { kind: "exact" as const },
      { kind: "missing" as const },
    ];
    const deps = {
      storeRoot,
      getSandbox: () => row,
      runOpenshell: (args: string[]) => {
        commands.push(args);
        return { status: 0, stdout: "", stderr: "" };
      },
      inspectProvider: () => inspections.shift() ?? { kind: "missing" as const },
      deleteProvider: (name: string) => {
        commands.push(["provider", "delete", name]);
        return { ok: true, status: 0, stderr: "", stdout: "", recoveryFailures: [] };
      },
      runController: () => ({
        ok: true as const,
        providerName: "future-box-future-tools",
        teardownComplete: true as const,
      }),
    };
    const prepared = prepareProviderBrokerCleanup("future-box", row, deps);
    expect(prepared).not.toBeNull();
    removePreparedProviderBroker(prepared!, deps);
    expect(commands).toEqual([
      ["sandbox", "provider", "detach", "future-box", "future-box-future-tools"],
      ["provider", "delete", "future-box-future-tools"],
    ]);
  });

  it("never derives broker cleanup from a receipt when no ownership was recorded", () => {
    const installed = installFuturePackage();
    let inspected = false;
    expect(
      prepareProviderBrokerCleanup(
        "future-box",
        { name: "future-box", harnessPackage: installed.identity },
        {
          storeRoot,
          getSandbox: () => null,
          runOpenshell: () => ({ status: 0, stdout: "", stderr: "" }),
          inspectProvider: () => {
            inspected = true;
            return { kind: "exact" };
          },
        },
      ),
    ).toBeNull();
    expect(inspected).toBe(false);
  });
});
