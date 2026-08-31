// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import * as policies from "../../../../src/lib/policy";
import { loadManagedToolGatewayMatrix } from "../../config/tool-gateway.ts";

type AllowRule = {
  allow?: {
    method?: string;
    path?: string;
  };
};

type Endpoint = {
  host?: string;
  port?: number;
  protocol?: string;
  enforcement?: string;
  allowed_ips?: string[];
  rules?: AllowRule[];
};

type NetworkPolicy = {
  endpoints?: Endpoint[];
  binaries?: Array<{ path?: string }>;
};

type PolicyDocument = {
  filesystem_policy?: { read_write?: string[] };
  network_policies?: Record<string, NetworkPolicy>;
};

const EXISTING_POLICY = YAML.stringify({
  version: 1,
  filesystem_policy: { read_write: ["/existing"] },
  network_policies: {
    existing: {
      name: "existing",
      endpoints: [{ host: "existing.example", port: 8443, access: "full", tls: "skip" }],
    },
  },
});

function composeHermesPresets(presetNames: string[]): PolicyDocument {
  const result = policies.mergePresetNamesIntoPolicy(EXISTING_POLICY, presetNames, {
    agent: "hermes",
    sandboxName: "effective-policy",
  });
  expect(result.appliedPresets).toEqual([...new Set(presetNames)]);
  expect(result.missingPresets).toEqual([]);

  const policy = YAML.parse(result.policy) as PolicyDocument;
  expect(policy.filesystem_policy?.read_write).toEqual(["/existing"]);
  expect(policy.network_policies?.existing).toBeDefined();
  return policy;
}

function requireNetworkPolicy(policy: PolicyDocument, name: string): NetworkPolicy {
  const entry = policy.network_policies?.[name];
  expect(entry, `expected effective network policy ${name}`).toBeDefined();
  return entry ?? {};
}

function methods(endpoint: Endpoint): string[] {
  return (endpoint.rules ?? [])
    .map((rule) => rule.allow?.method)
    .filter((method): method is string => typeof method === "string")
    .sort();
}

function binaries(policy: NetworkPolicy): string[] {
  return (policy.binaries ?? [])
    .map((binary) => binary.path)
    .filter((binary): binary is string => typeof binary === "string")
    .sort();
}

describe("Hermes effective policy", () => {
  it("keeps host-local inference and managed tools on their broker boundaries", () => {
    const matrix = loadManagedToolGatewayMatrix();
    const managedPresetNames = Object.keys(matrix);
    const effective = composeHermesPresets(["local-inference", ...managedPresetNames]);
    const localInference = requireNetworkPolicy(effective, "local_inference");
    const privateRanges = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];

    [8000, 11434, 11435].forEach((port) => {
      const endpoint = (localInference.endpoints ?? []).find(
        (candidate) => candidate.host === "host.openshell.internal" && candidate.port === port,
      );
      expect(endpoint, `expected local inference port ${port}`).toMatchObject({
        protocol: "rest",
        enforcement: "enforce",
        allowed_ips: privateRanges,
      });
      expect(methods(endpoint ?? {})).toEqual(["GET", "POST"]);
    });
    const llamaCpp = (localInference.endpoints ?? []).find(
      (candidate) => candidate.host === "host.openshell.internal" && candidate.port === 8081,
    );
    expect(llamaCpp?.rules).toEqual([{ allow: { method: "POST", path: "/v1/chat/completions" } }]);
    expect(binaries(localInference)).toEqual(
      expect.arrayContaining([
        "/usr/local/bin/openclaw",
        "/usr/local/bin/node",
        "/usr/bin/node",
        "/usr/bin/curl",
        "/usr/bin/python3",
      ]),
    );
    expect(binaries(localInference)).not.toContain("/usr/local/bin/claude");

    const vendorHosts = [
      "firecrawl-gateway.nousresearch.com",
      "fal-queue-gateway.nousresearch.com",
      "openai-audio-gateway.nousresearch.com",
      "browser-use-gateway.nousresearch.com",
      "modal-gateway.nousresearch.com",
    ];
    Object.entries(matrix).forEach(([presetName, entry]) => {
      const policyName = presetName.replace("-", "_");
      const policy = requireNetworkPolicy(effective, policyName);
      const broker = (policy.endpoints ?? []).find(
        (endpoint) => endpoint.host === "host.openshell.internal" && endpoint.port === 11436,
      );
      expect(JSON.stringify(broker), presetName).toContain(new URL(entry.envValue).pathname);
      expect(
        vendorHosts.every((host) =>
          Object.is(
            (policy.endpoints ?? []).some((endpoint) => endpoint.host === host),
            false,
          ),
        ),
      ).toBe(true);
      const browserHosts = (policy.endpoints ?? []).filter((endpoint) =>
        endpoint.host?.endsWith(".browser-use.com"),
      );
      expect(browserHosts.length > 0).toBe(presetName === "nous-browser");
    });
  });
});
