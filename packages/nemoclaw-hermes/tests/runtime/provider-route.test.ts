// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readHermesBuildSettings } from "../../config/build-env.ts";

const SECRET_BOUNDARY_VALIDATOR = path.resolve(
  import.meta.dirname,
  "../..",
  "runtime",
  "env-boundary.py",
);

describe("inference provider route identifier rename (#7177)", () => {
  it("reads the route identifier from NEMOCLAW_INFERENCE_PROVIDER_ID", () => {
    const settings = readHermesBuildSettings({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_PROVIDER_ID: "openai",
    } as NodeJS.ProcessEnv);
    expect(settings.providerKey).toBe("openai");
  });

  it("falls back to the legacy NEMOCLAW_PROVIDER_KEY name", () => {
    const settings = readHermesBuildSettings({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_PROVIDER_KEY: "openai",
    } as NodeJS.ProcessEnv);
    expect(settings.providerKey).toBe("openai");
  });

  it("prefers NEMOCLAW_INFERENCE_PROVIDER_ID over the legacy name", () => {
    const settings = readHermesBuildSettings({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_PROVIDER_ID: "openai",
      NEMOCLAW_PROVIDER_KEY: "anthropic",
    } as NodeJS.ProcessEnv);
    expect(settings.providerKey).toBe("openai");
  });
});

describe("Hermes runtime provider route identifier boundary (#7177)", () => {
  function runRuntimeEnvValidator(env: Record<string, string>) {
    return spawnSync("python3", [SECRET_BOUNDARY_VALIDATOR, "runtime-env"], {
      encoding: "utf-8",
      timeout: 5000,
      env: {
        HOME: os.tmpdir(),
        PATH: process.env.PATH ?? "",
        HERMES_HOME: "/sandbox/.hermes",
        HERMES_BUNDLED_PLUGINS: "/opt/hermes/plugins",
        HERMES_LAZY_INSTALL_TARGET: "/sandbox/.hermes/lazy-packages",
        ...env,
      },
    });
  }

  it("allows the non-secret NEMOCLAW_INFERENCE_PROVIDER_ID metadata", () => {
    const result = runRuntimeEnvValidator({
      NEMOCLAW_INFERENCE_PROVIDER_ID: "openai",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("still rejects unrelated raw secrets without printing their value", () => {
    const rawSecret = "raw-value";
    const result = runRuntimeEnvValidator({
      NEMOCLAW_INFERENCE_PROVIDER_ID: "openai",
      EXAMPLE_SECRET: rawSecret,
    });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("EXAMPLE_SECRET");
    expect(result.stderr).not.toContain(rawSecret);
  });
});
