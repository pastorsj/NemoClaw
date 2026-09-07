// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { AgentDefinition } from "../../agent/defs";
import type { SandboxEntry } from "../../state/registry";
import { finalizeRecreatedSourceState, resolveRecreatedSourceStateRoots } from "./state-cleanup";

const futureAgent = {
  name: "future-harness",
  displayName: "Future Harness",
  description: "Synthetic package used to prove generic state ownership.",
  packageRoot: "/tmp/future-harness",
  manifestPath: "/tmp/future-harness/manifest.yaml",
  managedImage: {
    dockerfile: "Dockerfile",
    contract_version: 1,
    runtime_identity: { uid: 1001, gid: 1001, workdir: "/sandbox" },
    state_root: { mount_target: "/sandbox/.future", mode: "0700" },
  },
} as unknown as AgentDefinition;

const sourceEntry = {
  agent: futureAgent.name,
  workload: { kind: "managed-image" },
} as SandboxEntry;

describe("recreated package state cleanup", () => {
  it("derives a synthetic package volume solely from its pinned definition", () => {
    expect(
      resolveRecreatedSourceStateRoots({
        sandboxName: "alpha",
        sourceAgent: futureAgent,
        sourceEntry,
      }),
    ).toEqual([
      expect.objectContaining({
        mountTarget: "/sandbox/.future",
        resourceIdentity: "nemoclaw-future-harness-state-v1-alpha",
      }),
    ]);
  });

  it("keeps a shared package resource and then removes the source registry row", () => {
    const roots = resolveRecreatedSourceStateRoots({
      sandboxName: "alpha",
      sourceAgent: futureAgent,
      sourceEntry,
    });
    const removeManagedStateVolumes = vi.fn(() => []);
    const removeSourceRegistryEntry = vi.fn();

    finalizeRecreatedSourceState(
      {
        sandboxName: "alpha",
        sourceAgent: futureAgent,
        sourceEntry,
        sourceConfirmedAbsent: true,
        targetRoots: roots,
      },
      {
        removeManagedStateVolumes,
        removeSourceRegistryEntry,
        note: vi.fn(),
        warn: vi.fn(),
        redact: String,
      },
    );

    expect(removeManagedStateVolumes).toHaveBeenCalledWith([]);
    expect(removeSourceRegistryEntry).toHaveBeenCalledWith(sourceEntry, "alpha");
  });

  it("removes an obsolete synthetic package volume before forgetting its registry row", () => {
    const events: string[] = [];
    const removeSourceRegistryEntry = vi.fn(() => events.push("registry"));
    const removeManagedStateVolumes = vi.fn(() => {
      events.push("volume");
      return [{ status: "removed" as const }];
    });

    finalizeRecreatedSourceState(
      {
        sandboxName: "alpha",
        sourceAgent: futureAgent,
        sourceEntry,
        sourceConfirmedAbsent: true,
        targetRoots: [],
      },
      {
        removeManagedStateVolumes,
        removeSourceRegistryEntry,
        note: vi.fn(),
        warn: vi.fn(),
        redact: String,
      },
    );

    expect(events).toEqual(["volume", "registry"]);
  });

  it("preserves registry authority when package state cleanup fails", () => {
    const removeSourceRegistryEntry = vi.fn();

    expect(() =>
      finalizeRecreatedSourceState(
        {
          sandboxName: "alpha",
          sourceAgent: futureAgent,
          sourceEntry,
          sourceConfirmedAbsent: true,
          targetRoots: [],
        },
        {
          removeManagedStateVolumes: () => [
            {
              status: "failed",
              detail: "secret detail",
              volumeName: "nemoclaw-future-harness-state-v1-alpha",
            },
          ],
          removeSourceRegistryEntry,
          note: vi.fn(),
          warn: vi.fn(),
          redact: () => "[REDACTED]",
        },
      ),
    ).toThrow(/future-harness-state-v1-alpha.*\[REDACTED\]/u);
    expect(removeSourceRegistryEntry).not.toHaveBeenCalled();
  });
});
