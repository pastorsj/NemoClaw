// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  commandEnvironment,
  createPrivateTestHome,
  isolatedNemoClawEnvironment,
  requireIsolatedTestGateway,
  resolveIsolatedHomeDockerHost,
  resolveTestGatewayBinding,
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
    const hostDockerConfig = path.join(fixtureRoot, "host-docker");
    const pluginDirectory = path.join(fixtureRoot, "docker-plugins");
    fs.chmodSync(fixtureRoot, 0o700);
    fs.mkdirSync(hostDockerConfig, { mode: 0o700 });
    fs.mkdirSync(pluginDirectory, { mode: 0o700 });
    fs.writeFileSync(
      path.join(hostDockerConfig, "config.json"),
      JSON.stringify({
        auths: { "registry.example.test": { auth: "must-not-pass" } },
        cliPluginsExtraDirs: [pluginDirectory],
        credsStore: "must-not-pass",
      }),
      { mode: 0o600 },
    );
    fs.symlinkSync(fixtureRoot, aliasPath, "dir");

    try {
      const testHome = createPrivateTestHome("e2e-home-", aliasPath, {
        DOCKER_CONFIG: hostDockerConfig,
        HOME: aliasPath,
      });
      const privateDockerConfigPath = path.join(testHome, ".docker", "config.json");

      expect(testHome.startsWith(`${fs.realpathSync(fixtureRoot)}${path.sep}`)).toBe(true);
      expect(fs.realpathSync(testHome)).toBe(testHome);
      expect(fs.statSync(testHome).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.dirname(privateDockerConfigPath)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(privateDockerConfigPath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(fs.readFileSync(privateDockerConfigPath, "utf8"))).toEqual({
        cliPluginsExtraDirs: [fs.realpathSync(pluginDirectory)],
      });
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
      NEMOCLAW_OPENSHELL_BIN: process.execPath,
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

    const result = isolatedNemoClawEnvironment(
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
      NEMOCLAW_OPENSHELL_BIN: fs.realpathSync(process.execPath),
      XDG_BIN_HOME: "/Users/tester/.nemoclaw-e2e-home/.local/bin",
      XDG_CONFIG_HOME: "/Users/tester/.nemoclaw-e2e-home/.config",
      XDG_DATA_HOME: "/Users/tester/.nemoclaw-e2e-home/.local/share",
      XDG_STATE_HOME: "/Users/tester/.nemoclaw-e2e-home/.local/state",
      DOCKER_CONFIG: "/Users/tester/.nemoclaw-e2e-home/.docker",
    });
    expect(result).not.toHaveProperty("DOCKER_CERT_PATH");
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
      NEMOCLAW_OPENSHELL_BIN: process.execPath,
      REGISTRY_AUTH_TOKEN: "must-not-pass",
    });
  });

  it("separates explicit host OpenShell authority from the private install directory", () => {
    const source = {
      HOME: "/home/tester",
      PATH: "/usr/bin",
      DOCKER_HOST: "unix:///run/user/1000/docker.sock",
      NEMOCLAW_OPENSHELL_BIN: process.execPath,
      XDG_BIN_HOME: "/host/bin",
      XDG_CONFIG_HOME: "/host/config",
      XDG_DATA_HOME: "/host/data",
      XDG_STATE_HOME: "/host/state",
    };

    const result = isolatedNemoClawEnvironment(
      "/home/tester/.nemoclaw-e2e-home",
      {
        HOME: "/untrusted/home",
        NEMOCLAW_OPENSHELL_BIN: "/untrusted/openshell",
        XDG_BIN_HOME: "/untrusted/bin",
        XDG_CONFIG_HOME: "/untrusted/config",
      },
      source,
      vi.fn(),
    );

    expect(result).toMatchObject({
      HOME: "/home/tester/.nemoclaw-e2e-home",
      NEMOCLAW_OPENSHELL_BIN: fs.realpathSync(process.execPath),
      XDG_BIN_HOME: "/home/tester/.nemoclaw-e2e-home/.local/bin",
      XDG_CONFIG_HOME: "/home/tester/.nemoclaw-e2e-home/.config",
      XDG_DATA_HOME: "/home/tester/.nemoclaw-e2e-home/.local/share",
      XDG_STATE_HOME: "/home/tester/.nemoclaw-e2e-home/.local/state",
    });
    expect(result).not.toHaveProperty("XDG_RUNTIME_DIR");
  });

  it.each([
    ["HOME", { HOME: "relative-home", NEMOCLAW_OPENSHELL_BIN: process.execPath }],
    [
      "NEMOCLAW_OPENSHELL_BIN",
      { HOME: "/home/tester", NEMOCLAW_OPENSHELL_BIN: "relative-openshell" },
    ],
  ])("rejects a non-absolute host %s", (_selector, source) => {
    expect(() =>
      isolatedNemoClawEnvironment(
        "/home/tester/.nemoclaw-e2e-home",
        {},
        { PATH: "/usr/bin", DOCKER_HOST: "unix:///run/docker.sock", ...source },
        vi.fn(),
      ),
    ).toThrow(/absolute|must be absolute/);
  });

  it("resolves OpenShell from the outer PATH while keeping private install paths first", () => {
    const fixtureParent = path.join(process.cwd(), "node_modules/.cache");
    fs.mkdirSync(fixtureParent, { recursive: true });
    const fixtureRoot = fs.mkdtempSync(path.join(fixtureParent, "nemoclaw-openshell-path-"));
    const openshellPath = path.join(fixtureRoot, "openshell");
    fs.writeFileSync(openshellPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    try {
      const home = "/home/tester/.nemoclaw-e2e-home";
      const result = isolatedNemoClawEnvironment(
        home,
        {},
        {
          HOME: "/home/tester",
          PATH: `${fixtureRoot}${path.delimiter}/usr/bin`,
          DOCKER_HOST: "unix:///run/user/1000/docker.sock",
        },
        vi.fn(),
      );

      expect(result.NEMOCLAW_OPENSHELL_BIN).toBe(fs.realpathSync(openshellPath));
      expect(result.XDG_BIN_HOME).toBe(path.join(home, ".local", "bin"));
      expect(result.PATH?.split(path.delimiter)).toEqual([
        path.join(home, ".local", "bin"),
        path.join(home, ".npm-global", "bin"),
        fixtureRoot,
        "/usr/bin",
      ]);
    } finally {
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("derives the canonical gateway name from an explicit test port", () => {
    expect(
      resolveTestGatewayBinding({
        NEMOCLAW_GATEWAY_PORT: "18089",
        OPENSHELL_GATEWAY: "nemoclaw-18089",
      }),
    ).toEqual({
      environment: {
        NEMOCLAW_GATEWAY_PORT: "18089",
        OPENSHELL_GATEWAY: "nemoclaw-18089",
      },
      name: "nemoclaw-18089",
    });
  });

  it("rejects a gateway name that does not match its explicit port", () => {
    expect(() =>
      resolveTestGatewayBinding({
        NEMOCLAW_GATEWAY_PORT: "18089",
        OPENSHELL_GATEWAY: "nemoclaw",
      }),
    ).toThrow("OPENSHELL_GATEWAY must be nemoclaw-18089");
  });

  it.each([{}, { NEMOCLAW_GATEWAY_PORT: "8080" }])(
    "requires a non-default gateway for stateful local E2E (%j)",
    (source) => {
      expect(() => requireIsolatedTestGateway(source)).toThrow(
        "requires a non-default NEMOCLAW_GATEWAY_PORT",
      );
    },
  );

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
