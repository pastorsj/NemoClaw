// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeAgent } from "../../../test/helpers/base-image-test-harness";

const mocks = vi.hoisted(() => ({
  dockerCapture: vi.fn(),
  dockerInfoFormat: vi.fn(),
}));

vi.mock("../adapters/docker", () => ({
  dockerCapture: mocks.dockerCapture,
  dockerInfoFormat: mocks.dockerInfoFormat,
}));

import { createSandboxBaseImageResolutionKey } from "../sandbox-base-image/resolution-key";

import {
  createDeepAgentsCodeBaseImageResolutionOptions,
  deepAgentsCodeBaseImageHasFabricRuntime,
  deepAgentsCodeBaseImageMatchesVersion,
} from "./deep-agents-code-base-image";

const ACTIVE_DCODE_PACKAGE_ROOT = path.resolve(
  import.meta.dirname,
  "../../../packages/nemoclaw-langchain-deepagents-code",
);
const ACTIVE_DCODE_DOCKERFILE = path.join(ACTIVE_DCODE_PACKAGE_ROOT, "Dockerfile.base");
const ACTIVE_FABRIC_PROBE = path.join(ACTIVE_DCODE_PACKAGE_ROOT, "checks", "fabric-runtime.py");
const ACTIVE_FABRIC_PROBE_OUTPUT = `nemoclaw-dcode-fabric-runtime-ok ${createHash("sha256")
  .update(fs.readFileSync(ACTIVE_FABRIC_PROBE))
  .digest("hex")}`;

describe("Deep Agents Code base image compatibility", () => {
  beforeEach(() => {
    mocks.dockerCapture.mockReset();
    mocks.dockerInfoFormat.mockReset();
    mocks.dockerInfoFormat.mockReturnValue("linux/amd64");
  });

  it("accepts only the exact installed distribution version (#6456)", () => {
    mocks.dockerCapture.mockReturnValueOnce("0.1.55\n").mockReturnValueOnce("0.1.12\n");

    expect(deepAgentsCodeBaseImageMatchesVersion("dcode-base:current", "0.1.55")).toBe(true);
    expect(deepAgentsCodeBaseImageMatchesVersion("dcode-base:stale", "0.1.55")).toBe(false);
  });

  it("binds the manifest version and source files into resolution options (#6456)", () => {
    const options = createDeepAgentsCodeBaseImageResolutionOptions(
      makeAgent({
        name: "langchain-deepagents-code",
        displayName: "LangChain Deep Agents Code",
        expectedVersion: "9.8.7",
      }),
      ACTIVE_DCODE_DOCKERFILE,
    );
    mocks.dockerCapture
      .mockReturnValueOnce("9.8.7")
      .mockReturnValueOnce("nemoclaw-dcode-dos2unix-ok")
      .mockReturnValueOnce(ACTIVE_FABRIC_PROBE_OUTPUT)
      .mockReturnValueOnce("nemoclaw-security-inventory-ok");

    expect(options).toMatchObject({
      inputPaths: [
        path.join(ACTIVE_DCODE_PACKAGE_ROOT, "manifest.yaml"),
        path.join(ACTIVE_DCODE_PACKAGE_ROOT, "runtime", "requirements.lock"),
        path.join(ACTIVE_DCODE_PACKAGE_ROOT, "fabric", "requirements.lock"),
        ACTIVE_FABRIC_PROBE,
      ],
      validationDescription:
        "deepagents-code==9.8.7, dos2unix, the package-qualified Fabric runtime, and the immutable security package inventory",
    });
    expect(options?.validateImage?.("dcode-base:manifest-version")).toBe(true);
  });

  it("changes the base resolution key when only the Fabric dependency lock changes", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-fabric-lock-"));
    const agentRoot = path.join(rootDir, "packages", "nemoclaw-langchain-deepagents-code");
    const dockerfilePath = path.join(agentRoot, "Dockerfile.base");
    const runtimeLockPath = path.join(agentRoot, "runtime", "requirements.lock");
    const fabricLockPath = path.join(agentRoot, "fabric", "requirements.lock");
    const fabricCheckPath = path.join(agentRoot, "checks", "fabric-runtime.py");

    try {
      fs.mkdirSync(path.dirname(runtimeLockPath), { recursive: true });
      fs.mkdirSync(path.dirname(fabricLockPath), { recursive: true });
      fs.mkdirSync(path.dirname(fabricCheckPath), { recursive: true });
      fs.writeFileSync(dockerfilePath, "FROM ubuntu:24.04\n");
      fs.writeFileSync(path.join(agentRoot, "manifest.yaml"), "expected_version: 9.8.7\n");
      fs.writeFileSync(runtimeLockPath, "deepagents-code==9.8.7\n");
      fs.writeFileSync(fabricLockPath, "fabric-dependency==1.0.0\n");
      fs.writeFileSync(fabricCheckPath, "print('qualified')\n");

      const agentOptions = createDeepAgentsCodeBaseImageResolutionOptions(
        makeAgent({
          name: "langchain-deepagents-code",
          displayName: "LangChain Deep Agents Code",
          expectedVersion: "9.8.7",
        }),
        dockerfilePath,
      );
      expect(agentOptions).toBeDefined();
      const resolutionOptions = {
        imageName: "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base",
        dockerfilePath,
        localTag: "nemoclaw-langchain-deepagents-code-sandbox-base-local:test",
        rootDir,
        env: { GITHUB_SHA: "1234567890abcdef1234567890abcdef12345678" },
        ...agentOptions!,
      };
      const before = createSandboxBaseImageResolutionKey(resolutionOptions);

      fs.writeFileSync(fabricLockPath, "fabric-dependency==1.0.1\n");

      expect(createSandboxBaseImageResolutionKey(resolutionOptions)).not.toBe(before);

      fs.writeFileSync(fabricLockPath, "fabric-dependency==1.0.0\n");
      expect(createSandboxBaseImageResolutionKey(resolutionOptions)).toBe(before);

      fs.writeFileSync(fabricCheckPath, "print('changed')\n");
      expect(createSandboxBaseImageResolutionKey(resolutionOptions)).not.toBe(before);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects a matching distribution from a base without dos2unix (#8870)", () => {
    const options = createDeepAgentsCodeBaseImageResolutionOptions(
      makeAgent({
        name: "langchain-deepagents-code",
        displayName: "LangChain Deep Agents Code",
        expectedVersion: "0.1.34",
      }),
      "/test/root/packages/nemoclaw-langchain-deepagents-code/Dockerfile.base",
    );
    mocks.dockerCapture.mockReturnValueOnce("0.1.34").mockReturnValueOnce("");

    expect(options?.validateImage?.("dcode-base:missing-dos2unix")).toBe(false);
    expect(mocks.dockerCapture).toHaveBeenCalledTimes(2);
    expect(mocks.dockerCapture.mock.calls[1]?.[0]).toEqual(
      expect.arrayContaining([
        "run",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--read-only",
        "--user",
        "999:999",
        "--entrypoint",
        "/bin/sh",
        "dcode-base:missing-dos2unix",
        "-eu",
        "-c",
      ]),
    );
    expect(mocks.dockerCapture.mock.calls[1]?.[0].at(-1)).toContain("test -x /usr/bin/dos2unix");
    expect(mocks.dockerCapture.mock.calls[1]?.[0].at(-1)).toContain("dos2unix --version");
  });

  it("rejects a base without the exact released Fabric Deep Agents runtime", () => {
    const options = createDeepAgentsCodeBaseImageResolutionOptions(
      makeAgent({
        name: "langchain-deepagents-code",
        displayName: "LangChain Deep Agents Code",
        expectedVersion: "0.1.55",
      }),
      ACTIVE_DCODE_DOCKERFILE,
    );
    mocks.dockerCapture
      .mockReturnValueOnce("0.1.55")
      .mockReturnValueOnce("nemoclaw-dcode-dos2unix-ok")
      .mockReturnValueOnce("");

    expect(options?.validateImage?.("dcode-base:missing-fabric-runtime")).toBe(false);
    expect(mocks.dockerCapture).toHaveBeenCalledTimes(3);
    expect(mocks.dockerCapture.mock.calls[2]?.[0]).toEqual([
      "run",
      "--rm",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--user",
      "999:999",
      "--entrypoint",
      "/usr/local/lib/nemoclaw/checks/fabric-runtime.py",
      "dcode-base:missing-fabric-runtime",
    ]);
  });

  it("rejects a matching distribution from a base with an old security inventory (#7809)", () => {
    const options = createDeepAgentsCodeBaseImageResolutionOptions(
      makeAgent({
        name: "langchain-deepagents-code",
        displayName: "LangChain Deep Agents Code",
        expectedVersion: "0.1.55",
      }),
      ACTIVE_DCODE_DOCKERFILE,
    );
    mocks.dockerCapture
      .mockReturnValueOnce("0.1.55")
      .mockReturnValueOnce("nemoclaw-dcode-dos2unix-ok")
      .mockReturnValueOnce(ACTIVE_FABRIC_PROBE_OUTPUT)
      .mockReturnValueOnce("");

    expect(options?.validateImage?.("dcode-base:v0.0.96")).toBe(false);
    expect(mocks.dockerCapture).toHaveBeenCalledTimes(4);
    expect(mocks.dockerCapture.mock.calls[3]?.[0]).toEqual(
      expect.arrayContaining([
        "run",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--read-only",
        "--entrypoint",
        "/bin/sh",
        "dcode-base:v0.0.96",
        "-c",
      ]),
    );
    expect(mocks.dockerCapture.mock.calls[3]?.[0].at(-1)).toContain(
      `cmp -s - "$security_inventory"`,
    );
  });

  it("accepts only the exact released Fabric distribution versions", () => {
    mocks.dockerCapture
      .mockReturnValueOnce(ACTIVE_FABRIC_PROBE_OUTPUT)
      .mockReturnValueOnce(`nemoclaw-dcode-fabric-runtime-ok ${"0".repeat(64)}`)
      .mockReturnValueOnce("");

    expect(deepAgentsCodeBaseImageHasFabricRuntime("dcode-base:current", ACTIVE_FABRIC_PROBE)).toBe(
      true,
    );
    expect(
      deepAgentsCodeBaseImageHasFabricRuntime("dcode-base:stale-probe", ACTIVE_FABRIC_PROBE),
    ).toBe(false);
    expect(deepAgentsCodeBaseImageHasFabricRuntime("dcode-base:failed", ACTIVE_FABRIC_PROBE)).toBe(
      false,
    );
  });

  it("fails closed when the current package-owned Fabric check is unreadable", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      deepAgentsCodeBaseImageHasFabricRuntime(
        "dcode-base:current",
        path.join(ACTIVE_DCODE_PACKAGE_ROOT, "checks", "missing.py"),
      ),
    ).toBe(false);
    expect(mocks.dockerCapture).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("could not read the package-owned Fabric runtime check"),
    );
  });

  it("runs the version probe in a locked-down container (#6456)", () => {
    mocks.dockerCapture.mockReturnValue("0.1.55");

    deepAgentsCodeBaseImageMatchesVersion("dcode-base:current", "0.1.55");

    expect(mocks.dockerCapture).toHaveBeenCalledWith(
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--read-only",
        "--entrypoint",
        "/opt/venv/bin/python3",
        "dcode-base:current",
        "-I",
        "-c",
        'import importlib.metadata; print(importlib.metadata.version("deepagents-code"))',
      ],
      { ignoreError: true, timeout: 20_000 },
    );
  });

  it("warns and fails closed when the probe returns no version (#6456)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.dockerCapture.mockReturnValue("");

    expect(deepAgentsCodeBaseImageMatchesVersion("dcode-base:unreadable", "0.1.55")).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("dcode-base:unreadable returned no Deep Agents Code version output"),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("the container or metadata probe may have failed"),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("deepagents-code==0.1.55"));
    warn.mockRestore();
  });
});
