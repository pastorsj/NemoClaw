// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  assertPolicyRequirementContainment,
  classifyOpenShellGlobalPolicyHistory,
  parseActiveGlobalPolicyMetadata,
  parseOpenShellPolicy,
  parseSandboxPolicyMetadata,
  stripProviderComposedPolicies,
  withoutProviderComposedPolicies,
} from "#nemoclaw-shared/openshell-policy-boundary.cjs";

type PolicyDecision = "accepted" | "rejected";

function parseDecision(raw: string): PolicyDecision {
  try {
    parseOpenShellPolicy(raw);
    return "accepted";
  } catch {
    return "rejected";
  }
}

const POLICY_CASES = [
  {
    name: "valid marked policy",
    raw: "Version: 1\n---\nversion: 1\nnetwork_policies:\n  safe: {}",
    decision: "accepted",
  },
  {
    name: "unmarked mapping without a policy root",
    raw: "future_policy:\n  keep: true",
    decision: "rejected",
  },
  {
    name: "versionless network policy",
    raw: "network_policies:\n  safe: {}",
    decision: "accepted",
  },
  { name: "missing document", raw: "", decision: "rejected" },
  {
    name: "diagnostic output",
    raw: "error: gateway unavailable",
    decision: "rejected",
  },
  {
    name: "diagnostic message mapping",
    raw: "message: gateway unavailable\ndetails: connection refused",
    decision: "rejected",
  },
  {
    name: "arbitrary lowercase diagnostic mapping",
    raw: "reason: gateway unavailable\nretryable: true",
    decision: "rejected",
  },
  {
    name: "malformed YAML",
    raw: "version: [unterminated",
    decision: "rejected",
  },
  { name: "scalar document", raw: "---\nscalar", decision: "rejected" },
  {
    name: "sequence document",
    raw: "---\n- item",
    decision: "rejected",
  },
  {
    name: "null network policies",
    raw: "version: 1\nnetwork_policies: null",
    decision: "rejected",
  },
  {
    name: "string version",
    raw: 'version: "1"\nnetwork_policies: {}',
    decision: "rejected",
  },
  {
    name: "fractional version",
    raw: "version: 1.5\nnetwork_policies: {}",
    decision: "rejected",
  },
] as const;

describe("OpenShell live policy boundary", () => {
  const policy = { version: 1, network_policies: { required: { allow: true } } };
  const metadata = (policySource: "sandbox" | "global", sandbox = "alpha") =>
    JSON.stringify({
      scope: "sandbox",
      sandbox,
      status: "effective",
      policy_source: policySource,
      active_version: 7,
      hash: "sha256:effective",
      policy,
    });

  it.each(["sandbox", "global"] as const)("preserves the %s policy source", (policySource) => {
    expect(parseSandboxPolicyMetadata(metadata(policySource), "alpha")).toEqual({
      policySource,
      effectivePolicy: policy,
      policyIdentity: { activeVersion: 7, hash: "sha256:effective" },
    });
  });

  it.each([
    ["empty", " \n\t", /empty sandbox policy metadata/u],
    ["malformed", "{", /malformed sandbox policy metadata/u],
    ["non-object", "[]", /malformed sandbox policy metadata/u],
    ["mismatched", metadata("sandbox", "beta"), /invalid sandbox policy metadata/u],
  ])("rejects %s sandbox metadata", (_caseName, raw, expected) => {
    expect(() => parseSandboxPolicyMetadata(raw, "alpha")).toThrow(expected);
  });

  it("accepts a loaded global policy as active OpenShell state (#9833)", () => {
    expect(
      parseActiveGlobalPolicyMetadata(
        JSON.stringify({
          scope: "global",
          status: "loaded",
          policy_source: "global",
          active_version: 9,
          hash: "sha256:global",
          policy,
        }),
      ),
    ).toEqual({
      state: "active",
      inspection: {
        policySource: "global",
        effectivePolicy: policy,
        policyIdentity: { activeVersion: 9, hash: "sha256:global" },
      },
    });
  });

  it.each([
    ["an active revision", "VERSION STATUS\n1 loaded\n", "", "present"],
    ["OpenShell 0.0.106 fresh history", "", "No global policy history found\n", "absent"],
    ["empty output", "", "", "invalid"],
    ["an unexpected diagnostic", "", "gateway warning", "invalid"],
  ] as const)(
    "classifies %s without treating ambiguous output as absence",
    (_name, stdout, stderr, state) => {
      expect(classifyOpenShellGlobalPolicyHistory(stdout, stderr)).toBe(state);
    },
  );

  it("treats a superseded global revision as absent without requiring an identity (#9833)", () => {
    expect(
      parseActiveGlobalPolicyMetadata(
        JSON.stringify({
          scope: "global",
          status: "superseded",
          policy_source: "global",
        }),
      ),
    ).toEqual({ state: "absent" });
  });

  it.each([
    ["empty output", " \n\t", /empty global policy metadata/u],
    ["malformed JSON", "{", /malformed global policy metadata/u],
    ["non-object JSON", "[]", /malformed global policy metadata/u],
    [
      "invalid metadata",
      JSON.stringify({ scope: "sandbox", status: "loaded", policy_source: "global" }),
      /invalid global policy metadata/u,
    ],
    [
      "sandbox-scoped global metadata",
      JSON.stringify({
        scope: "global",
        status: "loaded",
        policy_source: "global",
        sandbox: "alpha",
      }),
      /invalid global policy metadata/u,
    ],
    [
      "missing loaded policy",
      JSON.stringify({
        scope: "global",
        status: "loaded",
        policy_source: "global",
        active_version: 9,
        hash: "sha256:global",
      }),
      /invalid global policy metadata/u,
    ],
    [
      "empty policy identity",
      JSON.stringify({
        scope: "global",
        status: "loaded",
        policy_source: "global",
        active_version: 9,
        hash: "",
        policy,
      }),
      /invalid global policy metadata/u,
    ],
    [
      "malformed policy identity",
      JSON.stringify({
        scope: "global",
        status: "loaded",
        policy_source: "global",
        active_version: "9",
        hash: "sha256:global",
        policy,
      }),
      /invalid global policy metadata/u,
    ],
  ])("rejects %s for global policy inspection (#9833)", (_name, raw, expected) => {
    expect(() => parseActiveGlobalPolicyMetadata(raw)).toThrow(expected);
  });

  it("requires entries and sections while allowing unrelated live content", () => {
    const inspection = {
      policySource: "global" as const,
      policyIdentity: { activeVersion: 7, hash: "sha256:effective" },
      effectivePolicy: {
        version: 9,
        filesystem_policy: { read_only: true },
        extra_section: { keep: true },
        network_policies: { required: { allow: true }, extra: { allow: true } },
      },
    };
    expect(() =>
      assertPolicyRequirementContainment(inspection, {
        version: 1,
        filesystem_policy: { read_only: true },
        network_policies: { required: { allow: true } },
      }),
    ).not.toThrow();
    expect(() =>
      assertPolicyRequirementContainment(inspection, {
        filesystem_policy: { read_only: false },
        process: { user: 1000 },
        network_policies: { required: { allow: false }, missing: {} },
      }),
    ).toThrow(
      /missing entries "missing"; drifted entries "required"; missing sections "process"; drifted sections "filesystem_policy"/u,
    );
    expect(() =>
      assertPolicyRequirementContainment(inspection, {
        network_policies: [] as never,
      }),
    ).toThrow(/required network policy input is invalid/u);
  });
});

describe("canonical OpenShell policy boundary", () => {
  it("parses marked output and versionless network policies", () => {
    const body = "version: 1\nnetwork_policies:\n  safe: {}";
    expect(parseOpenShellPolicy(`Version: 1\n---\n${body}`)).toEqual({
      yamlBody: body,
      policy: YAML.parse(body),
    });

    const versionless = "network_policies:\n  safe: {}";
    expect(parseOpenShellPolicy(versionless).yamlBody).toBe(versionless);

    const inlineSeparator = 'version: 1\nmetadata:\n  marker: "a---b"\nnetwork_policies: {}';
    expect(parseOpenShellPolicy(inlineSeparator).yamlBody).toBe(inlineSeparator);

    const markedFuturePolicy = "Version: 1\n---\nfuture_policy:\n  keep: true";
    expect(parseOpenShellPolicy(markedFuturePolicy).policy).toEqual({
      future_policy: { keep: true },
    });
  });

  it.each(["", "Version: 1\n---", "error: gateway unavailable"])(
    "rejects output without a policy: %j",
    (raw) => {
      expect(() => parseOpenShellPolicy(raw)).toThrow(/does not contain a policy/);
    },
  );

  it("rejects malformed and scalar policy output", () => {
    expect(() => parseOpenShellPolicy("version: [unterminated")).toThrow(/not valid YAML/);
    expect(() => parseOpenShellPolicy("---\nscalar")).toThrow(/must be a YAML mapping/);
  });

  it.each([
    "version: 1\nnetwork_policies: invalid",
    "version: 1\nnetwork_policies: []",
    "version: 1\nnetwork_policies: null",
  ])("rejects a non-mapping network_policies value: %j", (raw) => {
    expect(() => parseOpenShellPolicy(raw)).toThrow(/network_policies must be a YAML mapping/);
  });

  it.each(['version: "1"\nnetwork_policies: {}', "version: 1.5\nnetwork_policies: {}"])(
    "rejects a non-integer policy version: %j",
    (raw) => {
      expect(() => parseOpenShellPolicy(raw)).toThrow(/version must be a positive integer/);
    },
  );

  it("rejects unmarked future output", () => {
    expect(() => parseOpenShellPolicy("FutureKey: value")).toThrow(/does not contain a policy/);
  });

  it.each(POLICY_CASES)("returns $decision for $name", ({ raw, decision }) => {
    expect(parseDecision(raw)).toBe(decision);
  });

  it("removes provider-composed policies without mutating other policy fields", () => {
    expect(
      withoutProviderComposedPolicies({ safe: { allow: true }, _provider_generated: {} }),
    ).toEqual({ safe: { allow: true } });

    const policy = YAML.stringify({
      version: 1,
      future_policy: { keep: true },
      network_policies: { safe: {}, _provider_generated: {} },
    });
    expect(YAML.parse(stripProviderComposedPolicies(policy))).toEqual({
      version: 1,
      future_policy: { keep: true },
      network_policies: { safe: {} },
    });
  });

  it.each(["version: 1", "version: 1\nnetwork_policies:\n  safe: {}"])(
    "leaves the non-composed mapping %j unchanged",
    (policy) => {
      expect(stripProviderComposedPolicies(policy)).toBe(policy);
    },
  );

  it("rejects malformed YAML while stripping composed policies", () => {
    expect(() => stripProviderComposedPolicies("version: [unterminated")).toThrow(/invalid YAML/);
  });
});
