// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  commandEnvironment,
  createPrivateTestHome,
  isolatedHomeEnvironment,
  resolveIsolatedHomeDockerHost,
  sandboxCommandEnvironment,
  testHomeEnvironment,
} from "../fixtures/environment-profiles.ts";

describe("E2E environment profiles", () => {
  it("filters the source and lets caller overrides win without mutation", () => {
    const source = {
      PATH: "/usr/bin",
      OPENSHELL_GATEWAY: "source-gateway",
      UNRELATED_SECRET: "must-not-pass",
    };
    const extra = {
      NEMOCLAW_NON_INTERACTIVE: "override",
      NVIDIA_INFERENCE_API_KEY: "test-secret-overlay",
    };

    const result = commandEnvironment(extra, source);

    expect(result).toMatchObject({
      PATH: "/usr/bin",
      NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
      NEMOCLAW_NON_INTERACTIVE: "override",
      NVIDIA_INFERENCE_API_KEY: "test-secret-overlay",
      OPENSHELL_GATEWAY: "source-gateway",
    });
    expect(result.UNRELATED_SECRET).toBeUndefined();
    expect(source).toEqual({
      PATH: "/usr/bin",
      OPENSHELL_GATEWAY: "source-gateway",
      UNRELATED_SECRET: "must-not-pass",
    });
  });

  it("centralizes test HOME CLI paths with caller precedence", () => {
    const home = path.join(path.sep, "tmp", "nemoclaw-test-home");
    const result = testHomeEnvironment(home, { HOME: "/override-home" }, { PATH: "/usr/bin" });

    expect(result.HOME).toBe("/override-home");
    expect(result.PATH?.split(path.delimiter)).toEqual([
      path.join(home, ".local", "bin"),
      path.join(home, ".npm-global", "bin"),
      "/usr/bin",
    ]);
  });

  it("creates a private canonical HOME beneath a real user-owned parent", () => {
    const fixtureParent = path.join(
      process.cwd(),
      "node_modules/.cache/nemoclaw-private-test-home",
    );
    fs.mkdirSync(fixtureParent, { recursive: true, mode: 0o700 });
    fs.chmodSync(fixtureParent, 0o700);
    const fixtureRoot = fs.mkdtempSync(path.join(fixtureParent, "fixture-"));
    const aliasPath = path.join(fixtureParent, `alias-${path.basename(fixtureRoot)}`);
    fs.chmodSync(fixtureRoot, 0o700);
    fs.symlinkSync(fixtureRoot, aliasPath, "dir");

    try {
      const testHome = createPrivateTestHome("e2e-home-", aliasPath);

      expect(testHome.startsWith(`${fs.realpathSync(fixtureRoot)}${path.sep}`)).toBe(true);
      expect(fs.realpathSync(testHome)).toBe(testHome);
      expect(fs.statSync(testHome).mode & 0o777).toBe(0o700);
    } finally {
      fs.unlinkSync(aliasPath);
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("binds the active local Docker endpoint before replacing HOME", () => {
    const source = {
      PATH: "/usr/bin",
      HOME: "/Users/tester",
      DOCKER_CERT_PATH: "/Users/tester/.docker/certs",
      DOCKER_CONFIG: "/Users/tester/.docker",
      DOCKER_CONTEXT: "colima",
      DOCKER_TLS_VERIFY: "1",
      REGISTRY_AUTH_TOKEN: "must-not-pass",
    };
    const inspect = vi.fn((_args: readonly string[], env: NodeJS.ProcessEnv) => {
      expect(env.HOME).toBe(source.HOME);
      expect(env.DOCKER_CONTEXT).toBe(source.DOCKER_CONTEXT);
      return {
        status: 0,
        stdout: `${JSON.stringify("unix:///Users/tester/.colima/default/docker.sock")}\n`,
      };
    });

    const result = isolatedHomeEnvironment(
      "/Users/tester/.nemoclaw-e2e-home",
      {
        DOCKER_CONFIG: "/tmp/untrusted-docker-config",
        DOCKER_CONTEXT: "untrusted-context",
        DOCKER_HOST: "tcp://untrusted.example.test:2375",
      },
      source,
      inspect,
    );

    expect(inspect).toHaveBeenCalledWith(
      ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
      expect.any(Object),
    );
    expect(result).toMatchObject({
      HOME: "/Users/tester/.nemoclaw-e2e-home",
      DOCKER_HOST: "unix:///Users/tester/.colima/default/docker.sock",
    });
    expect(result).not.toHaveProperty("DOCKER_CERT_PATH");
    expect(result).not.toHaveProperty("DOCKER_CONFIG");
    expect(result).not.toHaveProperty("DOCKER_CONTEXT");
    expect(result).not.toHaveProperty("DOCKER_TLS_VERIFY");
    expect(result).not.toHaveProperty("REGISTRY_AUTH_TOKEN");
    expect(source).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/tester",
      DOCKER_CERT_PATH: "/Users/tester/.docker/certs",
      DOCKER_CONFIG: "/Users/tester/.docker",
      DOCKER_CONTEXT: "colima",
      DOCKER_TLS_VERIFY: "1",
      REGISTRY_AUTH_TOKEN: "must-not-pass",
    });
  });

  it("keeps an explicit safe Docker host without reading context metadata", () => {
    const inspect = vi.fn();

    expect(
      resolveIsolatedHomeDockerHost(
        {
          DOCKER_CONTEXT: "ignored-context",
          DOCKER_HOST: "  unix:///Users/tester/.docker/run/docker.sock  ",
        },
        inspect,
      ),
    ).toBe("unix:///Users/tester/.docker/run/docker.sock");
    expect(inspect).not.toHaveBeenCalled();
  });

  it("rejects an unsafe explicit Docker host before replacing HOME", () => {
    expect(() =>
      resolveIsolatedHomeDockerHost({ DOCKER_HOST: "unix:///tmp/docker.sock\n" }, vi.fn()),
    ).toThrow("Isolated E2E HOME requires an absolute local unix:// Docker endpoint");
  });

  it.each([
    ["empty output", ""],
    ["malformed JSON", "not-json"],
    ["an SSH endpoint", JSON.stringify("ssh://docker.example.test")],
    ["a TCP endpoint", JSON.stringify("tcp://docker.example.test:2375")],
    ["a relative Unix socket", JSON.stringify("unix://relative/docker.sock")],
    ["a quoted Unix socket", JSON.stringify("unix:///tmp/docker's.sock")],
    ["a multiline Unix socket", JSON.stringify("unix:///tmp/docker.sock\n")],
  ])("rejects %s for an isolated HOME", (_case, stdout) => {
    expect(() =>
      resolveIsolatedHomeDockerHost({ HOME: "/Users/tester", PATH: "/usr/bin" }, () => ({
        status: 0,
        stdout,
      })),
    ).toThrow(/Docker context endpoint is unreadable|absolute local unix:\/\//);
  });

  it("fails closed when Docker context inspection does not complete", () => {
    expect(() =>
      resolveIsolatedHomeDockerHost({ HOME: "/Users/tester", PATH: "/usr/bin" }, () => ({
        status: 1,
        stdout: "",
      })),
    ).toThrow("Could not resolve the active Docker context before isolating E2E HOME");
  });

  it("composes sandbox identity and secret-bearing overlays", () => {
    const result = sandboxCommandEnvironment(
      "e2e-profile",
      {
        COMPATIBLE_API_KEY: "compatible-secret",
        NEMOCLAW_RECREATE_SANDBOX: "0",
      },
      { PATH: "/usr/bin" },
    );

    expect(result).toMatchObject({
      COMPATIBLE_API_KEY: "compatible-secret",
      NEMOCLAW_RECREATE_SANDBOX: "0",
      NEMOCLAW_SANDBOX_NAME: "e2e-profile",
      OPENSHELL_GATEWAY: "nemoclaw",
    });
  });
});
