// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  readSandboxCreateDeclaration,
  sandboxCreateDockerUlimits,
  supportsSandboxStartupControl,
} from "./sandbox-create";

describe("sandbox create manifest declarations", () => {
  it("reads bounded startup controls and Docker limits for an unknown package", () => {
    const source = {
      startup_controls: ["approval-mode", "observability"],
      docker_ulimits: [{ name: "nofile", soft: 4096, hard: 8192 }],
    };
    const declaration = readSandboxCreateDeclaration({ sandbox_create: source });

    expect(declaration).toEqual(source);
    expect(Object.isFrozen(declaration)).toBe(true);
    expect(Object.isFrozen(declaration?.startup_controls)).toBe(true);
    expect(Object.isFrozen(declaration?.docker_ulimits)).toBe(true);
    expect(supportsSandboxStartupControl({ sandbox_create: declaration }, "observability")).toBe(
      true,
    );
    expect(sandboxCreateDockerUlimits({ sandbox_create: declaration })).toEqual(
      source.docker_ulimits,
    );
  });

  it("rejects unknown controls, duplicate limits, and inverted ranges", () => {
    expect(() =>
      readSandboxCreateDeclaration({
        sandbox_create: { startup_controls: ["native-hook"] },
      }),
    ).toThrow("startup_controls");
    expect(() =>
      readSandboxCreateDeclaration({
        sandbox_create: {
          docker_ulimits: [
            { name: "nofile", soft: 1, hard: 2 },
            { name: "nofile", soft: 2, hard: 3 },
          ],
        },
      }),
    ).toThrow("duplicate limit names");
    expect(() =>
      readSandboxCreateDeclaration({
        sandbox_create: { docker_ulimits: [{ name: "nofile", soft: 2, hard: 1 }] },
      }),
    ).toThrow("hard");
  });

  it("returns detached Docker limit plans", () => {
    const declaration = readSandboxCreateDeclaration({
      sandbox_create: { docker_ulimits: [{ name: "nproc", soft: 512, hard: 512 }] },
    });
    const first = sandboxCreateDockerUlimits({ sandbox_create: declaration });
    const second = sandboxCreateDockerUlimits({ sandbox_create: declaration });

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
  });
});
