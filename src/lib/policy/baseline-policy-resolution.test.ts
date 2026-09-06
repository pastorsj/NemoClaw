// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as agentDefs from "../agent/defs";
import { readInstalledHarnessPackage } from "../agent-runtime/package/store";
import { ROOT } from "../runner";
import * as registry from "../state/registry";
import { createHarnessPackageFixture } from "../../../test/helpers/harness-packages";
import {
  resolveAgentBaselinePolicy,
  resolveAgentDefinitionBaselinePolicy,
  resolveSandboxBaselinePolicy,
  sandboxUsesNpmCompatibility,
} from "./index";

const tempDirs: string[] = [];

function writePolicy(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-baseline-policy-"));
  tempDirs.push(dir);
  const policyPath = path.join(dir, "policy-additions.yaml");
  fs.writeFileSync(policyPath, content);
  return policyPath;
}

function writeOpenClawPackagePolicy(content: string): { packageRoot: string; policyPath: string } {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-policy-"));
  tempDirs.push(packageRoot);
  const policyPath = path.join(packageRoot, "policy-additions.yaml");
  fs.writeFileSync(policyPath, content);
  return { packageRoot, policyPath };
}

function useAgentPolicy(content: string): void {
  vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "alpha", agent: "hermes" } as never);
  vi.spyOn(agentDefs, "loadAgent").mockReturnValue({
    name: "hermes",
    policyAdditionsPath: writePolicy(content),
  } as never);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("sandbox baseline policy resolution (#7194)", () => {
  it("uses the historical OpenClaw baseline when a row records no agent (#7194)", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "alpha", agent: null } as never);
    const loadAgentSpy = vi.spyOn(agentDefs, "loadAgent");

    expect(resolveSandboxBaselinePolicy("alpha")?.policyPath).toBe(
      path.join(ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"),
    );
    expect(loadAgentSpy).not.toHaveBeenCalled();
  });

  it.each([
    { label: "missing", policyAdditionsPath: null },
    { label: "unreadable", policyAdditionsPath: ROOT },
  ])(
    "refuses to substitute another runtime for a $label recorded-agent baseline (#7194)",
    ({ policyAdditionsPath }) => {
      vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "alpha", agent: "hermes" } as never);
      vi.spyOn(agentDefs, "loadAgent").mockReturnValue({
        name: "hermes",
        policyAdditionsPath,
      } as never);

      expect(() => resolveSandboxBaselinePolicy("alpha")).toThrow(
        "Refusing to substitute another runtime's baseline",
      );
    },
  );

  it("rejects malformed agent baseline YAML through the canonical parser (#7194)", () => {
    useAgentPolicy("version: [unterminated");

    expect(() => resolveSandboxBaselinePolicy("alpha")).toThrow(
      "Sandbox policy is malformed or is not an OpenShell policy YAML mapping",
    );
  });

  it("rejects a schema-invalid agent baseline with an unscoped network entry (#7194)", () => {
    useAgentPolicy(`
version: 1
network_policies:
  unsafe_entry:
    name: unsafe_entry
    endpoints:
      - host: api.example.test
        port: 443
        access: full
`);

    expect(() => resolveSandboxBaselinePolicy("alpha")).toThrow(
      /does not satisfy the shipped sandbox policy schema \(required: must have required property 'binaries'/,
    );
  });

  it.each(["hermes", "langchain-deepagents-code"] as const)(
    "accepts every checked-in non-OpenClaw agent baseline under the runtime schema [%s] (#7194)",
    (agentName) => {
      const getSandbox = vi.spyOn(registry, "getSandbox");
      // Keep this immutable: listAgents() observes the shared agents directory,
      // where parallel definition tests intentionally create transient manifests.

      getSandbox.mockReturnValue({ name: "alpha", agent: agentName } as never);
      expect(resolveSandboxBaselinePolicy("alpha")?.policyPath).toBe(
        agentDefs.loadAgent(agentName).policyAdditionsPath,
      );
    },
  );
});

describe("agent definition baseline policy resolution", () => {
  it("uses a synthetic sandbox receipt after its active package advances", () => {
    const fixtureParent = path.join(
      process.cwd(),
      "node_modules/.cache/nemoclaw-pinned-policy-tests",
    );
    fs.mkdirSync(fixtureParent, { recursive: true, mode: 0o700 });
    const home = fs.mkdtempSync(path.join(fixtureParent, "home-"));
    tempDirs.push(home);
    const storeRoot = path.join(home, ".nemoclaw", "harnesses");
    const reviewedPolicy = fs.readFileSync(
      path.join(ROOT, "packages/nemoclaw-hermes/policy-additions.yaml"),
      "utf8",
    );
    const pinnedContent = `${reviewedPolicy}\n# pinned synthetic package\n`;
    const ambientContent = `${reviewedPolicy}\n# ambient replacement package\n`;
    const selectedFixture = createHarnessPackageFixture({
      fixtureParent: path.join(home, "selected"),
      storeRoot,
      agentPolicyAdditionsContent: pinnedContent,
    });
    const selected = selectedFixture.installLocal({
      id: "synthetic-harness",
      packageVersion: "1.0.0",
    });
    const ambientFixture = createHarnessPackageFixture({
      fixtureParent: path.join(home, "ambient"),
      storeRoot,
      agentPolicyAdditionsContent: ambientContent,
    });
    const ambient = ambientFixture.installLocal({
      id: "synthetic-harness",
      packageVersion: "2.0.0",
    });
    vi.stubEnv("HOME", home);
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "alpha",
      agent: "synthetic-harness",
      harnessPackage: selected.identity,
    } as never);

    expect(readInstalledHarnessPackage("synthetic-harness")?.identity).toEqual(ambient.identity);
    expect(resolveSandboxBaselinePolicy("alpha")).toMatchObject({
      agent: "synthetic-harness",
      content: pinnedContent,
    });
  });

  it("uses a pinned OpenClaw package policy instead of the repository definition", () => {
    const reviewedPolicy = fs.readFileSync(
      path.join(ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"),
      "utf-8",
    );
    const pinned = writeOpenClawPackagePolicy(reviewedPolicy);
    const repositoryPolicyPath = writePolicy("version: [unterminated");
    const loadAgentSpy = vi.spyOn(agentDefs, "loadAgent").mockReturnValue({
      name: "openclaw",
      policyAdditionsPath: repositoryPolicyPath,
    } as never);

    expect(
      resolveAgentDefinitionBaselinePolicy({
        name: "openclaw",
        packageRoot: pinned.packageRoot,
        policyAdditionsPath: pinned.policyPath,
      }),
    ).toMatchObject({ agent: "openclaw", policyPath: pinned.policyPath, content: reviewedPolicy });
    expect(loadAgentSpy).not.toHaveBeenCalled();
  });

  it("selects npm overlap handling from an unknown receipt package's reviewed baseline", () => {
    const fixtureParent = fs.mkdtempSync(
      path.join(process.cwd(), "node_modules/.cache/nemoclaw-npm-package-tests-"),
    );
    tempDirs.push(fixtureParent);
    const home = path.join(fixtureParent, "home");
    const storeRoot = path.join(home, ".nemoclaw", "harnesses");
    const reviewedPolicy = fs.readFileSync(
      path.join(ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"),
      "utf8",
    );
    const fixture = createHarnessPackageFixture({
      fixtureParent: path.join(fixtureParent, "fixture"),
      storeRoot,
      agentPolicyAdditionsContent: reviewedPolicy,
    });
    const installed = fixture.installLocal({
      id: "synthetic-npm-harness",
      packageVersion: "1.0.0",
    });
    vi.stubEnv("HOME", home);
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "alpha",
      agent: "synthetic-npm-harness",
      harnessPackage: installed.identity,
    } as never);

    expect(sandboxUsesNpmCompatibility("alpha")).toBe(true);
  });

  it("uses a named package definition without a core package-name branch", () => {
    const policyPath = writePolicy(
      fs.readFileSync(path.join(ROOT, "packages/nemoclaw-hermes/policy-additions.yaml"), "utf8"),
    );
    const loadAgentSpy = vi.spyOn(agentDefs, "loadAgent").mockReturnValue({
      name: "future-harness",
      policyAdditionsPath: policyPath,
    } as never);

    expect(resolveAgentBaselinePolicy("future-harness")?.policyPath).toBe(policyPath);
    expect(loadAgentSpy).toHaveBeenCalledWith("future-harness");
  });
});
