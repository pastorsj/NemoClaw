// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

type QualificationRuntime = {
  parseSelectionQualificationRequest(encoded: string): QualificationRequest | null;
  parseDcodeSelectionIdentity(output: string): Record<string, string> | null;
  selectionMatchesNativeIdentity(
    request: QualificationRequest,
    output: string,
    identityRuntime: ManagedIdentityRuntime,
  ): boolean;
};
type QualificationRequest = {
  schemaVersion: 1;
  packageId: "langchain-deepagents-code";
  selection: {
    upstreamProvider: string;
    model: string;
    providerKey: string;
    baseUrl: string;
    api: "openai-completions";
    endpointUrl: string | null;
  };
};
type ManagedIdentityRuntime = {
  resolveManagedDcodeIdentity(
    provider: string,
    model: string,
    endpoint: string | null,
  ): { provider: "openai" | "openrouter"; model: string; defaultModel: string };
};

const require = createRequire(import.meta.url);
const runtime = require(
  path.join(import.meta.dirname, "../../runtime/selection-qualify.cts"),
) as QualificationRuntime;
const identityRuntime = require(
  path.join(import.meta.dirname, "../../host/managed-identity.cts"),
) as ManagedIdentityRuntime;

function request(overrides: Partial<QualificationRequest["selection"]> = {}): QualificationRequest {
  return {
    schemaVersion: 1,
    packageId: "langchain-deepagents-code",
    selection: {
      upstreamProvider: "nvidia-prod",
      model: "nvidia/model-a",
      providerKey: "inference",
      baseUrl: "https://inference.local/v1",
      api: "openai-completions",
      endpointUrl: null,
      ...overrides,
    },
  };
}

function output(
  overrides: Partial<Record<"Route" | "Provider" | "Model" | "Endpoint", string>> = {},
) {
  return [
    `Route:    ${overrides.Route ?? "inference"}`,
    `Provider: ${overrides.Provider ?? "nvidia-prod"}`,
    `Model:    ${overrides.Model ?? "openai:nvidia/model-a"}`,
    `Endpoint: ${overrides.Endpoint ?? "https://inference.local/v1"}`,
  ].join("\n");
}

describe("DCode selection qualification", () => {
  it("accepts the existing managed DCode identity contract", () => {
    expect(runtime.selectionMatchesNativeIdentity(request(), output(), identityRuntime)).toBe(true);
  });

  it("preserves OpenRouter provider and model normalization inside the package", () => {
    expect(
      runtime.selectionMatchesNativeIdentity(
        request({
          upstreamProvider: "compatible-endpoint",
          model: "openai:nvidia/model-a",
          endpointUrl: "https://openrouter.ai/api/v1/",
        }),
        output({ Provider: "openrouter", Model: "openrouter:nvidia/model-a" }),
        identityRuntime,
      ),
    ).toBe(true);
  });

  it.each([
    output({ Route: "openai" }),
    output({ Provider: "openai-api" }),
    output({ Model: "openai:other" }),
    output({ Endpoint: "https://old.example/v1" }),
    `${output()}\nProvider: nvidia-prod`,
  ])("rejects native selection drift [case %#]", (nativeOutput) => {
    expect(runtime.selectionMatchesNativeIdentity(request(), nativeOutput, identityRuntime)).toBe(
      false,
    );
  });

  it("decodes only the exact bounded contract request", () => {
    const valid = request();
    const encoded = Buffer.from(JSON.stringify(valid), "utf8").toString("base64url");
    expect(runtime.parseSelectionQualificationRequest(encoded)).toEqual(valid);
    expect(
      runtime.parseSelectionQualificationRequest(
        Buffer.from(JSON.stringify({ ...valid, token: "secret" }), "utf8").toString("base64url"),
      ),
    ).toBeNull();
  });
});
