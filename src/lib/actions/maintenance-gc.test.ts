// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listSandboxes: vi.fn(),
  dockerListImagesFormat: vi.fn().mockReturnValue(""),
  dockerRmi: vi.fn(),
  assertNoHermesPortableHostAuthority: vi.fn(),
  withPortableHostFence: vi.fn(),
}));

vi.mock("../state/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/registry")>()),
  listSandboxes: mocks.listSandboxes,
}));
vi.mock("../state/portable-uninstall-retirement", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/portable-uninstall-retirement")>()),
  assertNoHermesPortableHostAuthority: mocks.assertNoHermesPortableHostAuthority,
  defaultPortableStateDir: (env: NodeJS.ProcessEnv) =>
    env.NEMOCLAW_TEST_STATE_DIR ?? `${env.HOME}/.nemoclaw`,
  withPortableHostFence: mocks.withPortableHostFence,
}));
vi.mock("../adapters/docker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/docker")>()),
  dockerListImagesFormat: mocks.dockerListImagesFormat,
  dockerRmi: mocks.dockerRmi,
}));
vi.mock("../cli/branding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/branding")>()),
  CLI_NAME: "nemoclaw",
}));
vi.mock("../credentials/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../credentials/store")>()),
  prompt: vi.fn(),
}));
vi.mock("../domain/lifecycle/options", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../domain/lifecycle/options")>()),
  normalizeGarbageCollectImagesOptions: (options: unknown) => options || {},
}));

import { garbageCollectImages, shouldSkipUnreachableSandboxBackup } from "./maintenance";

describe("shouldSkipUnreachableSandboxBackup", () => {
  it("is true only for exactly '1'", () => {
    expect(
      shouldSkipUnreachableSandboxBackup({ NEMOCLAW_SKIP_UNREACHABLE_SANDBOX_BACKUP: "1" }),
    ).toBe(true);
    expect(
      shouldSkipUnreachableSandboxBackup({ NEMOCLAW_SKIP_UNREACHABLE_SANDBOX_BACKUP: "0" }),
    ).toBe(false);
    expect(
      shouldSkipUnreachableSandboxBackup({ NEMOCLAW_SKIP_UNREACHABLE_SANDBOX_BACKUP: "true" }),
    ).toBe(false);
    expect(shouldSkipUnreachableSandboxBackup({})).toBe(false);
  });
});

describe("garbageCollectImages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertNoHermesPortableHostAuthority.mockReset();
    mocks.withPortableHostFence.mockImplementation(async (_home, operation) => operation());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects schema-5 authority before scanning Docker images (#9203)", async () => {
    const stateDir = "/private/nemoclaw-test-state";
    vi.stubEnv("VITEST", "true");
    vi.stubEnv("NEMOCLAW_TEST_BASE_HOME", process.env.HOME ?? "");
    vi.stubEnv("NEMOCLAW_TEST_STATE_DIR", stateDir);
    mocks.assertNoHermesPortableHostAuthority.mockImplementation(() => {
      throw new Error("Command 'gc' is not supported");
    });

    await expect(garbageCollectImages({ dryRun: true })).rejects.toThrow(
      "Command 'gc' is not supported",
    );
    expect(mocks.dockerListImagesFormat).not.toHaveBeenCalled();
    expect(mocks.dockerRmi).not.toHaveBeenCalled();
    expect(mocks.assertNoHermesPortableHostAuthority).toHaveBeenCalledWith(stateDir, "gc");
  });

  it("surfaces a local-repo orphan while preserving a registered local image (#6301)", async () => {
    mocks.dockerListImagesFormat.mockImplementation((repo: string) =>
      repo === "nemoclaw-sandbox-local"
        ? "nemoclaw-sandbox-local:gc-test-orphan-111\t3GB\nnemoclaw-sandbox-local:live-222\t2GB"
        : "openshell/sandbox-from:in-use\t1GB",
    );
    mocks.listSandboxes.mockReturnValue({
      sandboxes: [
        { imageTag: "nemoclaw-sandbox-local:live-222" },
        { imageTag: "openshell/sandbox-from:in-use" },
      ],
      defaultSandbox: null,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await garbageCollectImages({ dryRun: true });

    const out = logSpy.mock.calls.flat().join("\n");
    logSpy.mockRestore();
    expect(out).toContain("nemoclaw-sandbox-local:gc-test-orphan-111");
    expect(out).not.toContain("nemoclaw-sandbox-local:live-222");
    const scannedRepos = mocks.dockerListImagesFormat.mock.calls.map((call) => call[0]);
    expect(scannedRepos).toContain("openshell/sandbox-from");
    expect(scannedRepos).toContain("nemoclaw-sandbox-local");
  });
});
