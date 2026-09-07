// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { AgentDefinition } from "../agent/defs";
import type { DockerUlimit } from "./docker-gpu-patch-types";
import {
  DCODE_DOCKER_ULIMITS,
  resolveDockerStartupCommandPatch,
} from "./docker-startup-command-agent";
import { resolveAgentCreateInput } from "./sandbox-gpu-create-flow";

const PORTABLE_ENV: NodeJS.ProcessEnv = { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" };
const DEFAULT_ENV: NodeJS.ProcessEnv = {};

const legacyAgent = (name: string) => ({ name }) as AgentDefinition;

const packageAgent = (
  name: string,
  layout: "artifact" | "source" = "artifact",
  requiredUlimits: readonly DockerUlimit[] = [],
) => {
  const packageRoot = `/var/lib/nemoclaw/harnesses/objects/${"a".repeat(64)}`;
  const manifestPath =
    layout === "source"
      ? `${packageRoot}/manifest.yaml`
      : `${packageRoot}/packages/nemoclaw-${name}/manifest.yaml`;
  return {
    name,
    packageRoot,
    manifestPath,
    ...(requiredUlimits.length > 0 ? { sandbox_create: { docker_ulimits: requiredUlimits } } : {}),
  } as AgentDefinition;
};

describe("resolveDockerStartupCommandPatch", () => {
  it.each(["openclaw", "hermes", "langchain-deepagents-code"])(
    "keeps restart-safe persistence for %s on a default-profile docker-driver gateway",
    (name) => {
      expect(resolveDockerStartupCommandPatch(legacyAgent(name), true, DEFAULT_ENV)).toMatchObject({
        persistStartupCommand: true,
      });
    },
  );

  it.each(["openclaw", "hermes", "langchain-deepagents-code"])(
    "disables the Docker restart-safe recreation for %s under the portable profile (#9462)",
    (name) => {
      expect(resolveDockerStartupCommandPatch(legacyAgent(name), true, PORTABLE_ENV)).toMatchObject(
        {
          persistStartupCommand: false,
        },
      );
    },
  );

  it("keeps the DCode ulimit contract visible under the portable profile", () => {
    expect(
      resolveDockerStartupCommandPatch(legacyAgent("langchain-deepagents-code"), true, PORTABLE_ENV)
        .requiredUlimits,
    ).toEqual(DCODE_DOCKER_ULIMITS);
  });

  it("reads DCode Docker limits from its package declaration without an ID branch", () => {
    expect(
      resolveDockerStartupCommandPatch(
        packageAgent("langchain-deepagents-code", "artifact", DCODE_DOCKER_ULIMITS),
        true,
        PORTABLE_ENV,
      ).requiredUlimits,
    ).toEqual(DCODE_DOCKER_ULIMITS);
  });

  it("reads Docker limits for an unknown package ID", () => {
    const declared = [{ name: "nofile", soft: 4096, hard: 8192 }] as const;
    expect(
      resolveDockerStartupCommandPatch(
        packageAgent("future-harness", "artifact", declared),
        true,
        DEFAULT_ENV,
      ).requiredUlimits,
    ).toEqual(declared);
  });

  it.each(["artifact", "source"] as const)(
    "persists the startup command for a package-backed %s layout without a core name branch",
    (layout) => {
      expect(
        resolveDockerStartupCommandPatch(packageAgent("future-harness", layout), true, DEFAULT_ENV),
      ).toEqual({
        persistStartupCommand: true,
        requiredUlimits: null,
      });
    },
  );

  it("keeps an unknown legacy definition out of the OpenClaw persistence path", () => {
    expect(
      resolveDockerStartupCommandPatch(legacyAgent("future-harness"), true, DEFAULT_ENV),
    ).toEqual({
      persistStartupCommand: false,
      requiredUlimits: null,
    });
  });

  it("keeps a package-backed definition off Docker recreation under the portable profile", () => {
    expect(
      resolveDockerStartupCommandPatch(packageAgent("future-harness"), true, PORTABLE_ENV),
    ).toEqual({
      persistStartupCommand: false,
      requiredUlimits: null,
    });
  });

  it("stays fully disabled off the docker-driver gateway regardless of profile", () => {
    expect(resolveDockerStartupCommandPatch(legacyAgent("hermes"), false, PORTABLE_ENV)).toEqual({
      persistStartupCommand: false,
      requiredUlimits: null,
    });
    expect(resolveDockerStartupCommandPatch(legacyAgent("hermes"), false, DEFAULT_ENV)).toEqual({
      persistStartupCommand: false,
      requiredUlimits: null,
    });
  });

  it("treats a missing agent as OpenClaw for the portable gate", () => {
    expect(resolveDockerStartupCommandPatch(null, true, PORTABLE_ENV)).toMatchObject({
      persistStartupCommand: false,
    });
    expect(resolveDockerStartupCommandPatch(null, true, DEFAULT_ENV)).toMatchObject({
      persistStartupCommand: true,
    });
  });
});

describe("resolveAgentCreateInput portable persistence", () => {
  it("keeps portable non-OpenClaw agents off the Docker recreation path (#9462)", () => {
    expect(resolveAgentCreateInput(legacyAgent("hermes"), true, PORTABLE_ENV)).toMatchObject({
      portableLifecycle: false,
      persistStartupCommand: false,
    });
    expect(
      resolveAgentCreateInput(legacyAgent("langchain-deepagents-code"), true, PORTABLE_ENV),
    ).toMatchObject({
      portableLifecycle: false,
      persistStartupCommand: false,
    });
  });
});
