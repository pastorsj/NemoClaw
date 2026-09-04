// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  listBundledAgentRuntimeSources,
  makeManagedOutputWritable,
  materializeBundledHarnesses,
} from "../../scripts/build-harnesses.mts";
import { runAgentPassthrough } from "../../src/lib/actions/sandbox/agent/passthrough";
import { loadHarnessMcpAdapterHostModule } from "../../src/lib/agent-runtime/host-module";
import {
  listHarnessPackageInventory,
  resolveHarnessPackageInstallSelection,
} from "../../src/lib/agent-runtime/package/catalog";
import { installHarnessPackage } from "../../src/lib/agent-runtime/package/install";
import type { BundledHarnessPackageSourceIdentity } from "../../src/lib/agent-runtime/package/receipt";
import { resolveDockerStartupCommandPatch } from "../../src/lib/onboard/docker-startup-command-agent";
import { selectOnboardHarnessPackage } from "../../src/lib/onboard/package-selection";
import { resolveSandboxAgent } from "../../src/lib/onboard/sandbox-agent";
import { resolveSandboxWorkloadSource } from "../../src/lib/onboard/workload/source";
import type { SandboxEntry } from "../../src/lib/state/registry/types";

const PACKAGE_ID = "future-terminal";
const PACKAGE_ALIAS = "future";
const PACKAGE_DIRECTORY = `nemoclaw-${PACKAGE_ID}`;
const MANIFEST_PATH = `packages/${PACKAGE_DIRECTORY}/manifest.yaml`;
const FABRIC_CONFIG_PATH = "/sandbox/.future-terminal/fabric.json";
const SOURCE_IDENTITY: BundledHarnessPackageSourceIdentity = Object.freeze({
  kind: "bundled",
  nemoclawBuildIdentity: Object.freeze({
    nemoclawVersion: "0.0.113",
    sourceRevision: "e".repeat(40),
  }),
});

let fixtureRoot = "";
let authoringRoot = "";
let bundledRoot = "";
let storeRoot = "";
let authoringPackageRoot = "";

function writeAuthoringPackageFile(
  relativePath: string,
  contents: string,
  mode: number = 0o600,
): void {
  const target = path.join(authoringPackageRoot, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, contents, { mode });
  fs.chmodSync(target, mode);
}

function writeFutureAuthoringPackage(): void {
  authoringPackageRoot = path.join(authoringRoot, "packages", PACKAGE_DIRECTORY);
  fs.mkdirSync(authoringPackageRoot, { recursive: true, mode: 0o700 });
  writeAuthoringPackageFile(
    "package.json",
    `${JSON.stringify({
      name: `@fixture/${PACKAGE_DIRECTORY}`,
      version: "1.0.0",
      nemoclaw: { harnessManifest: "manifest.yaml" },
    })}\n`,
  );
  writeAuthoringPackageFile(
    "manifest.yaml",
    [
      `name: ${PACKAGE_ID}`,
      "display_name: Future Terminal",
      "description: Synthetic package for the generic composition contract",
      "aliases:",
      `  - ${PACKAGE_ALIAS}`,
      "onboarding:",
      "  default: true",
      "  sandbox_name: future-sandbox",
      "binary_path: /usr/local/bin/future-terminal",
      "runtime:",
      "  kind: terminal",
      "  interactive_command: future-terminal",
      `  headless_command: nemoclaw-fabric-run --deadline-seconds 120 --kill-grace-seconds 10 --config ${FABRIC_CONFIG_PATH}`,
      "mcp:",
      "  support: disabled",
      "  reason: This package does not expose MCP.",
      "",
    ].join("\n"),
  );
  writeAuthoringPackageFile("Dockerfile.base", "FROM scratch\n");
  writeAuthoringPackageFile(
    "Dockerfile",
    `FROM scratch\nCOPY packages/${PACKAGE_DIRECTORY}/start.sh /usr/local/bin/nemoclaw-start\n`,
  );
  writeAuthoringPackageFile("start.sh", "#!/bin/sh\nexec future-terminal\n", 0o700);
  writeAuthoringPackageFile("policy-additions.yaml", "version: 1\nnetwork_policies: {}\n");
  writeAuthoringPackageFile("fabric/future.fabric-adapter.json", '{"adapter":"future-terminal"}\n');
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(
    path.join(process.cwd(), "node_modules/.cache/nemoclaw-package-composition-"),
  );
  fs.chmodSync(fixtureRoot, 0o700);
  authoringRoot = path.join(fixtureRoot, "repository");
  bundledRoot = path.join(fixtureRoot, "bundled");
  storeRoot = path.join(fixtureRoot, "store");
  fs.mkdirSync(storeRoot, { recursive: true, mode: 0o700 });
  writeFutureAuthoringPackage();
});

afterEach(() => {
  makeManagedOutputWritable(bundledRoot);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("future harness package composition", () => {
  it("discovers, installs, and routes an unknown Dockerfile package to its Fabric command", async () => {
    expect(listBundledAgentRuntimeSources(authoringRoot)).toMatchObject([
      {
        id: PACKAGE_ID,
        displayName: "Future Terminal",
        packageVersion: "1.0.0",
        manifestPath: MANIFEST_PATH,
      },
    ]);
    const [artifact] = materializeBundledHarnesses(bundledRoot, authoringRoot);
    assert.equal(artifact?.id, PACKAGE_ID);

    const initialInventory = listHarnessPackageInventory({ bundledRoot, storeRoot });
    expect(initialInventory.available.map(({ id }) => id)).toEqual([PACKAGE_ID]);
    expect(initialInventory.installed).toEqual([]);

    const installSelection = resolveHarnessPackageInstallSelection(PACKAGE_ALIAS, {
      bundledRoot,
      storeRoot,
    });
    const installed = installHarnessPackage(
      { packageRoot: installSelection.packageRoot, sourceIdentity: SOURCE_IDENTITY },
      { storeRoot },
    );
    const selected = await selectOnboardHarnessPackage({
      agentFlag: PACKAGE_ALIAS,
      bundledRoot,
      canPrompt: false,
      environment: {},
      log: () => undefined,
      prompt: async () => "1",
      storeRoot,
    });
    assert.equal(selected.kind, "package");

    expect(selected).toMatchObject({
      recordedAgent: PACKAGE_ID,
      harnessPackage: installed.identity,
    });
    expect(selected.effectiveDefinition).toMatchObject({
      name: PACKAGE_ID,
      defaultSandboxName: "future-sandbox",
      runtime: {
        kind: "terminal",
        interactive_command: "future-terminal",
        headless_command: expect.stringContaining("nemoclaw-fabric-run"),
      },
    });

    const workload = resolveSandboxWorkloadSource({
      agentName: PACKAGE_ID,
      legacyDockerfilePath: selected.effectiveDefinition.dockerfilePath!,
      runtime: {
        driverName: "docker",
        managedImageSelectionPolicy: "prefer-managed",
        legacyDockerfileBuilds: true,
        managedImages: null,
      },
      catalog: {},
    });
    expect(workload).toEqual({
      kind: "legacy-dockerfile",
      dockerfilePath: selected.effectiveDefinition.dockerfilePath,
      reason: "agent-not-managed",
    });
    expect(resolveDockerStartupCommandPatch(selected.effectiveDefinition, true, {})).toEqual({
      persistStartupCommand: true,
      requiredUlimits: null,
    });

    const entry: SandboxEntry = {
      name: "future-sandbox",
      agent: PACKAGE_ID,
      harnessPackage: installed.identity,
    };
    const exec = vi.fn(async () => undefined);
    const prompt = "Reply with PONG";
    await runAgentPassthrough(
      entry.name,
      { extraArgs: ["-m", prompt, "--json"] },
      {
        getSandbox: () => entry,
        resolveAgent: (sandbox) =>
          resolveSandboxAgent(sandbox, {
            storeRoot,
            env: {},
            requireLifecycleEligibility: true,
          }),
        ensureLive: async () => ({ state: "present", phase: "Ready", output: "Phase: Ready" }),
        exec,
      },
    );

    expect(exec).toHaveBeenCalledExactlyOnceWith(
      entry.name,
      [
        "nemoclaw-fabric-run",
        "--deadline-seconds",
        "120",
        "--kill-grace-seconds",
        "10",
        "--config",
        FABRIC_CONFIG_PATH,
        "--stdin",
        "--json",
      ],
      { stdinInput: prompt, tty: false },
    );
    expect(() => loadHarnessMcpAdapterHostModule(installed.identity, { storeRoot })).toThrow(
      "Installed harness package manifest does not declare MCP adapter",
    );
  });
});
