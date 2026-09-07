// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TEST_CONFIG_ADAPTER_SOURCE,
  TEST_MESSAGING_ADAPTER_SOURCE,
  TEST_STARTUP_ADAPTER_SOURCE,
} from "../../../test/helpers/adapter-fixtures";
import { installHarnessPackage } from "./package/install";
import {
  HarnessProviderAuthError,
  isHarnessManagedProvider,
  resolveHarnessProviderAuthCapability,
  resolveHarnessProviderAuthMethod,
  resolveHarnessProviderSelection,
} from "./provider-auth";

const TEST_PARENT = path.join(process.cwd(), "node_modules/.cache/provider-auth-tests");
const SOURCE_IDENTITY = Object.freeze({
  kind: "bundled" as const,
  nemoclawBuildIdentity: Object.freeze({
    nemoclawVersion: "0.0.113",
    sourceRevision: "f".repeat(40),
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

function installFuturePackage(methodId = "api-key") {
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
      "policy:",
      "  owned_presets: []",
      "  automatic_presets: []",
      "  baseline_exclusion_impacts: {}",
      "provider_auth:",
      "  support: managed",
      "  adapter: provider-auth",
      "  operation: resolve-auth-method",
      "  request_environment: [NEMOCLAW_FUTURE_AUTH_METHOD]",
      "  default_method: browser-login",
      "  selection:",
      "    key: futureProvider",
      "    aliases: [future]",
      "    label: Future Provider",
      "    provider_name: future-provider",
      "    provider_type: openai",
      "    endpoint_url: https://inference.example.com/v1",
      "    help_url: https://example.com/keys",
      "    default_model: future/default",
      "    models: [future/default, future/large]",
      "    preferred_inference_api: openai-completions",
      "  methods:",
      "    - id: browser-login",
      "      label: Browser login",
      "      kind: oauth-device-code",
      "      credential_env: FUTURE_TOKEN",
      "      device_code:",
      "        portal_base_url: https://login.example.com",
      "        client_id: future-cli",
      "        scope: inference",
      "        minimum_credential_ttl_seconds: 600",
      "    - id: api-key",
      "      label: API key",
      "      kind: api-key",
      "      credential_env: FUTURE_API_KEY",
      "      source_env: FUTURE_API_KEY",
      "      prompt_label: Future API key",
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
    "packages/nemoclaw-future/host/provider-auth-adapter.cts",
    `module.exports = { resolveProviderAuthMethod(request) { return { kind: "managed", methodId: request.requestedMethod === "key" ? "api-key" : ${JSON.stringify(methodId)} }; } };\n`,
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

describe("receipt-bound provider authentication", () => {
  it("loads an unknown package provider and resolves only its finite typed auth choice", () => {
    const installed = installFuturePackage();
    const options = { storeRoot };

    expect(resolveHarnessProviderSelection(installed.identity, options)).toMatchObject({
      key: "futureProvider",
      provider_name: "future-provider",
      default_model: "future/default",
    });
    expect(isHarnessManagedProvider(installed.identity, "future-provider", options)).toBe(true);
    expect(resolveHarnessProviderAuthCapability(installed.identity, options)?.methods).toHaveLength(
      2,
    );
    expect(
      resolveHarnessProviderAuthMethod(
        installed.identity,
        { requestedMethod: "key", availableCredentialEnvs: ["FUTURE_API_KEY"] },
        options,
      ),
    ).toMatchObject({ id: "api-key", credential_env: "FUTURE_API_KEY" });
  });

  it("rejects a package adapter result that is not declared by its manifest", () => {
    const installed = installFuturePackage("undeclared-method");
    expect(() =>
      resolveHarnessProviderAuthMethod(
        installed.identity,
        { requestedMethod: null, availableCredentialEnvs: [] },
        { storeRoot },
      ),
    ).toThrow(HarnessProviderAuthError);
  });
});
