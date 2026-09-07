// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TEST_CONFIG_ADAPTER_SOURCE,
  TEST_MESSAGING_ADAPTER_SOURCE,
  TEST_STARTUP_ADAPTER_SOURCE,
} from "../../../../test/helpers/adapter-fixtures";
import { installHarnessPackage } from "../../agent-runtime/package/install";
import type { HarnessPackageIdentity } from "../../agent-runtime/package/types";
import { createHermesStateVolumeDockerHarness } from "../__test-helpers__/hermes-state-volume";
import { prepareManagedStateVolumes } from "./managed-state-volumes";
import {
  prepareManagedAgentStateVolumeCleanup,
  removePreparedManagedAgentStateVolumes,
} from "./agent-state-volume";

const TEST_PARENT = path.join(process.cwd(), "node_modules/.cache/agent-state-volume-tests");
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

function installFuturePackage() {
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
      "managed_image:",
      "  repository: registry.example/future/harness",
      "  architectures: [linux/amd64]",
      "  runtime_identity:",
      "    uid: 1001",
      "    gid: 1002",
      "    workdir: /sandbox",
      "  state_root:",
      "    mount_target: /sandbox/.future",
      '    mode: "2770"',
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

describe("receipt-backed managed state cleanup", () => {
  it("derives and removes an external package volume from its pinned manifest", () => {
    const installed = installFuturePackage();
    const context = {
      agentName: "future-harness",
      harnessPackage: installed.identity,
      runtimeProviderId: "docker",
      sandboxName: "alpha",
      workloadKind: "managed-image",
    } as const;
    const docker = createHermesStateVolumeDockerHarness();
    const deps = { packageStoreRoot: storeRoot, runDocker: docker.runDocker as never };
    const prepared = prepareManagedAgentStateVolumeCleanup(context, deps);

    expect(prepared.roots).toEqual([
      expect.objectContaining({
        mountTarget: "/sandbox/.future",
        resourceIdentity: "nemoclaw-future-harness-state-v1-alpha",
        uid: 1001,
        gid: 1002,
        mode: 0o2770,
      }),
    ]);
    const scope = prepareManagedStateVolumes(
      { roots: prepared.roots },
      {
        runContainerEngine: docker.runDocker as never,
        registerExitCleanup: () => () => undefined,
      },
    );
    scope?.commit();

    expect(removePreparedManagedAgentStateVolumes(prepared, deps)).toEqual([{ status: "removed" }]);
    expect(docker.volume).toBeNull();
  });

  it("does not fall back to a native Hermes declaration when a receipt is missing", () => {
    const missingReceipt: HarnessPackageIdentity = {
      kind: "agent-runtime",
      id: "hermes",
      packageVersion: "1.0.0",
      contentDigest: "a".repeat(64),
    };
    const docker = createHermesStateVolumeDockerHarness();

    expect(() =>
      prepareManagedAgentStateVolumeCleanup(
        {
          agentName: "hermes",
          harnessPackage: missingReceipt,
          runtimeProviderId: "docker",
          sandboxName: "alpha",
          workloadKind: "managed-image",
        },
        { packageStoreRoot: storeRoot, runDocker: docker.runDocker as never },
      ),
    ).toThrow(/package store|package receipt|package object|integrity/iu);
    expect(docker.calls).toEqual([]);
  });

  it("revalidates the pinned package before removing a prepared volume", () => {
    const installed = installFuturePackage();
    const docker = createHermesStateVolumeDockerHarness();
    const deps = { packageStoreRoot: storeRoot, runDocker: docker.runDocker as never };
    const prepared = prepareManagedAgentStateVolumeCleanup(
      {
        agentName: "future-harness",
        harnessPackage: installed.identity,
        runtimeProviderId: "docker",
        sandboxName: "alpha",
        workloadKind: "managed-image",
      },
      deps,
    );
    fs.rmSync(path.join(storeRoot, "objects", "sha256", installed.identity.contentDigest), {
      recursive: true,
      force: true,
    });

    expect(() => removePreparedManagedAgentStateVolumes(prepared, deps)).toThrow();
    expect(docker.calls).toEqual([]);
  });
});
