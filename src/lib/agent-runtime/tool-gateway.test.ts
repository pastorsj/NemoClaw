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
import { selectPackageToolGateways } from "../onboard/package/tool-gateway-selection";
import { installHarnessPackage } from "./package/install";
import {
  formatHarnessToolGatewaySelections,
  normalizeHarnessToolGatewaySelections,
  parseHarnessToolGatewayRequest,
  resolveHarnessToolGatewayCapability,
  resolveHarnessToolGatewayPolicyPresets,
} from "./tool-gateway";

const TEST_PARENT = path.join(process.cwd(), "node_modules/.cache/tool-gateway-tests");
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

function installFuturePackage(includeCapability = true) {
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
      "  operations: [describe-provider, register-refresh-provider, ensure-broker, inspect-broker, teardown-broker]",
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
      "    models: [future/default]",
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
      "policy:",
      "  owned_presets: [future-search, future-image]",
      "  automatic_presets: []",
      "  baseline_exclusion_impacts: {}",
      ...(includeCapability
        ? [
            "tool_gateways:",
            "  support: managed",
            "  selection_label: Future managed tools",
            "  selection_prompt: Managed tools",
            "  request_environment: [NEMOCLAW_FUTURE_TOOL_GATEWAYS]",
            "  incompatible_auth_message: Managed tools require browser login.",
            "  gateways:",
            "    - id: future-search",
            "      aliases: [search]",
            "      label: Future search",
            "      description: Search through the future provider",
            "      default_selected: true",
            "      authentication_methods: [browser-login]",
            "      policy_presets: [future-search]",
            "    - id: future-image",
            "      aliases: [image]",
            "      label: Future image",
            "      description: Generate an image through the future provider",
            "      default_selected: false",
            "      authentication_methods: [browser-login]",
            "      policy_presets: [future-image]",
          ]
        : []),
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
    'module.exports = { resolveProviderAuthMethod() { return { kind: "managed", methodId: "browser-login" }; } };\n',
  );
  write(
    "packages/nemoclaw-future/host/provider-broker-adapter.cts",
    'module.exports = { buildProviderBrokerPlan(request) { return { kind: "managed", providerName: request.sandboxName + "-future-tools" }; } };\n',
  );
  write(
    "packages/nemoclaw-future/host/provider-broker-control.cts",
    "module.exports = Object.freeze({});\n",
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

describe("receipt-bound managed tool gateways", () => {
  it("reads and evaluates a synthetic package without a harness-name branch", () => {
    const installed = installFuturePackage();
    const capability = resolveHarnessToolGatewayCapability(installed.identity, { storeRoot });
    expect(capability?.selection_label).toBe("Future managed tools");
    expect(
      parseHarnessToolGatewayRequest(capability!, {
        NEMOCLAW_FUTURE_TOOL_GATEWAYS: "image,search",
      }),
    ).toEqual(["future-image", "future-search"]);
    expect(
      normalizeHarnessToolGatewaySelections(capability!, ["unknown", "future-search"]),
    ).toEqual(["future-search"]);
    expect(
      resolveHarnessToolGatewayPolicyPresets(capability, ["future-image", "future-search"]),
    ).toEqual(["future-search", "future-image"]);
    expect(formatHarnessToolGatewaySelections(capability, ["future-search"])).toBe("Future search");
  });

  it("uses declared environment aliases and authentication compatibility", async () => {
    const installed = installFuturePackage();
    const notes: string[] = [];
    const result = await selectPackageToolGateways(installed.identity, "browser-login", [], {
      env: { NEMOCLAW_FUTURE_TOOL_GATEWAYS: "image" },
      prompt: async () => "",
      note: (message) => notes.push(message),
      log: () => undefined,
      isNonInteractive: () => true,
      packageStore: { storeRoot },
    });
    expect(result).toEqual({ kind: "managed", selections: ["future-image"] });
    expect(notes.join("\n")).toContain("Future image");

    const incompatible = await selectPackageToolGateways(installed.identity, "api-key", [], {
      env: { NEMOCLAW_FUTURE_TOOL_GATEWAYS: "search" },
      prompt: async () => "",
      note: (message) => notes.push(message),
      log: () => undefined,
      isNonInteractive: () => true,
      packageStore: { storeRoot },
    });
    expect(incompatible).toEqual({ kind: "managed", selections: [] });
    expect(notes).toContain("  Managed tools require browser login.");
  });

  it("does not fall through to another harness when the receipt declares no capability", async () => {
    const installed = installFuturePackage(false);
    const result = await selectPackageToolGateways(
      installed.identity,
      "browser-login",
      ["nous-web"],
      {
        env: { NEMOCLAW_HERMES_TOOL_GATEWAYS: "nous-web" },
        prompt: async () => "",
        note: () => undefined,
        log: () => undefined,
        isNonInteractive: () => true,
        packageStore: { storeRoot },
      },
    );
    expect(result).toEqual({ kind: "unsupported", selections: [] });
  });
});
