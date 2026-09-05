// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { managedStartupStateRoots, managedStartupWorkspaceRoot } from "./state-roots";

describe("managed startup package layout", () => {
  it("projects a future harness declaration without a core harness catalogue", () => {
    const managedImage = {
      runtime_identity: { uid: 1234, gid: 1235, workdir: "/sandbox" },
      workspace: { owner: "root", mode: "1775" },
      state_root: { mount_target: "/sandbox/.future-harness", mode: "2770" },
    } as const;

    expect(managedStartupWorkspaceRoot({ managedImage })).toEqual({
      uid: 0,
      gid: 1235,
      mode: 0o1775,
    });
    const roots = managedStartupStateRoots({
      packageId: "future-harness",
      sandboxName: "alpha",
      managedImage,
    });
    expect(roots).toEqual([
      {
        mountTarget: "/sandbox/.future-harness",
        resourceIdentity: "nemoclaw-future-harness-state-v1-alpha",
        ownershipLabels: {
          "io.nvidia.nemoclaw.future-harness-state.managed": "true",
          "io.nvidia.nemoclaw.future-harness-state.schema": "1",
          "io.nvidia.nemoclaw.future-harness-state.sandbox": "alpha",
          "io.nvidia.nemoclaw.future-harness-state.target": "/sandbox/.future-harness",
        },
        uid: 1234,
        gid: 1235,
        mode: 0o2770,
        readWrite: true,
      },
    ]);
    expect(Object.isFrozen(roots)).toBe(true);
    expect(Object.isFrozen(roots[0])).toBe(true);
    expect(Object.isFrozen(roots[0]?.ownershipLabels)).toBe(true);
  });

  it("uses the safe workspace default and no durable roots when both are omitted", () => {
    const managedImage = {
      runtime_identity: { uid: 1234, gid: 1235, workdir: "/sandbox" },
    } as const;

    expect(managedStartupWorkspaceRoot({ managedImage })).toEqual({
      uid: 1234,
      gid: 1235,
      mode: 0o755,
    });
    const roots = managedStartupStateRoots({
      packageId: "future-harness",
      sandboxName: "alpha",
      managedImage,
    });
    expect(roots).toEqual([]);
    expect(Object.isFrozen(roots)).toBe(true);
  });
});
