// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  streamSandboxCreate: vi.fn(),
  waitForCreatedSandboxReadyWithTrace: vi.fn(),
  printReadinessFailure: vi.fn(),
  enforceDockerGpuPatchPreserveNetwork: vi.fn(),
  verifyGpuSandboxAccessAfterReady: vi.fn(),
  createDockerGpuSandboxCreatePatch: vi.fn(),
  printSandboxCreateFailureDiagnostics: vi.fn(),
  collectDockerGpuPatchDiagnostics: vi.fn(),
  queryOpenShellDockerSandboxContainers: vi.fn(),
  queryOpenShellDockerSandboxRuntimeSnapshot: vi.fn(),
  helperResponds: vi.fn(),
  dockerSpawnSync: vi.fn(),
}));

vi.mock("../sandbox/create-stream", () => ({ streamSandboxCreate: mocks.streamSandboxCreate }));
vi.mock("./sandbox-readiness-tracing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sandbox-readiness-tracing")>()),
  waitForCreatedSandboxReadyWithTrace: mocks.waitForCreatedSandboxReadyWithTrace,
  printReadinessFailure: mocks.printReadinessFailure,
}));
vi.mock("./docker-gpu-local-inference", () => ({
  enforceDockerGpuPatchPreserveNetwork: mocks.enforceDockerGpuPatchPreserveNetwork,
  verifyGpuSandboxAccessAfterReady: mocks.verifyGpuSandboxAccessAfterReady,
}));
vi.mock("./docker-gpu-sandbox-create", () => ({
  createDockerGpuSandboxCreatePatch: mocks.createDockerGpuSandboxCreatePatch,
}));
vi.mock("./sandbox-create-failure", () => ({
  printSandboxCreateFailureDiagnostics: mocks.printSandboxCreateFailureDiagnostics,
}));
vi.mock("./docker-gpu-patch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./docker-gpu-patch")>()),
  collectDockerGpuPatchDiagnostics: mocks.collectDockerGpuPatchDiagnostics,
}));
vi.mock("./openshell-docker-sandbox-containers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openshell-docker-sandbox-containers")>()),
  queryOpenShellDockerSandboxContainers: mocks.queryOpenShellDockerSandboxContainers,
  queryOpenShellDockerSandboxRuntimeSnapshot: mocks.queryOpenShellDockerSandboxRuntimeSnapshot,
}));
vi.mock("../adapters/docker/credential-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/docker/credential-store")>()),
  dockerDesktopCredentialHelperResponds: mocks.helperResponds,
}));
vi.mock("../adapters/docker/exec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/docker/exec")>()),
  dockerSpawnSync: mocks.dockerSpawnSync,
}));
vi.mock("../platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform")>()),
  isWsl: (opts: { env?: NodeJS.ProcessEnv; isWsl?: boolean } = {}) =>
    typeof opts.isWsl === "boolean" ? opts.isWsl : Boolean(opts.env?.WSL_DISTRO_NAME),
}));

import {
  createGpuFlowDeps as createDeps,
  createGpuFlowInput as createInput,
  createGpuFlowTestHarness,
  GPU_IMAGE_ID as IMAGE_ID,
  VERIFIED_GPU_PROOF as VERIFIED_PROOF,
} from "./__test-helpers__/sandbox-gpu-create-flow";
import { runSandboxGpuCreateFlow } from "./sandbox-gpu-create-flow";

const {
  NVIDIA_SMI_FAILED_PROOF,
  createSourceInput,
  errorOutput,
  expectFlowExit,
  failNativeCreate,
  mockReadinessFailure,
  mockRuntimeSnapshot,
  resetHarness,
  setupHarness,
} = createGpuFlowTestHarness(mocks);

beforeEach(setupHarness);
afterEach(resetHarness);

describe("runSandboxGpuCreateFlow cleanup and provenance", () => {
  it("does not let a stale same-label container authorize or receive fallback cleanup", async () => {
    mocks.queryOpenShellDockerSandboxContainers.mockReturnValue({
      ok: true,
      ids: ["stale-container"],
    });
    failNativeCreate();
    const deps = createDeps();
    await expectFlowExit(createInput(), deps);

    expect(mocks.streamSandboxCreate).toHaveBeenCalledOnce();
    expect(mocks.queryOpenShellDockerSandboxRuntimeSnapshot).not.toHaveBeenCalled();
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
  });

  it("preserves the sandbox when ordinary readiness cleanup is name-only (#6110)", async () => {
    mockReadinessFailure();
    const deps = createDeps();
    vi.mocked(deps.runOpenshell).mockReturnValue({ status: 7, stderr: "gateway unavailable" });
    await expectFlowExit(createInput(), deps);

    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(deps.runOpenshell).not.toHaveBeenCalled();
    expect(output).toContain("left sandbox 'alpha' in place");
    expect(output).toContain("Verify the sandbox identity before manual cleanup");
    expect(output).not.toContain("openshell sandbox delete");
    expect(output).not.toContain("Retry: nemoclaw onboard");
  });

  it("does not infer absence through a mutable-name readiness cleanup", async () => {
    mockReadinessFailure();
    const deps = createDeps();
    vi.mocked(deps.runOpenshell).mockReturnValue({
      status: 1,
      stderr: "sandbox alpha not found",
    });
    await expectFlowExit(createInput(), deps);

    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(deps.runOpenshell).not.toHaveBeenCalled();
    expect(output).toContain("left sandbox 'alpha' in place");
    expect(output).toContain("Verify the sandbox identity before manual cleanup");
    expect(output).not.toContain("openshell sandbox delete");
    expect(output).not.toContain("Retry: nemoclaw onboard");
  });

  it("fully redacts command diagnostics when cleanup cannot be proven safe", async () => {
    failNativeCreate();
    const input = createInput();
    input.provider = "ollama-local";
    input.sandboxGpuConfig.sandboxGpuProof = VERIFIED_PROOF;
    const deps = createDeps();
    vi.mocked(deps.runOpenshell).mockImplementation((args) =>
      args[1] === "delete"
        ? { status: 0 }
        : { status: 1, stderr: "NVIDIA_API_KEY=super-secret-cleanup-value" },
    );
    await expectFlowExit(input, deps);

    const diagnostic = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(diagnostic).toContain("Cleanup could not be proven safe");
    expect(diagnostic).toContain("NVIDIA_API_KEY=<REDACTED>");
    expect(diagnostic).not.toContain("super-secret-cleanup-value");
    expect(deps.openshellArgv).toHaveBeenCalledOnce();
    expect(mocks.enforceDockerGpuPatchPreserveNetwork).not.toHaveBeenCalled();
    expect(input.sandboxGpuConfig.sandboxGpuProof).toBe(VERIFIED_PROOF);
  });

  it("refuses nvidia-smi fallback when exact native container provenance is unavailable (#6110)", async () => {
    const input = createSourceInput();
    mocks.queryOpenShellDockerSandboxRuntimeSnapshot.mockReturnValue({
      ok: false,
      error: "expected one labeled sandbox container, found 2",
    });
    const deps = createDeps();
    vi.mocked(deps.verifyDirectSandboxGpu).mockReturnValue({
      ...NVIDIA_SMI_FAILED_PROOF,
      detail: "No devices were found",
    });
    await expectFlowExit(input, deps);

    expect(mocks.streamSandboxCreate).toHaveBeenCalledOnce();
    expect(deps.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(deps.openshellArgv).not.toHaveBeenCalled();
  });

  it("ignores create-stream tags and reuses only the inspected immutable image", async () => {
    const input = createSourceInput();
    mockRuntimeSnapshot({
      bookkeepingImageRef: "openshell/sandbox-from:built",
      stateError: "CDI device injection failed: unresolvable CDI devices nvidia.com/gpu=all",
    });
    mocks.streamSandboxCreate.mockResolvedValueOnce({
      status: 1,
      output:
        "Built image attacker.example/redirect:latest\nCDI device injection failed: unresolvable CDI devices nvidia.com/gpu=all",
      sawProgress: true,
    });
    const deps = createDeps();

    await expect(runSandboxGpuCreateFlow(input, deps)).resolves.toMatchObject({
      route: "compatibility",
      registryImageRef: "openshell/sandbox-from:built",
    });
    expect(deps.openshellArgv).toHaveBeenCalledWith(expect.arrayContaining(["--from", IMAGE_ID]));
    expect(deps.openshellArgv).not.toHaveBeenCalledWith(
      expect.arrayContaining(["--from", "attacker.example/redirect:latest"]),
    );
    expect(mocks.streamSandboxCreate).toHaveBeenCalledTimes(2);
    expect(mocks.queryOpenShellDockerSandboxRuntimeSnapshot).toHaveBeenCalledOnce();
  });

  it("does not persist an immutable retry ID as the registry image tag", async () => {
    const input = createSourceInput();
    mockRuntimeSnapshot({
      bookkeepingImageRef: IMAGE_ID,
      stateError: "CDI device injection failed: unresolvable CDI devices nvidia.com/gpu=all",
    });
    mocks.streamSandboxCreate.mockResolvedValueOnce({
      status: 1,
      output: "CDI device injection failed: unresolvable CDI devices nvidia.com/gpu=all",
      sawProgress: true,
    });
    const deps = createDeps();

    await expect(runSandboxGpuCreateFlow(input, deps)).resolves.toMatchObject({
      route: "compatibility",
      registryImageRef: null,
    });
    expect(deps.openshellArgv).toHaveBeenCalledWith(expect.arrayContaining(["--from", IMAGE_ID]));
  });
});
