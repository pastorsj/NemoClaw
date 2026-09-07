// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import type {
  HarnessAgentManifest,
  HarnessProviderAuthAdapterModule,
} from "@nvidia/nemoclaw-harness-contract";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { loadPackageHostModule } from "../helpers/host-module";

const packageRoot = path.resolve(import.meta.dirname, "../..");
const manifest = parse(
  fs.readFileSync(path.join(packageRoot, "manifest.yaml"), "utf8"),
) as HarnessAgentManifest;
const capability = manifest.provider_auth;
const adapter = loadPackageHostModule<HarnessProviderAuthAdapterModule>(
  "provider-auth-adapter.cts",
);

describe("Hermes provider authentication adapter", () => {
  it("declares the existing Nous provider route and fallback model catalogue", () => {
    expect(capability).toMatchObject({
      support: "managed",
      adapter: "provider-auth",
      operation: "resolve-auth-method",
      default_method: "oauth",
      selection: {
        key: "hermesProvider",
        provider_name: "hermes-provider",
        provider_type: "openai",
        endpoint_url: "https://inference-api.nousresearch.com/v1",
        help_url: "https://portal.nousresearch.com/manage-subscription",
        default_model: "moonshotai/kimi-k2.6",
        preferred_inference_api: "openai-completions",
      },
    });
    if (capability?.support !== "managed") throw new Error("expected managed provider auth");
    expect(capability.selection.models).toHaveLength(30);
    expect(capability.selection.models).toContain("nvidia/nemotron-3-super-120b-a12b");
    expect(capability.methods).toEqual([
      {
        id: "oauth",
        label: "Nous Portal OAuth (authenticate via browser)",
        kind: "oauth-device-code",
        credential_env: "OPENAI_API_KEY",
        device_code: {
          portal_base_url: "https://portal.nousresearch.com",
          client_id: "hermes-cli",
          scope: "inference:mint_agent_key",
          minimum_credential_ttl_seconds: 1800,
        },
      },
      {
        id: "api-key",
        label: "Nous API Key (paste a key from the provider dashboard)",
        kind: "api-key",
        credential_env: "NOUS_API_KEY",
        source_env: "NOUS_API_KEY",
        prompt_label: "Nous API Key",
      },
    ]);
  });

  it.each(["api", "key", "api-key", "apikey", "nous-api-key"])(
    "normalizes the legacy API-key alias %s",
    (requestedMethod) => {
      expect(
        adapter.resolveProviderAuthMethod({
          requestedMethod,
          availableCredentialEnvs: [],
        }),
      ).toEqual({ kind: "managed", methodId: "api-key" });
    },
  );

  it("uses a staged Nous key when no method is requested and otherwise defaults to OAuth", () => {
    expect(
      adapter.resolveProviderAuthMethod({
        requestedMethod: null,
        availableCredentialEnvs: ["NOUS_API_KEY"],
      }),
    ).toEqual({ kind: "managed", methodId: "api-key" });
    expect(
      adapter.resolveProviderAuthMethod({
        requestedMethod: null,
        availableCredentialEnvs: [],
      }),
    ).toEqual({ kind: "managed", methodId: "oauth" });
  });

  it("rejects auth modes outside the finite package vocabulary", () => {
    expect(
      adapter.resolveProviderAuthMethod({
        requestedMethod: "arbitrary-command",
        availableCredentialEnvs: [],
      }),
    ).toEqual({
      kind: "unsupported",
      reason: "requested provider authentication method is unsupported",
    });
  });
});
