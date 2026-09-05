// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  buildRebuildHermesChildEnv,
  buildRebuildHermesRecreateEnv,
  createRebuildHermesEnvFactory,
} from "../live/rebuild-hermes-env.ts";

const preparedRef = "nemoclaw-hermes-sandbox-base-local:e2e-current";

describe("rebuild-Hermes child environment", () => {
  it("keeps the default rebuild free of a base-image override (#10903)", () => {
    const childEnv = buildRebuildHermesChildEnv(
      {},
      buildRebuildHermesRecreateEnv("fixture-discord-token"),
    );

    expect(childEnv.NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF).toBeUndefined();
  });

  it("forwards only supported OpenShell compatibility inputs (#7144)", () => {
    const childEnv = buildRebuildHermesChildEnv(
      {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        BUILDX_BUILDER: "external-builder",
        COMPATIBLE_API_KEY: "must-not-reach-child",
        NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL: "1",
        NEMOCLAW_OPENSHELL_CHANNEL: "dev",
        NVIDIA_API_KEY: "must-not-reach-child",
        NVIDIA_INFERENCE_API_KEY: "must-not-reach-child",
      },
      {},
    );

    expect(childEnv.NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL).toBe("1");
    expect(childEnv.NEMOCLAW_OPENSHELL_CHANNEL).toBe("dev");
    expect(childEnv.COMPATIBLE_API_KEY).toBeUndefined();
    expect(childEnv.NVIDIA_API_KEY).toBeUndefined();
    expect(childEnv.NVIDIA_INFERENCE_API_KEY).toBeUndefined();
    expect(childEnv.BUILDX_BUILDER).toBeUndefined();
  });

  it("retains the private state roots and canonical per-port gateway", () => {
    const childEnv = buildRebuildHermesChildEnv(
      {
        HOME: "/home/tester/.nemoclaw-e2e-hermes",
        NEMOCLAW_GATEWAY_PORT: "18125",
        OPENSHELL_GATEWAY: "nemoclaw-18125",
        PATH: "/usr/bin",
        XDG_BIN_HOME: "/home/tester/.local/bin",
        XDG_CONFIG_HOME: "/home/tester/.nemoclaw-e2e-hermes/.config",
        XDG_DATA_HOME: "/home/tester/.nemoclaw-e2e-hermes/.local/share",
        XDG_STATE_HOME: "/home/tester/.nemoclaw-e2e-hermes/.local/state",
      },
      {},
    );

    expect(childEnv).toMatchObject({
      HOME: "/home/tester/.nemoclaw-e2e-hermes",
      NEMOCLAW_GATEWAY_PORT: "18125",
      OPENSHELL_GATEWAY: "nemoclaw-18125",
      XDG_BIN_HOME: "/home/tester/.local/bin",
      XDG_CONFIG_HOME: "/home/tester/.nemoclaw-e2e-hermes/.config",
      XDG_DATA_HOME: "/home/tester/.nemoclaw-e2e-hermes/.local/share",
      XDG_STATE_HOME: "/home/tester/.nemoclaw-e2e-hermes/.local/state",
    });
  });

  it("builds isolated rebuild environments with caller overlays and optional credentials", () => {
    const createEnvironment = createRebuildHermesEnvFactory(
      {
        DOCKER_HOST: "unix:///private/run/docker.sock",
        HOME: "/private/rebuild-hermes",
        NEMOCLAW_GATEWAY_PORT: "18135",
        OPENSHELL_GATEWAY: "nemoclaw-18135",
        PATH: "/usr/bin",
        XDG_BIN_HOME: "/private/bin",
        XDG_CONFIG_HOME: "/private/rebuild-hermes/.config",
        XDG_DATA_HOME: "/private/rebuild-hermes/.local/share",
        XDG_STATE_HOME: "/private/rebuild-hermes/.local/state",
      },
      {
        endpointUrl: "https://inference.example.test/v1",
        model: "fixture-model",
        openshellBin: "/private/bin/openshell",
        sandboxName: "hermes-e2e",
      },
    );

    const withoutCredentials = createEnvironment(undefined, {
      NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF: preparedRef,
    });

    expect(withoutCredentials).toMatchObject({
      DOCKER_HOST: "unix:///private/run/docker.sock",
      HOME: "/private/rebuild-hermes",
      NEMOCLAW_ENDPOINT_URL: "https://inference.example.test/v1",
      NEMOCLAW_GATEWAY_PORT: "18135",
      NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF: preparedRef,
      NEMOCLAW_MODEL: "fixture-model",
      NEMOCLAW_OPENSHELL_BIN: "/private/bin/openshell",
      NEMOCLAW_SANDBOX_NAME: "hermes-e2e",
      OPENSHELL_GATEWAY: "nemoclaw-18135",
      XDG_BIN_HOME: "/private/bin",
      XDG_CONFIG_HOME: "/private/rebuild-hermes/.config",
      XDG_DATA_HOME: "/private/rebuild-hermes/.local/share",
      XDG_STATE_HOME: "/private/rebuild-hermes/.local/state",
    });
    expect(withoutCredentials.COMPATIBLE_API_KEY).toBeUndefined();
    expect(withoutCredentials.NVIDIA_INFERENCE_API_KEY).toBeUndefined();

    expect(createEnvironment("fixture-api-key")).toMatchObject({
      COMPATIBLE_API_KEY: "fixture-api-key",
      NVIDIA_INFERENCE_API_KEY: "fixture-api-key",
    });
  });

  it("forwards the Discord credential needed to replace the legacy rebuild provider (#10155)", () => {
    const childEnv = buildRebuildHermesChildEnv(
      {
        COMPATIBLE_API_KEY: "must-not-reach-child",
        NVIDIA_API_KEY: "must-not-reach-child",
        NVIDIA_INFERENCE_API_KEY: "must-not-reach-child",
      },
      buildRebuildHermesRecreateEnv("fixture-discord-token", {
        NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF: preparedRef,
      }),
    );

    expect(childEnv.DISCORD_BOT_TOKEN).toBe("fixture-discord-token");
    expect(childEnv.NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF).toBe(preparedRef);
    expect(childEnv.NEMOCLAW_REBUILD_VERBOSE).toBe("1");
    expect(childEnv.COMPATIBLE_API_KEY).toBeUndefined();
    expect(childEnv.NVIDIA_API_KEY).toBeUndefined();
    expect(childEnv.NVIDIA_INFERENCE_API_KEY).toBeUndefined();
  });
});
