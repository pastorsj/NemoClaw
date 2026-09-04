// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSandbox: vi.fn(),
  loadConfigAdapter: vi.fn(),
}));

vi.mock("../agent-runtime/config-module", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent-runtime/config-module")>()),
  loadHarnessConfigAdapterHostModule: mocks.loadConfigAdapter,
}));
vi.mock("./agent-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-config")>()),
  getAgentConfigPackageIdentity: (sandboxName: string) =>
    mocks.getSandbox(sandboxName)?.harnessPackage ?? null,
}));

import { HarnessConfigModuleError } from "../agent-runtime/config-module";
import { loadInstalledConfigAdapter } from "./package-config";

const IDENTITY = Object.freeze({
  kind: "agent-runtime" as const,
  id: "future-harness",
  packageVersion: "1.0.0",
  contentDigest: "a".repeat(64),
});
const TARGET = Object.freeze({
  agentName: "future-harness",
  configDir: "/sandbox/.future",
  configPath: "/sandbox/.future/config.json",
  configFile: "config.json",
  format: "json",
  sensitiveFiles: [] as string[],
});
const ADAPTER = Object.freeze({
  prepareConfigUpdate: vi.fn(),
  classifyConfigUrl: vi.fn(),
  describeMutableConfig: vi.fn(),
});

beforeEach(() => {
  mocks.getSandbox.mockReset();
  mocks.loadConfigAdapter.mockReset().mockReturnValue(ADAPTER);
});

describe("installed configuration adapter selection", () => {
  it("returns the adapter together with its exact package receipt", () => {
    mocks.getSandbox.mockReturnValue({ harnessPackage: IDENTITY });

    expect(loadInstalledConfigAdapter("future", TARGET)).toEqual({
      identity: IDENTITY,
      adapter: ADAPTER,
    });
    expect(mocks.loadConfigAdapter).toHaveBeenCalledWith(IDENTITY);
  });

  it("keeps a sandbox without a package receipt on the compatibility path", () => {
    mocks.getSandbox.mockReturnValue({ harnessPackage: null });

    expect(loadInstalledConfigAdapter("legacy", TARGET)).toBeNull();
    expect(mocks.loadConfigAdapter).not.toHaveBeenCalled();
  });

  it("rejects a package receipt for a different agent runtime", () => {
    mocks.getSandbox.mockReturnValue({
      harnessPackage: { ...IDENTITY, id: "different-harness" },
    });

    expect(() => loadInstalledConfigAdapter("future", TARGET)).toThrow(
      /does not match its package agent/u,
    );
    expect(mocks.loadConfigAdapter).not.toHaveBeenCalled();
  });

  it("rejects a package receipt when its fixed adapter module is absent", () => {
    mocks.getSandbox.mockReturnValue({ harnessPackage: IDENTITY });
    mocks.loadConfigAdapter.mockImplementation(() => {
      throw new HarnessConfigModuleError("fixed module is absent", "missing-adapter");
    });

    expect(() => loadInstalledConfigAdapter("future", TARGET)).toThrow(/fixed module is absent/u);
  });

  it("propagates integrity and schema failures from a present adapter", () => {
    mocks.getSandbox.mockReturnValue({ harnessPackage: IDENTITY });
    mocks.loadConfigAdapter.mockImplementation(() => {
      throw new HarnessConfigModuleError("adapter integrity validation failed");
    });

    expect(() => loadInstalledConfigAdapter("future", TARGET)).toThrow(
      /adapter integrity validation failed/u,
    );
  });
});
