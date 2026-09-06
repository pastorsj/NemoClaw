// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installHarnessPackage } from "./package/install";
import {
  buildHarnessProviderBrokerPlan,
  describeHarnessProviderBroker,
  runHarnessProviderBrokerController,
} from "./provider-broker";

const TEST_PARENT = path.join(process.cwd(), "node_modules/.cache/provider-broker-tests");
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

function installFuturePackage() {
  write(
    "nemoclaw-package.json",
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "agent-runtime",
      id: "future-harness",
      displayName: "Future Harness",
      packageVersion: "1.0.0",
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
      "provider_broker:",
      "  support: managed",
      "  adapter: provider-broker",
      "  operations: [describe-provider, register-refresh-provider, ensure-broker]",
      "state_lifecycle:",
      "  backup_quiescence:",
      "    kind: not-required",
      "  snapshot_restore: []",
      "  rebuild:",
      "    image_plugin_provenance: not-required",
      "    scheduled_work:",
      "      support: disabled",
      "      reason: no scheduled work",
      "    post_restore:",
      "      kind: not-required",
      "",
    ].join("\n"),
  );
  write(
    "packages/nemoclaw-future/host/provider-broker-adapter.cts",
    `module.exports = { buildProviderBrokerPlan(request) { return { kind: "managed", providerName: request.sandboxName + "-future-tools" }; } };\n`,
  );
  write(
    "packages/nemoclaw-future/host/provider-broker-control.cts",
    [
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", chunk => { input += chunk; });',
      'process.stdin.on("end", () => {',
      "  const request = JSON.parse(input);",
      "  process.stdout.write(JSON.stringify({",
      "    ok: true,",
      '    providerName: request.sandboxName + "-future-tools",',
      '    ...(request.operation === "register-refresh-provider"',
      '      ? { credentialEnv: "FUTURE_REFRESH", credentialValue: "opaque-broker-value" }',
      "      : {}),",
      "  }));",
      "});",
      "",
    ].join("\n"),
  );
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

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("receipt-bound provider-broker capability", () => {
  it("supports an unknown future package through all three finite operations", () => {
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
});
