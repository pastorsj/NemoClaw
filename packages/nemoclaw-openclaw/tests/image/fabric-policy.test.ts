// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { prepareInitialSandboxCreatePolicy } from "../../../../src/lib/onboard/initial-policy";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const FABRIC_ENVIRONMENT_PATH = "/opt/nemoclaw-fabric-venv";
const POLICY_PATHS = [
  path.join(PACKAGE_ROOT, "policy-additions.yaml"),
  path.resolve(PACKAGE_ROOT, "../../nemoclaw-blueprint/policies/openclaw-sandbox.yaml"),
];

describe("OpenClaw Fabric filesystem policy", () => {
  it.each(POLICY_PATHS)("allows the isolated Fabric environment through %s", (policyPath) => {
    const prepared = prepareInitialSandboxCreatePolicy(policyPath, [], {
      agentName: "openclaw",
    });
    try {
      const policy = YAML.parse(fs.readFileSync(prepared.policyPath, "utf8")) as {
        filesystem_policy?: { read_only?: string[]; read_write?: string[] };
      };
      expect(policy.filesystem_policy?.read_only).toContain(FABRIC_ENVIRONMENT_PATH);
      expect(policy.filesystem_policy?.read_write).not.toContain(FABRIC_ENVIRONMENT_PATH);
    } finally {
      prepared.cleanup?.();
    }
  });
});
