// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HarnessConfigAdapterHostModule } from "../agent-runtime/config-module";

const clientModulePath = require.resolve("../adapters/openshell/client");
const configModulePath = require.resolve("./config");
const client = require(clientModulePath) as {
  captureOpenshellCommand: (...args: unknown[]) => {
    status: number;
    signal: null;
    stdout: string;
    output: string;
    stderr: string;
  };
};
const realCapture = client.captureOpenshellCommand;

const TARGET: import("./config").AgentConfigTarget = {
  agentName: "future-harness",
  configPath: "/sandbox/.future/config.json",
  configDir: "/sandbox/.future",
  configFile: "config.json",
  format: "json",
};

function loadConfigModule(): typeof import("./config") {
  delete require.cache[configModulePath];
  return require(configModulePath) as typeof import("./config");
}

describe("sandbox config read authority", () => {
  afterEach(() => {
    client.captureOpenshellCommand = realCapture;
    delete require.cache[configModulePath];
  });

  it("carries the private read digest across a JSON-only adapter result", () => {
    client.captureOpenshellCommand = () => ({
      status: 0,
      signal: null,
      stdout: '{"model":"old"}\n',
      output: '{"model":"old"}\n',
      stderr: "",
    });
    const { preserveConfigReadAuthority, readSandboxConfig } = loadConfigModule();
    const source = readSandboxConfig("alpha", TARGET);
    const candidate = { model: "new" };

    const authorized = preserveConfigReadAuthority(source, candidate);

    expect(authorized).toEqual(candidate);
    expect(authorized).not.toBe(candidate);
    expect(Object.getOwnPropertySymbols(authorized)).toHaveLength(1);
    expect(Object.getOwnPropertySymbols(authorized)).toEqual(Object.getOwnPropertySymbols(source));
    expect(Object.keys(authorized)).toEqual(["model"]);
  });

  it("does not let an adapter manufacture read authority", () => {
    const { preserveConfigReadAuthority } = loadConfigModule();

    expect(() => preserveConfigReadAuthority({ model: "old" }, { model: "new" })).toThrow(
      /matching read/u,
    );
  });

  it("carries the exact read digest into receipt-backed write preparation", () => {
    const rawConfig = '{"model":"old"}\n';
    client.captureOpenshellCommand = () => ({
      status: 0,
      signal: null,
      stdout: rawConfig,
      output: rawConfig,
      stderr: "",
    });
    const { preparePackageConfigCandidate, preserveConfigReadAuthority, readSandboxConfig } =
      loadConfigModule();
    const source = readSandboxConfig("alpha", TARGET);
    const authorized = preserveConfigReadAuthority(source, { model: "new" });
    const prepareConfigUpdate = vi.fn<HarnessConfigAdapterHostModule["prepareConfigUpdate"]>(
      (request) => ({
        kind: "transaction",
        content: request.serializedConfig,
        validation: null,
        write: {
          command: ["/usr/local/lib/future/write-config"],
          timeoutSeconds: 10,
          failureMessage: "Future runtime config write failed.",
          success: { kind: "exit-zero" },
        },
        restart: { kind: "external", guidance: [] },
      }),
    );
    const adapter: HarnessConfigAdapterHostModule = {
      describeInferenceConfig: vi.fn(() => ({
        kind: "mutable" as const,
        providerApiOverrides: [],
      })),
      prepareInferenceConfig: vi.fn(() => ({
        kind: "unsupported" as const,
        reason: "Not used by this boundary test.",
      })),
      prepareConfigUpdate,
      classifyConfigUrl: vi.fn(() => ({
        allowPrivateUrls: false,
        allowOpenShellBridge: false,
      })),
      describeMutableConfig: vi.fn(() => ({
        kind: "not-required" as const,
        reason: "Not used by this boundary test.",
      })),
    };
    const identity = {
      kind: "agent-runtime" as const,
      id: TARGET.agentName,
      packageVersion: "1.0.0",
      contentDigest: "a".repeat(64),
    };

    const prepared = preparePackageConfigCandidate("alpha", TARGET, authorized, undefined, {
      identity,
      adapter,
    });

    expect(prepared).toMatchObject({
      selection: { identity },
      plan: { kind: "transaction" },
    });
    expect(prepareConfigUpdate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        config: authorized,
        expectedConfigSha256: createHash("sha256").update(rawConfig).digest("hex"),
      }),
    );
  });
});
