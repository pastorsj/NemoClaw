// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { prepareInitialSandboxCreatePolicy } from "../../../../src/lib/onboard/initial-policy.ts";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const FABRIC_EXECUTABLE_PATH = "/usr/local/bin/nemoclaw-fabric";
const FABRIC_INTERPRETER_PATH = "/opt/nemoclaw-fabric-venv/bin/python3*";

type EffectivePolicy = {
  filesystem_policy?: { read_only?: string[] };
  landlock?: { compatibility?: string };
  network_policies?: Record<
    string,
    {
      binaries?: Array<{ path?: unknown }>;
      endpoints?: Array<{ host?: string }>;
    }
  >;
};

function policyBinaryPaths(policy: EffectivePolicy, policyName: string): string[] {
  const binaries = policy.network_policies?.[policyName]?.binaries;
  expect(Array.isArray(binaries), `${policyName} policy must declare binary-scoped egress`).toBe(
    true,
  );
  return (binaries ?? []).map((entry, index) => {
    expect(typeof entry.path, `${policyName} binary #${index} must declare a string path`).toBe(
      "string",
    );
    return entry.path as string;
  });
}

describe("Deep Agents Code image policy", () => {
  it("grants Fabric only managed inference, GitHub, and PyPI egress and requires Landlock", () => {
    const basePolicyPath = path.join(PACKAGE_ROOT, "policy-additions.yaml");
    const defaultPrepared = prepareInitialSandboxCreatePolicy(basePolicyPath, [], {
      agentName: "langchain-deepagents-code",
    });
    const tavilyPrepared = prepareInitialSandboxCreatePolicy(basePolicyPath, [], {
      agentName: "langchain-deepagents-code",
      additionalPresets: ["tavily"],
    });
    const defaultPolicy = YAML.parse(
      fs.readFileSync(defaultPrepared.policyPath, "utf8"),
    ) as EffectivePolicy;
    const tavilyPolicy = YAML.parse(
      fs.readFileSync(tavilyPrepared.policyPath, "utf8"),
    ) as EffectivePolicy;

    try {
      const defaultHosts = Object.values(defaultPolicy.network_policies ?? {}).flatMap((entry) =>
        (entry.endpoints ?? []).map((endpoint) => endpoint.host),
      );
      expect(Object.keys(defaultPolicy.network_policies ?? {}).sort()).toEqual([
        "github",
        "managed_inference",
        "pypi",
      ]);
      expect(defaultHosts.sort()).toEqual([
        "api.github.com",
        "files.pythonhosted.org",
        "github.com",
        "inference.local",
        "pypi.org",
        "raw.githubusercontent.com",
      ]);
      expect(defaultPolicy.filesystem_policy?.read_only).toEqual(
        expect.arrayContaining(["/usr", "/opt/venv", "/opt/nemoclaw-fabric-venv", "/etc"]),
      );
      expect(defaultPolicy.landlock).toMatchObject({ compatibility: "strict" });

      for (const policyName of ["managed_inference", "github", "pypi"]) {
        expect(policyBinaryPaths(defaultPolicy, policyName)).toEqual(
          expect.arrayContaining([FABRIC_EXECUTABLE_PATH, FABRIC_INTERPRETER_PATH]),
        );
      }

      const githubBinaries = policyBinaryPaths(defaultPolicy, "github");
      expect(githubBinaries).toEqual(
        expect.arrayContaining(["/usr/bin/git", "/usr/local/bin/dcode", "/opt/venv/bin/python3*"]),
      );
      expect(githubBinaries).not.toEqual(expect.arrayContaining(["/usr/bin/python3*"]));
      expect(githubBinaries).not.toEqual(expect.arrayContaining(["/usr/local/bin/python3*"]));
      expect(githubBinaries).not.toEqual(expect.arrayContaining(["/usr/local/lib/python3.13/**"]));

      const pypiBinaries = policyBinaryPaths(defaultPolicy, "pypi");
      expect(pypiBinaries).toEqual(
        expect.arrayContaining([
          "/opt/venv/bin/pip3",
          "/sandbox/**/bin/pip3",
          "/opt/venv/bin/python3*",
          "/sandbox/**/bin/python3*",
          "/usr/local/bin/dcode",
        ]),
      );
      expect(pypiBinaries).not.toEqual(expect.arrayContaining(["/usr/bin/python3*"]));
      expect(pypiBinaries).not.toEqual(expect.arrayContaining(["/usr/local/bin/python3*"]));
      expect(pypiBinaries).not.toEqual(expect.arrayContaining(["/usr/local/bin/pip3"]));
      expect(pypiBinaries).not.toEqual(expect.arrayContaining(["/usr/local/lib/python3.13/**"]));

      const defaultBinaries = Object.values(defaultPolicy.network_policies ?? {}).flatMap((entry) =>
        (entry.binaries ?? []).map((binary) => binary.path),
      );
      expect(defaultBinaries).not.toEqual(
        expect.arrayContaining(["/usr/local/bin/dcode.real", "dcode.upstream"]),
      );

      expect(tavilyPrepared.appliedPresets).toContain("tavily");
      expect(
        tavilyPolicy.network_policies?.tavily?.endpoints?.map((endpoint) => endpoint.host),
      ).toContain("api.tavily.com");
      const tavilyBinaries = policyBinaryPaths(tavilyPolicy, "tavily");
      expect(tavilyBinaries).toContain("/opt/venv/bin/python3*");
      expect(tavilyBinaries).not.toEqual(
        expect.arrayContaining([FABRIC_EXECUTABLE_PATH, FABRIC_INTERPRETER_PATH]),
      );
    } finally {
      defaultPrepared.cleanup?.();
      tavilyPrepared.cleanup?.();
    }
  });
});
