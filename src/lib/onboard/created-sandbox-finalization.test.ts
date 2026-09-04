// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { restoreEnv } from "../../../test/helpers/env-test-helpers";
import type { AgentDefinition } from "../agent/defs";
import type { SandboxEntry } from "../state/registry";
import type { QualifiedSandboxInferenceRouteReservation } from "../state/registry/route-reservation";
import type {
  RebuildManifest,
  RecreatedSandboxRestoreOptions,
  RestoreResult,
  SnapshotRestoreAuthority,
} from "../state/sandbox";
import type { HermesPortableConfiguredReceipt } from "./experimental/hermes-portable-receipt";
import type { SandboxGpuCreateFlowResult } from "./sandbox-gpu-create-flow";
import type { SandboxGpuConfig } from "./sandbox-gpu-mode";
import type { CreatedSandboxRegistrationInput } from "./sandbox-registration";

// sandbox-state binds its backup root at module load. Load the finalization
// path only after HOME points at this file's isolated state root so the fixture
// can exercise the real snapshot-content authority check without touching user
// state.
const ORIGINAL_HOME = process.env.HOME;
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-created-finalize-home-"));
process.env.HOME = TEST_HOME;
const { loadAgent } = await import("../agent/defs");
const sandboxState = await import("../state/sandbox");
const {
  completeOrdinaryOnboardSandboxCreation,
  createCreatedSandboxCompletionActions,
  createOnboardCreatedSandboxCompletion,
  createOnboardCreatedSandboxRegistration,
  finalizeCreatedSandbox,
} = await import("./created-sandbox-finalization");
const { getDcodeSelectionDrift } = await import("./dcode-selection-drift");
const { pendingSandboxCreateIdentityForBoundary } =
  await import("./sandbox-create/identity-boundary");

const fixtures: string[] = [];
const TEST_BACKUPS_ROOT = path.join(TEST_HOME, ".nemoclaw", "rebuild-backups");
const TEST_PACKAGE_AUTHORITY = {
  harnessPackage: null,
  harnessPackageMigration: null,
} as const;
const DCODE_HARNESS_PACKAGE = {
  kind: "agent-runtime" as const,
  id: "langchain-deepagents-code",
  packageVersion: "0.1.0",
  contentDigest: "d".repeat(64),
};

afterEach(() => {
  delete process.env.NEMOCLAW_OPENSHELL_BIN;
  for (const fixture of fixtures.splice(0)) fs.rmSync(fixture, { recursive: true, force: true });
  vi.restoreAllMocks();
});

afterAll(() => {
  restoreEnv("HOME", ORIGINAL_HOME);
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("created sandbox registration authority", () => {
  it("refuses legacy Hermes resume without an in-process verified create checkpoint (#9833)", async () => {
    const complete = vi.fn();
    const cleanupBuildContext = vi.fn();
    const register = createOnboardCreatedSandboxRegistration({
      completion: { complete },
      createdLifecycle: {} as never,
      cleanupBuildContext,
      manageDashboard: false,
      sandboxGpuEnabled: false,
    });

    await expect(
      register(
        null,
        { lifecycleGeneration: "generation-1" } as HermesPortableConfiguredReceipt,
        "a".repeat(64),
        vi.fn(),
      ),
    ).rejects.toThrow(/without a verified create checkpoint from this process/u);

    expect(cleanupBuildContext).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
});

describe("new sandbox cancellation recovery", () => {
  it("preserves recovery guidance when the durable identity is unavailable (#9833)", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runFile = vi.fn();
    const armCancelRollback = vi.fn();
    const markCancellationRecovery = vi.fn();

    expect(() =>
      completeOrdinaryOnboardSandboxCreation(
        {
          sandboxName: "new-sandbox",
          sandboxWasLiveDefault: false,
          gatewayPort: 8080,
          runtimeFields: { openshellDriver: "docker" } as never,
          messagingProviders: [],
          liveExists: false,
        },
        {
          setDefault: vi.fn(),
          runFile,
          scriptsDir: "/repo/scripts",
          gatewayName: "nemoclaw",
          providerExistsInGateway: () => true,
          armCancelRollback,
          markCancellationRecovery,
          dockerInfoFormat: () => "",
          runCapture: () => "",
          revalidateSandboxIdentity: vi.fn(),
          applyVmDnsMonkeypatch: vi.fn(),
        },
      ),
    ).toThrow("Sandbox 'new-sandbox' has no exact identity for cancel recovery.");

    const guidance = error.mock.calls.flat().join("\n");
    expect(guidance).toContain("Sandbox 'new-sandbox' was created on gateway 'nemoclaw'");
    expect(guidance).toContain("registry entry and onboarding session were preserved");
    expect(guidance).toContain("Do not delete the sandbox by mutable sandbox name");
    expect(guidance).toContain("establish the exact live durable identity before removal");
    expect(guidance).toContain("add --fresh, and use a new sandbox name");
    expect(runFile).not.toHaveBeenCalled();
    expect(armCancelRollback).not.toHaveBeenCalled();
    expect(markCancellationRecovery).toHaveBeenCalledOnce();
    expect(markCancellationRecovery).toHaveBeenCalledWith("new-sandbox");
  });
});

function executable(file: string, contents: string): void {
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

function makeRestoreFixture(): {
  backupPath: string;
  currentPath: string;
  oldPath: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-finalize-"));
  const bin = path.join(root, "bin");
  const sandboxBackupRoot = path.join(TEST_BACKUPS_ROOT, "dcode");
  fs.mkdirSync(sandboxBackupRoot, { recursive: true });
  const backupPath = fs.mkdtempSync(path.join(sandboxBackupRoot, "2026-07-06-"));
  fixtures.push(root, backupPath);
  const liveDir = path.join(root, "live", ".deepagents");
  const currentPath = path.join(liveDir, "config.toml");
  const oldPath = process.env.PATH ?? "";
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(liveDir, { recursive: true });

  fs.writeFileSync(
    path.join(backupPath, "rebuild-manifest.json"),
    JSON.stringify({
      version: 1,
      sandboxName: "dcode",
      timestamp: "2026-07-06T00:00:00.000Z",
      agentType: "langchain-deepagents-code",
      agentVersion: "0.1.0",
      expectedVersion: "0.1.0",
      stateDirs: [],
      backedUpDirs: [],
      stateFiles: [{ path: "config.toml", strategy: "copy" }],
      dir: "/sandbox/.deepagents",
      backupPath,
      blueprintDigest: null,
    }),
  );
  fs.writeFileSync(
    path.join(backupPath, "config.toml"),
    [
      "[models]",
      'default = "openai:old-model"',
      "",
      "[update]",
      "check = true",
      "auto_update = true",
      "",
      "[agents]",
      'default = "reviewer"',
      "",
      "[ui]",
      'theme = "dark"',
      "show_scrollbar = true",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    currentPath,
    [
      "# Generated by NemoClaw. This file contains no provider secrets.",
      "# NemoClaw provider route: inference; upstream provider: nvidia-prod; API: openai-completions.",
      "",
      "[models]",
      'default = "openai:new-model"',
      "",
      "[models.providers.openai]",
      'models = ["new-model"]',
      'api_key_env = "DEEPAGENTS_CODE_OPENAI_API_KEY"',
      'base_url = "https://inference.local/v1"',
      "enabled = true",
      "",
      "[update]",
      "check = false",
      "auto_update = false",
      "",
    ].join("\n"),
  );

  const pythonResult = ["python3.13", "python3.12", "python3.11", "python3"]
    .map((candidate) =>
      spawnSync(
        candidate,
        ["-c", "import sys; assert sys.version_info >= (3, 11); print(sys.executable)"],
        { encoding: "utf8" },
      ),
    )
    .find((result) => result.status === 0 && result.stdout.trim().length > 0);
  expect(pythonResult, "Python 3.11 or newer is required").toBeDefined();
  const hostPython = pythonResult!.stdout.trim();
  const python = path.join(bin, "python3");
  executable(
    python,
    `#!${hostPython}
import json
import subprocess
import sys
import types

NODE_TOML_WRITER = r"""
const fs = require("node:fs");
const { stringify } = require("smol-toml");
const value = JSON.parse(fs.readFileSync(0, "utf8"));
process.stdout.write(stringify(value));
"""

def dumps(value):
    completed = subprocess.run(
        ["node", "-e", NODE_TOML_WRITER],
        input=json.dumps(value, allow_nan=False),
        capture_output=True,
        check=True,
        text=True,
    )
    return completed.stdout

tomli_w = types.ModuleType("tomli_w")
tomli_w.dumps = dumps
sys.modules["tomli_w"] = tomli_w

try:
    script_index = sys.argv.index("-c", 1) + 1
except ValueError:
    script_index = 1
script = sys.argv[script_index]
sys.argv = [sys.argv[0], *sys.argv[script_index + 1:]]
exec(script, {"__name__": "__main__"})
`,
  );
  const openshell = path.join(bin, "openshell");
  executable(
    openshell,
    '#!/usr/bin/env bash\nprintf "Host openshell-%s\\n  HostName 127.0.0.1\\n  User sandbox\\n" "${!#}"\n',
  );
  executable(
    path.join(bin, "ssh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const command = process.argv.at(-1)
  .replaceAll("/sandbox/.deepagents", ${JSON.stringify(liveDir)})
  .replace("/opt/venv/bin/python3", ${JSON.stringify(python)});
const result = spawnSync("bash", ["-c", command], { input: fs.readFileSync(0), stdio: ["pipe", "pipe", "pipe"] });
if (result.stdout) fs.writeSync(1, result.stdout);
if (result.stderr) fs.writeSync(2, result.stderr);
process.exit(result.status ?? 1);
`,
  );
  process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  return { backupPath, currentPath, oldPath };
}

function identityFromConfig(config: string): string {
  const metadata = config.match(
    /^# NemoClaw provider route: ([^;]+); upstream provider: ([^;]+);/m,
  );
  const model = config.match(/^default = "([^"]+)"$/m)?.[1];
  const endpoint = config.match(/^base_url = "([^"]+)"$/m)?.[1];
  return [
    `Route:    ${metadata?.[1] ?? ""}`,
    `Provider: ${metadata?.[2] ?? ""}`,
    `Model:    ${model ?? ""}`,
    `Endpoint: ${endpoint ?? ""}`,
  ].join("\n");
}

function captureFixtureRestoreAuthority(
  backupPath: string,
  expectedManifest?: RebuildManifest,
): SnapshotRestoreAuthority {
  const authority = sandboxState.captureSnapshotRestoreAuthority(backupPath, expectedManifest);
  expect(authority).not.toBeNull();
  return authority!;
}

function restoreFixtureState(
  sandboxName: string,
  backupPath: string,
  options: RecreatedSandboxRestoreOptions,
): RestoreResult {
  return sandboxState.restoreRecreatedSandboxState(sandboxName, backupPath, options);
}

describe("created DCode sandbox finalization", () => {
  it("merges stale backup preferences before live validation and registry publication (#6311)", () => {
    const fixture = makeRestoreFixture();
    const order: string[] = [];
    const registeredConfigs: string[] = [];
    try {
      finalizeCreatedSandbox(
        {
          sandboxName: "dcode",
          restoreBackupPath: fixture.backupPath,
          preUpgradeBackup: false,
          targetAgentType: "langchain-deepagents-code",
          agentDefinition: loadAgent("langchain-deepagents-code"),
          validateManagedDcode: true,
          provider: "nvidia-prod",
          model: "new-model",
          preferredInferenceApi: null,
        },
        {
          discoverFreshOpenClawImagePluginInstalls: () => ({
            ok: true,
            extensionDirs: [],
            pluginInstalls: [],
          }),
          restoreRecreatedSandboxState: (name, backup, options) => {
            order.push("restore");
            expect(options.allowCustomImageWholeStateFileRestore).toBeUndefined();
            return restoreFixtureState(name, backup, options);
          },
          captureSnapshotRestoreAuthority: captureFixtureRestoreAuthority,
          revalidateHarnessPackageAuthority: () => DCODE_HARNESS_PACKAGE,
          revalidateSandboxIdentity: vi.fn(),
          getDcodeSelectionDrift: (name, provider, model, api) => {
            order.push("validate");
            return getDcodeSelectionDrift(name, provider, model, api, {
              getGatewayName: () => "nemoclaw-18081",
              runCaptureOpenshell: () =>
                identityFromConfig(fs.readFileSync(fixture.currentPath, "utf8")),
            });
          },
          register: () => {
            order.push("register");
            registeredConfigs.push(fs.readFileSync(fixture.currentPath, "utf8"));
          },
          note: vi.fn(),
          error: vi.fn(),
          exitProcess: (code): never => {
            throw new Error(`exit ${code}`);
          },
        },
      );

      expect(order).toEqual(["restore", "validate", "register"]);
      expect(registeredConfigs[0]).toContain('default = "openai:new-model"');
      expect(registeredConfigs[0]).not.toContain("old-model");
      expect(registeredConfigs[0]).not.toContain("[agents]");
      expect(registeredConfigs[0]).toContain("[ui]\nshow_scrollbar = true");
      expect(registeredConfigs[0]).not.toContain('theme = "dark"');
    } finally {
      process.env.PATH = fixture.oldPath;
    }
  }, 10_000);

  it("refuses registry publication when selected backup content changes before restore (#6311)", () => {
    const fixture = makeRestoreFixture();
    const register = vi.fn();
    const error = vi.fn();
    const getDcodeSelectionDrift = vi.fn();
    const liveConfigBeforeRestore = fs.readFileSync(fixture.currentPath, "utf8");
    try {
      expect(() =>
        finalizeCreatedSandbox(
          {
            sandboxName: "dcode",
            restoreBackupPath: fixture.backupPath,
            preUpgradeBackup: false,
            targetAgentType: "langchain-deepagents-code",
            agentDefinition: loadAgent("langchain-deepagents-code"),
            validateManagedDcode: true,
            provider: "nvidia-prod",
            model: "new-model",
            preferredInferenceApi: null,
          },
          {
            discoverFreshOpenClawImagePluginInstalls: vi.fn(),
            restoreRecreatedSandboxState: (name, backup, options) => {
              fs.appendFileSync(path.join(backup, "config.toml"), "\n# changed after selection\n");
              return restoreFixtureState(name, backup, options);
            },
            captureSnapshotRestoreAuthority: captureFixtureRestoreAuthority,
            revalidateHarnessPackageAuthority: () => DCODE_HARNESS_PACKAGE,
            getDcodeSelectionDrift,
            register,
            note: vi.fn(),
            error,
            exitProcess: (code): never => {
              throw new Error(`exit ${code}`);
            },
          },
        ),
      ).toThrow("exit 1");

      expect(register).not.toHaveBeenCalled();
      expect(getDcodeSelectionDrift).not.toHaveBeenCalled();
      expect(fs.readFileSync(fixture.currentPath, "utf8")).toBe(liveConfigBeforeRestore);
      expect(error.mock.calls.flat().join("\n")).toContain(
        "Could not stage selected snapshot safely: selected snapshot content changed while it was staged",
      );
    } finally {
      process.env.PATH = fixture.oldPath;
    }
  });

  it("publishes fresh metadata after endpoint-aware OpenRouter validation (#9555)", () => {
    const endpointUrl = "https://openrouter.ai/api/v1";
    const getDcodeSelectionDrift = vi.fn(() => ({
      changed: false,
      providerChanged: false,
      modelChanged: false,
      existingProvider: "openrouter",
      existingModel: "openrouter:nvidia/nemotron-3-ultra-550b-a55b",
      unknown: false,
    }));
    const register = vi.fn();

    finalizeCreatedSandbox(
      {
        sandboxName: "dcode",
        restoreBackupPath: null,
        preUpgradeBackup: false,
        targetAgentType: "langchain-deepagents-code",
        validateManagedDcode: true,
        provider: "compatible-endpoint",
        model: "nvidia/nemotron-3-ultra-550b-a55b",
        preferredInferenceApi: "openai-completions",
        endpointUrl,
      },
      {
        discoverFreshOpenClawImagePluginInstalls: vi.fn(),
        restoreRecreatedSandboxState: vi.fn(),
        getDcodeSelectionDrift,
        register,
        note: vi.fn(),
        error: vi.fn(),
        exitProcess: (code): never => {
          throw new Error(`exit ${code}`);
        },
      },
    );

    expect(getDcodeSelectionDrift).toHaveBeenCalledWith(
      "dcode",
      "compatible-endpoint",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "openai-completions",
      endpointUrl,
    );
    expect(register).toHaveBeenCalledOnce();
  });

  it("passes the fresh create endpoint through the production completion constructor (#9555)", async () => {
    const endpointUrl = "https://openrouter.ai/api/v1";
    const model = "nvidia/nemotron-3-ultra-550b-a55b";
    const verifiedCreateBoundary = {
      sandboxName: "dcode",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      lifecycleGeneration: "generation-1",
      lifecycleLiveIdentityFingerprint: "a".repeat(64),
      route: "native" as const,
    };
    const verifiedCreate = {
      reservation: {
        authority: {
          sandboxName: "dcode",
          gatewayName: "nemoclaw",
          sessionId: "session-1",
          selection: {
            provider: "compatible-endpoint",
            model,
            endpointUrl,
            endpointSource: "onboard" as const,
            credentialEnv: "NVIDIA_API_KEY",
            preferredInferenceApi: "openai-completions",
            compatibleEndpointReasoning: null,
            compatibleEndpointReasoningEffort: null,
            nimContainer: null,
          },
          ...TEST_PACKAGE_AUTHORITY,
        },
        entry: { name: "dcode" } as SandboxEntry,
      },
      checkpoint: pendingSandboxCreateIdentityForBoundary(verifiedCreateBoundary),
    } as NonNullable<CreatedSandboxRegistrationInput["verifiedCreate"]>;
    const runCaptureOpenshell = vi.fn(() =>
      [
        "Sandbox:  dcode",
        "Route:    inference",
        "Provider: compatible-endpoint",
        `Model:    openai:${model}`,
        "Endpoint: https://inference.local/v1",
        "Runtime:  Deep Agents Code (terminal)",
      ].join("\n"),
    );
    vi.spyOn(process, "exit").mockImplementation((code): never => {
      throw new Error(`exit ${code}`);
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const completionArgs = [
      "dcode",
      null,
      null,
      null,
      {
        name: "langchain-deepagents-code",
        packageRoot: "/state/harnesses/objects/deepagents-code",
      } as AgentDefinition,
      null,
      { customOpenClawImage: false, isManagedDcodeAgent: true },
      {
        provider: "compatible-endpoint",
        model,
        preferredInferenceApi: "openai-completions",
        endpointUrl,
      },
      {
        createIntent: { endpointUrl, endpointSource: null, observabilityEnabled: false },
        resolvedCreateIntent: {
          policy: { options: {} },
          hostMounts: undefined,
        },
      },
      {
        gpuEnabled: false,
        hostGpuDetected: false,
        sandboxGpuEnabled: false,
        sandboxGpuMode: "none",
        sandboxGpuDevice: null,
        sandboxGpuProof: null,
        openshellDriver: "docker",
        openshellVersion: "0.0.101",
      },
      false,
      { toolDisclosure: undefined, dcodeAutoApprovalMode: "disabled" },
      { webSearchConfig: null, hermesAuthMethod: null },
      {
        plannedMessagingState: undefined,
        preservedMcpState: undefined,
        hermesToolGateways: [],
      },
      null,
      { gatewayName: "nemoclaw", gatewayPort: 8080 },
      {
        initialSandboxPolicy: {
          appliedPresets: ["personal-open-internet"],
          policyPath: "/private/initial-policy.yaml",
        },
        compatibilityPolicyPath: null,
        dashboardRemoteBindPrepared: false,
        getVerifiedCreateBoundary: () => verifiedCreateBoundary,
        getVerifiedCreateRegistrationAuthority: () => verifiedCreate,
        revalidateSandboxIdentity: vi.fn(),
      },
      null,
      "build-1",
      {
        mode: "none",
        hostGpuDetected: false,
        hostGpuPlatform: "linux",
        sandboxGpuEnabled: false,
        sandboxGpuDevice: null,
        errors: [],
      },
      false,
      vi.fn(),
      runCaptureOpenshell,
      "http://127.0.0.1:8643",
      { config: null, enabled: false },
      vi.fn(),
      vi.fn(),
      vi.fn(),
      {
        runtimeProvider: null,
        ensurePreparedWorkload: vi.fn(),
        ensurePreparedProfile: vi.fn(),
      },
      {
        source: {
          kind: "legacy-dockerfile",
          dockerfilePath: "/workspace/Dockerfile",
          reason: "agent-not-managed",
        },
        release: null,
        fallbackDiagnostic: null,
      },
      null,
      vi.fn(),
      vi.fn((input) => ({
        schemaVersion: 1,
        origin: "sandbox-create",
        gatewayName: input.gatewayName,
        gatewayPort: input.gatewayPort,
        sandboxName: input.sandboxName,
        lifecycleGeneration: input.lifecycleGeneration,
        sandboxIdentityFingerprint: input.lifecycleLiveIdentityFingerprint,
      })),
    ] as unknown as Parameters<typeof createOnboardCreatedSandboxCompletion>;
    const completion = createOnboardCreatedSandboxCompletion(...completionArgs);
    const created = {
      createResult: { status: 0, output: "", sawProgress: true },
      route: "native",
      firstCreateOutput: "",
      registryImageRef: null,
      lifecycleRegistrationFields: { lifecycleGeneration: "generation-1" },
    } as SandboxGpuCreateFlowResult;
    const lifecycleLiveIdentityFingerprint = "a".repeat(64);
    const lifecycle = {
      generation: "generation-1",
      recordExactIdentity: () => ({
        lifecycleGeneration: "generation-1",
        lifecycleLiveIdentityFingerprint,
      }),
      capture: () => ({
        lifecycleGeneration: "generation-1",
        lifecycleLiveIdentityFingerprint,
      }),
      revalidate: (registration: {
        lifecycleGeneration: string;
        lifecycleLiveIdentityFingerprint: string;
      }) => registration,
    };

    await expect(
      completion.complete(
        created,
        null,
        "disabled",
        false,
        () => ({ lifecycleGeneration: "generation-1" }),
        lifecycle,
      ),
    ).rejects.toThrow("exit 1");
    expect(runCaptureOpenshell).toHaveBeenCalledOnce();
  });

  it("does not publish registry metadata when live validation fails (#6311)", () => {
    const register = vi.fn();
    const error = vi.fn();
    expect(() =>
      finalizeCreatedSandbox(
        {
          sandboxName: "dcode",
          restoreBackupPath: null,
          preUpgradeBackup: false,
          targetAgentType: "langchain-deepagents-code",
          validateManagedDcode: true,
          provider: "nvidia-prod",
          model: "new-model",
          preferredInferenceApi: null,
        },
        {
          discoverFreshOpenClawImagePluginInstalls: vi.fn(),
          restoreRecreatedSandboxState: vi.fn(),
          getDcodeSelectionDrift: () => ({
            changed: true,
            providerChanged: false,
            modelChanged: true,
            existingProvider: "nvidia-prod",
            existingModel: "openai:old-model",
            unknown: false,
          }),
          register,
          note: vi.fn(),
          error,
          exitProcess: (code): never => {
            throw new Error(`exit ${code}`);
          },
        },
      ),
    ).toThrow("exit 1");
    expect(register).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("sandbox still exists"));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("rebuild is unsafe"));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Verify its durable identity"));
    expect(error.mock.calls.flat().join("\n")).not.toContain("openshell sandbox delete");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("nemoclaw onboard"));
  });

  it("rejects registration after a partial workspace restore (#6311)", () => {
    const fixture = makeRestoreFixture();
    const register = vi.fn();
    const getDcodeSelectionDrift = vi.fn();
    const error = vi.fn();
    try {
      expect(() =>
        finalizeCreatedSandbox(
          {
            sandboxName: "dcode",
            gatewayName: "nemoclaw",
            restoreBackupPath: fixture.backupPath,
            preUpgradeBackup: false,
            targetAgentType: "langchain-deepagents-code",
            agentDefinition: loadAgent("langchain-deepagents-code"),
            validateManagedDcode: true,
            provider: "nvidia-prod",
            model: "new-model",
            preferredInferenceApi: null,
          },
          {
            discoverFreshOpenClawImagePluginInstalls: vi.fn(),
            restoreRecreatedSandboxState: (name, backup, options) => {
              const restored = restoreFixtureState(name, backup, options);
              return {
                ...restored,
                success: false,
                failedDirs: ["skills"],
                failedFiles: ["settings.json"],
                error: "copy failed",
              };
            },
            captureSnapshotRestoreAuthority: captureFixtureRestoreAuthority,
            revalidateHarnessPackageAuthority: () => DCODE_HARNESS_PACKAGE,
            getDcodeSelectionDrift,
            register,
            note: vi.fn(),
            error,
            exitProcess: (code): never => {
              throw new Error(`exit ${code}`);
            },
          },
        ),
      ).toThrow("exit 1");

      expect(error).toHaveBeenCalledWith(
        "  Warning: workspace state restore was incomplete for sandbox 'dcode'.",
      );
      expect(error).toHaveBeenCalledWith("  Failed directories: skills");
      expect(error).toHaveBeenCalledWith("  Failed files: settings.json");
      expect(error).toHaveBeenCalledWith("  Restore reason: copy failed");
      expect(error).toHaveBeenCalledWith(
        "  Workspace state restoration did not complete. Registry metadata was not updated.",
      );
      expect(error).toHaveBeenCalledWith(
        "  NemoClaw left unregistered sandbox 'dcode' in place because OpenShell can delete it only by mutable name.",
      );
      expect(error).toHaveBeenCalledWith(
        "  Verify its durable identity before manual cleanup; do not act by name alone.",
      );
      expect(error.mock.calls.flat().join("\n")).not.toContain("openshell sandbox delete");
      expect(error).toHaveBeenCalledWith(
        `  Keep the snapshot for manual recovery: ${fixture.backupPath}`,
      );
      expect(register).not.toHaveBeenCalled();
      expect(getDcodeSelectionDrift).not.toHaveBeenCalled();
    } finally {
      process.env.PATH = fixture.oldPath;
    }
  });

  it("keeps custom-image restores outside the managed config merge (#6311)", () => {
    const fixture = makeRestoreFixture();
    const registeredConfigs: string[] = [];
    try {
      finalizeCreatedSandbox(
        {
          sandboxName: "custom-dcode",
          restoreBackupPath: fixture.backupPath,
          preUpgradeBackup: false,
          targetAgentType: "langchain-deepagents-code",
          agentDefinition: loadAgent("langchain-deepagents-code"),
          customImage: true,
          validateManagedDcode: false,
          provider: "custom-provider",
          model: "custom-model",
          preferredInferenceApi: null,
        },
        {
          discoverFreshOpenClawImagePluginInstalls: vi.fn(),
          restoreRecreatedSandboxState: (name, backup, options) => {
            expect(options.allowCustomImageWholeStateFileRestore).toBe(true);
            return restoreFixtureState(name, backup, options);
          },
          captureSnapshotRestoreAuthority: captureFixtureRestoreAuthority,
          revalidateHarnessPackageAuthority: () => DCODE_HARNESS_PACKAGE,
          revalidateSandboxIdentity: vi.fn(),
          getDcodeSelectionDrift: vi.fn(),
          register: () => {
            registeredConfigs.push(fs.readFileSync(fixture.currentPath, "utf8"));
          },
          note: vi.fn(),
          error: vi.fn(),
          exitProcess: (code): never => {
            throw new Error(`exit ${code}`);
          },
        },
      );

      expect(registeredConfigs).toHaveLength(1);
      expect(registeredConfigs[0]).toContain('default = "openai:old-model"');
      expect(registeredConfigs[0]).toContain("[agents]");
      expect(registeredConfigs[0]).toContain('theme = "dark"');
      expect(registeredConfigs[0]).not.toContain("new-model");
    } finally {
      process.env.PATH = fixture.oldPath;
    }
  });
});

describe("created OpenClaw sandbox finalization", () => {
  const openClawHarnessPackage = {
    kind: "agent-runtime" as const,
    id: "openclaw",
    packageVersion: "1.2.3",
    contentDigest: "a".repeat(64),
  };
  const pluginInstalls = [
    {
      id: "weather",
      installPath: "/sandbox/.openclaw/extensions/weather",
      loadPaths: [],
    },
  ];

  function openClawV2Manifest(overrides: Partial<RebuildManifest> = {}): RebuildManifest {
    return {
      version: 2,
      sandboxName: "openclaw",
      timestamp: "2026-08-28T00:00:00.000Z",
      agentType: "openclaw",
      agentVersion: "1.2.3",
      expectedVersion: "1.2.3",
      harnessPackage: openClawHarnessPackage,
      stateDirs: ["extensions"],
      dir: "/sandbox/.openclaw",
      backupPath: "/tmp/openclaw-backup",
      blueprintDigest: null,
      ...overrides,
    };
  }

  it("skips image-plugin discovery for a managed OpenClaw image", () => {
    const discoverFreshOpenClawImagePluginInstalls = vi.fn();
    const register = vi.fn();

    finalizeCreatedSandbox(
      {
        sandboxName: "openclaw",
        restoreBackupPath: null,
        preUpgradeBackup: false,
        targetAgentType: "openclaw",
        validateManagedDcode: false,
        provider: "compatible-endpoint",
        model: "demo",
        preferredInferenceApi: "openai-completions",
      },
      {
        discoverFreshOpenClawImagePluginInstalls,
        restoreRecreatedSandboxState: vi.fn(),
        getDcodeSelectionDrift: vi.fn(),
        register,
        note: vi.fn(),
        error: vi.fn(),
        exitProcess: (code) => {
          throw new Error(`unexpected exit ${code}`);
        },
      },
    );

    expect(discoverFreshOpenClawImagePluginInstalls).not.toHaveBeenCalled();
    expect(register).toHaveBeenCalledWith(undefined);
  });

  it("captures and registers a fresh image plugin baseline without a restore", () => {
    const order: string[] = [];
    const restoreRecreatedSandboxState = vi.fn();
    const register = vi.fn(() => {
      order.push("register");
    });

    finalizeCreatedSandbox(
      {
        sandboxName: "openclaw",
        restoreBackupPath: null,
        preUpgradeBackup: false,
        targetAgentType: "openclaw",
        discoverOpenClawImagePluginInstalls: true,
        validateManagedDcode: false,
        provider: "compatible-endpoint",
        model: "demo",
        preferredInferenceApi: "openai-completions",
      },
      {
        discoverFreshOpenClawImagePluginInstalls: () => {
          order.push("discover");
          return { ok: true, extensionDirs: ["weather"], pluginInstalls };
        },
        restoreRecreatedSandboxState,
        getDcodeSelectionDrift: vi.fn(),
        register,
        note: vi.fn(),
        error: vi.fn(),
        exitProcess: (code): never => {
          throw new Error(`exit ${code}`);
        },
      },
    );

    expect(order).toEqual(["discover", "register"]);
    expect(restoreRecreatedSandboxState).not.toHaveBeenCalled();
    expect(register).toHaveBeenCalledWith(pluginInstalls);
  });

  it("fails closed when snapshot content changes during recreate preflight", () => {
    const restoreRecreatedSandboxState = vi.fn();
    const register = vi.fn();
    const error = vi.fn();
    const captureSnapshotRestoreAuthority = vi.fn(() => null);

    expect(() =>
      finalizeCreatedSandbox(
        {
          sandboxName: "openclaw",
          restoreBackupPath: "/tmp/openclaw-backup",
          preUpgradeBackup: false,
          targetAgentType: "openclaw",
          agentDefinition: { name: "openclaw" } as never,
          validateManagedDcode: false,
          provider: "compatible-endpoint",
          model: "demo",
          preferredInferenceApi: "openai-completions",
        },
        {
          discoverFreshOpenClawImagePluginInstalls: vi.fn(),
          restoreRecreatedSandboxState,
          readSandboxStateBackupManifest: () => openClawV2Manifest(),
          captureSnapshotRestoreAuthority,
          revalidateHarnessPackageAuthority: () => openClawHarnessPackage,
          getDcodeSelectionDrift: vi.fn(),
          register,
          note: vi.fn(),
          error,
          exitProcess: (code): never => {
            throw new Error(`exit ${code}`);
          },
        },
      ),
    ).toThrow("exit 1");

    expect(captureSnapshotRestoreAuthority).toHaveBeenCalledOnce();
    expect(restoreRecreatedSandboxState).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      "  Restore reason: Selected snapshot content changed during restore preflight",
    );
  });

  it("defers managed restore before unregistered target authority can be bound", () => {
    const register = vi.fn();
    const error = vi.fn();
    const captureSnapshotRestoreAuthority = vi.fn();

    expect(() =>
      finalizeCreatedSandbox(
        {
          sandboxName: "openclaw",
          restoreBackupPath: "/tmp/managed-openclaw-backup",
          preUpgradeBackup: false,
          targetAgentType: "openclaw",
          validateManagedDcode: false,
          provider: "compatible-endpoint",
          model: "demo",
          preferredInferenceApi: "openai-completions",
        },
        {
          discoverFreshOpenClawImagePluginInstalls: vi.fn(),
          readSandboxStateBackupManifest: () =>
            openClawV2Manifest({
              workload: { kind: "managed-image" } as never,
            }),
          captureSnapshotRestoreAuthority,
          restoreRecreatedSandboxState: (_name, _backup, options) => {
            expect(options.authority).toBeUndefined();
            expect(options.validateBeforeMutation).toBeUndefined();
            return {
              success: false,
              restoredDirs: [],
              failedDirs: ["manifest"],
              restoredFiles: [],
              failedFiles: [],
              error: sandboxState.MANAGED_SNAPSHOT_RESTORE_AUTHORITY_ERROR,
            };
          },
          getDcodeSelectionDrift: vi.fn(),
          register,
          note: vi.fn(),
          error,
          exitProcess: (code): never => {
            throw new Error(`exit ${code}`);
          },
        },
      ),
    ).toThrow("exit 1");

    expect(register).not.toHaveBeenCalled();
    expect(captureSnapshotRestoreAuthority).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("restore is deferred"));
    expect(error).toHaveBeenCalledWith(
      "  State was not restored and registry metadata was not updated.",
    );
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Verify its durable identity"));
    expect(error.mock.calls.flat().join("\n")).not.toContain("openshell sandbox delete");
    expect(error).toHaveBeenCalledWith("  Manual recovery: /tmp/managed-openclaw-backup");
  });

  it("fails closed before restore and registration when provenance discovery fails", () => {
    const restoreRecreatedSandboxState = vi.fn();
    const register = vi.fn();
    const error = vi.fn();

    expect(() =>
      finalizeCreatedSandbox(
        {
          sandboxName: "openclaw",
          restoreBackupPath: "/tmp/openclaw-backup",
          preUpgradeBackup: false,
          targetAgentType: "openclaw",
          discoverOpenClawImagePluginInstalls: true,
          validateManagedDcode: false,
          provider: "compatible-endpoint",
          model: "demo",
          preferredInferenceApi: "openai-completions",
        },
        {
          discoverFreshOpenClawImagePluginInstalls: () => ({
            ok: false,
            error: "registry unreadable",
          }),
          restoreRecreatedSandboxState,
          getDcodeSelectionDrift: vi.fn(),
          register,
          note: vi.fn(),
          error,
          exitProcess: (code): never => {
            throw new Error(`exit ${code}`);
          },
        },
      ),
    ).toThrow("exit 1");

    expect(restoreRecreatedSandboxState).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("registry unreadable"));
    expect(error).toHaveBeenCalledWith(
      "  State was not restored and registry metadata was not updated.",
    );
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Verify its durable identity"));
    expect(error.mock.calls.flat().join("\n")).not.toContain("openshell sandbox delete");
    expect(error).toHaveBeenCalledWith(
      "  Then rerun the original `nemoclaw onboard --from <Dockerfile>` command.",
    );
    expect(error).toHaveBeenCalledWith("  Manual recovery: /tmp/openclaw-backup");
  });

  it("does not register after a marked backup provenance mismatch", () => {
    const register = vi.fn();
    const error = vi.fn();

    expect(() =>
      finalizeCreatedSandbox(
        {
          sandboxName: "openclaw",
          restoreBackupPath: "/tmp/openclaw-backup",
          preUpgradeBackup: false,
          targetAgentType: "openclaw",
          discoverOpenClawImagePluginInstalls: true,
          validateManagedDcode: false,
          provider: "compatible-endpoint",
          model: "demo",
          preferredInferenceApi: "openai-completions",
        },
        {
          discoverFreshOpenClawImagePluginInstalls: () => ({
            ok: true,
            extensionDirs: ["weather"],
            pluginInstalls,
          }),
          restoreRecreatedSandboxState: () => ({
            success: false,
            restoredDirs: [],
            failedDirs: ["manifest"],
            restoredFiles: [],
            failedFiles: [],
            error: sandboxState.OPENCLAW_IMAGE_PLUGIN_PROVENANCE_RESTORE_ERROR,
          }),
          getDcodeSelectionDrift: vi.fn(),
          register,
          note: vi.fn(),
          error,
          exitProcess: (code): never => {
            throw new Error(`exit ${code}`);
          },
        },
      ),
    ).toThrow("exit 1");

    expect(register).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("future rebuild would be unsafe"));
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(sandboxState.OPENCLAW_IMAGE_PLUGIN_PROVENANCE_RESTORE_ERROR),
    );
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Verify its durable identity"));
    expect(error.mock.calls.flat().join("\n")).not.toContain("openshell sandbox delete");
    expect(error).toHaveBeenCalledWith(
      "  Then rerun the original `nemoclaw onboard --from <Dockerfile>` command.",
    );
    expect(error).toHaveBeenCalledWith("  Manual recovery: /tmp/openclaw-backup");
  });
});

describe("created sandbox completion actions", () => {
  it.each([
    ["ordinary", true, false],
    ["schema-5", false, true],
  ] as const)(
    "keeps %s dashboard completion ordered and bounded (#9203)",
    async (_route, manageDashboard, schema5) => {
      const order: string[] = [];
      const gpuProof = {
        status: "verified" as const,
        cudaVerified: true,
        at: "2026-08-17T00:00:00.000Z",
      };
      const gpuConfig: SandboxGpuConfig = {
        mode: "1" as const,
        hostGpuDetected: true,
        hostGpuPlatform: "linux" as const,
        sandboxGpuEnabled: true,
        sandboxGpuDevice: null,
        errors: [],
      };
      const registerCreatedSandbox = vi.fn((input: CreatedSandboxRegistrationInput) => {
        order.push("registry");
        return input as unknown as SandboxEntry;
      });
      const verifiedCreateBoundary = {
        sandboxName: "hermes",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        lifecycleGeneration: "generation-1",
        lifecycleLiveIdentityFingerprint: "a".repeat(64),
        route: "native" as const,
      };
      const inferenceRouteReservation = {
        authority: {
          sandboxName: "hermes",
          gatewayName: "nemoclaw",
          sessionId: "session-1",
          ...TEST_PACKAGE_AUTHORITY,
          selection: {
            provider: "ollama",
            model: "qwen3-vl:4b",
            endpointUrl: "http://host.openshell.internal:11436/v1",
            endpointSource: "onboard" as const,
            credentialEnv: "NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN",
            preferredInferenceApi: "openai-completions",
            compatibleEndpointReasoning: null,
            compatibleEndpointReasoningEffort: null,
            nimContainer: null,
          },
        },
        entry: { name: "hermes" },
      } satisfies QualifiedSandboxInferenceRouteReservation;
      const verifiedCreate = {
        reservation: inferenceRouteReservation,
        checkpoint: pendingSandboxCreateIdentityForBoundary(verifiedCreateBoundary),
      } as NonNullable<CreatedSandboxRegistrationInput["verifiedCreate"]>;
      const completion = createCreatedSandboxCompletionActions(
        {
          finalization: {
            sandboxName: "hermes",
            restoreBackupPath: null,
            preUpgradeBackup: false,
            targetAgentType: "hermes",
            validateManagedDcode: false,
            provider: "ollama",
            model: "qwen3-vl:4b",
            preferredInferenceApi: "openai-completions",
          },
          registration: {
            sandboxName: "hermes",
            inferenceSelection: {
              provider: "ollama",
              model: "qwen3-vl:4b",
              endpointUrl: null,
              endpointSource: null,
              credentialEnv: null,
              preferredInferenceApi: "openai-completions",
              compatibleEndpointReasoning: null,
              compatibleEndpointReasoningEffort: null,
              nimContainer: null,
            },
            runtimeFields: {
              gpuEnabled: true,
              hostGpuDetected: true,
              sandboxGpuEnabled: true,
              sandboxGpuMode: "1",
              sandboxGpuDevice: null,
              sandboxGpuProof: null,
              openshellDriver: "docker",
              openshellVersion: "0.0.106",
            },
            agent: null,
            agentVersionKnown: true,
            plannedMessagingState: undefined,
            hermesToolGateways: [],
            gatewayName: "nemoclaw",
            gatewayPort: 8080,
          },
          policy: {
            initialPolicyPath: "/private/initial-policy.yaml",
            compatibilityPolicyPath: "/private/compatibility-policy.yaml",
            getVerifiedCreateBoundary: () => verifiedCreateBoundary,
            getVerifiedCreateRegistrationAuthority: () => verifiedCreate,
          },
          gpu: {
            config: gpuConfig,
            provider: "ollama",
            dockerDriverGateway: true,
            verifyDirectSandboxGpu: () => {
              order.push("gpu");
              return gpuProof;
            },
            runCaptureOpenshell: vi.fn(),
          },
          dashboard: {
            chatUiUrl: "http://127.0.0.1:8643",
            initialHermesState: { config: null, enabled: false },
            releasePort: async () => {
              order.push("dashboard-release");
            },
            getForwardPort: () => "8643",
            resolveHermesState: () => ({ config: null, enabled: false }),
          },
          workload: {
            runtime: {
              runtimeProvider: null,
              ensurePreparedWorkload: vi.fn(),
              ensurePreparedProfile: vi.fn(),
            },
            workload: {
              source: {
                kind: "legacy-dockerfile",
                dockerfilePath: "/workspace/Dockerfile",
                reason: "agent-not-managed",
              },
              release: null,
              fallbackDiagnostic: null,
            },
            prebuildImageRef: null,
            buildId: "build-1",
            extractBuiltImageRef: () => {
              order.push("workload");
              return "hermes:test";
            },
            resolveSandboxImageTagFromCreateOutput: vi.fn(),
          },
        },
        {
          discoverFreshOpenClawImagePluginInstalls: vi.fn(),
          restoreRecreatedSandboxState: vi.fn(),
          getDcodeSelectionDrift: vi.fn(),
          note: vi.fn(),
          error: vi.fn(),
          exitProcess: (code): never => {
            throw new Error(`unexpected exit ${code}`);
          },
          registerCreatedSandbox,
        },
      );
      const created = {
        createResult: { status: 0, output: "", sawProgress: true },
        route: "native",
        firstCreateOutput: "",
        registryImageRef: null,
        lifecycleRegistrationFields: { lifecycleGeneration: "generation-1" },
      } as SandboxGpuCreateFlowResult;
      const lifecycle = {
        generation: "generation-1",
        recordExactIdentity: () => ({
          lifecycleGeneration: "generation-1",
          lifecycleLiveIdentityFingerprint: "a".repeat(64),
        }),
        capture: () => {
          order.push("lifecycle-capture");
          return {
            lifecycleGeneration: "generation-1",
            lifecycleLiveIdentityFingerprint: "a".repeat(64),
          };
        },
        revalidate: (registration: {
          lifecycleGeneration: string;
          lifecycleLiveIdentityFingerprint: string;
        }) => {
          order.push("lifecycle-revalidate");
          return registration;
        },
      };
      const configuredReceipt = schema5
        ? ({
            lifecycleGeneration: "generation-1",
            openshellExecutableAuthority: { version: "0.0.106" },
            container: { imageId: "hermes:test" },
          } as unknown as HermesPortableConfiguredReceipt)
        : null;
      await completion.complete(
        schema5 ? null : created,
        configuredReceipt,
        "hermes",
        manageDashboard,
        () => ({ lifecycleGeneration: "generation-1" }),
        lifecycle,
        schema5 ? inferenceRouteReservation : undefined,
      );

      expect(order).toEqual([
        "lifecycle-capture",
        "lifecycle-revalidate",
        "gpu",
        ...(manageDashboard ? ["dashboard-release"] : []),
        ...(schema5 ? [] : ["workload"]),
        "lifecycle-revalidate",
        "registry",
      ]);
      expect(gpuConfig.sandboxGpuProof).toEqual(gpuProof);
      expect(registerCreatedSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          imageTag: "hermes:test",
          hermesPortableLifecycle: schema5,
          dashboardPort: manageDashboard ? 8643 : 0,
          lifecycleGeneration: "generation-1",
          lifecycleLiveIdentityFingerprint: "a".repeat(64),
          inferenceSelection: inferenceRouteReservation.authority.selection,
          inferenceRouteReservation,
          verifiedCreate,
          runtimeFields: expect.objectContaining({ sandboxGpuProof: gpuProof }),
        }),
      );
    },
  );
});
