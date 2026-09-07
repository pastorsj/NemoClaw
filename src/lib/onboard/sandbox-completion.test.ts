// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../state/registry";
import type { QualifiedSandboxInferenceRouteReservation } from "../state/registry/route-reservation";
import * as sandboxState from "../state/sandbox";
import type { RebuildManifest } from "../state/sandbox";
import type { HermesPortableConfiguredReceipt } from "./experimental/hermes-portable-receipt";
import type { SandboxGpuCreateFlowResult } from "./sandbox-gpu-create-flow";
import type { SandboxGpuConfig } from "./sandbox-gpu-mode";
import type { CreatedSandboxRegistrationInput } from "./sandbox-registration";
import {
  createCreatedSandboxCompletionActions,
  finalizeCreatedSandbox,
} from "./created-sandbox-finalization";
import { pendingSandboxCreateIdentityForBoundary } from "./sandbox-create/identity-boundary";

const TEST_PACKAGE_AUTHORITY = {
  harnessPackage: null,
  harnessPackageMigration: null,
} as const;

function preparedRestoreAuthority(sandboxName: string) {
  const prepared = { name: sandboxName } as SandboxEntry;
  return {
    prepareRegistration: () => prepared,
    revalidatePreparedRegistration: (target: SandboxEntry) => target,
  };
}

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

  it("discovers and restores a synthetic package through the managed-extension contract", () => {
    const managedExtensionDeclaration = {
      support: "managed" as const,
      controller: { command: ["/opt/future/state-controller"], timeout_seconds: 10 },
      state_directory: "addons",
      preserved_directories: [],
      allowed_symlinks: [],
    };
    const managedExtensions = [
      { id: "future-weather", directory: "weather", configPaths: ["/opt/future/weather"] },
    ];
    const restoreRecreatedSandboxState = vi.fn(() => ({
      success: true,
      restoredDirs: ["addons"],
      failedDirs: [],
      restoredFiles: [],
      failedFiles: [],
    }));
    const register = vi.fn();

    finalizeCreatedSandbox(
      {
        sandboxName: "future-sandbox",
        restoreBackupPath: "/tmp/future-backup",
        preUpgradeBackup: false,
        targetAgentType: "future-harness",
        agentDefinition: {
          stateLifecycle: { rebuild: { managed_extensions: managedExtensionDeclaration } },
        } as never,
        discoverManagedImageExtensions: true,
        managedExtensionDeclaration,
        validateManagedDcode: false,
        provider: "compatible-endpoint",
        model: "demo",
        preferredInferenceApi: "openai-completions",
      },
      {
        ...preparedRestoreAuthority("future-sandbox"),
        discoverFreshOpenClawImagePluginInstalls: vi.fn(),
        discoverFreshManagedImageExtensions: () => ({ ok: true, extensions: managedExtensions }),
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

    expect(restoreRecreatedSandboxState).toHaveBeenCalledWith(
      "future-sandbox",
      "/tmp/future-backup",
      expect.objectContaining({
        targetAgentType: "future-harness",
        freshManagedImageExtensions: managedExtensions,
      }),
      expect.any(Function),
    );
    expect(register).toHaveBeenCalledWith(undefined, expect.anything(), managedExtensions);
  });

  it("does not restore or register when a synthetic package controller fails", () => {
    const managedExtensionDeclaration = {
      support: "managed" as const,
      controller: { command: ["/opt/future/state-controller"], timeout_seconds: 10 },
      state_directory: "addons",
      preserved_directories: [],
      allowed_symlinks: [],
    };
    const restoreRecreatedSandboxState = vi.fn();
    const register = vi.fn();

    expect(() =>
      finalizeCreatedSandbox(
        {
          sandboxName: "future-sandbox",
          restoreBackupPath: "/tmp/future-backup",
          preUpgradeBackup: false,
          targetAgentType: "future-harness",
          discoverManagedImageExtensions: true,
          managedExtensionDeclaration,
          validateManagedDcode: false,
          provider: "compatible-endpoint",
          model: "demo",
          preferredInferenceApi: "openai-completions",
        },
        {
          ...preparedRestoreAuthority("future-sandbox"),
          discoverFreshOpenClawImagePluginInstalls: vi.fn(),
          discoverFreshManagedImageExtensions: () => ({
            ok: false,
            error: "managed-extension inspection response is invalid",
          }),
          restoreRecreatedSandboxState,
          getDcodeSelectionDrift: vi.fn(),
          register,
          note: vi.fn(),
          error: vi.fn(),
          exitProcess: (code): never => {
            throw new Error(`exit ${code}`);
          },
        },
      ),
    ).toThrow("exit 1");
    expect(restoreRecreatedSandboxState).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it("preserves the fresh image plugin baseline across recreation before registration", () => {
    const order: string[] = [];
    const register = vi.fn(() => {
      order.push("register");
    });
    const restoreRecreatedSandboxState = vi.fn(() => {
      order.push("restore");
      return {
        success: true,
        restoredDirs: ["extensions"],
        failedDirs: [],
        restoredFiles: ["openclaw.json"],
        failedFiles: [],
      };
    });

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
        ...preparedRestoreAuthority("openclaw"),
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

    expect(order).toEqual(["discover", "restore", "register"]);
    expect(restoreRecreatedSandboxState).toHaveBeenCalledWith(
      "openclaw",
      "/tmp/openclaw-backup",
      {
        targetAgentType: "openclaw",
        freshOpenClawImagePluginInstalls: pluginInstalls,
      },
      expect.any(Function),
    );
    expect(register).toHaveBeenCalledWith(pluginInstalls, expect.anything());
  });

  it("restores through a revalidated target row before publishing it (#10546)", () => {
    const order: string[] = [];
    const prepared = { name: "openclaw" } as SandboxEntry;
    const restoredTarget = { ...prepared } as SandboxEntry;
    const publishedTarget = { ...prepared } as SandboxEntry;
    const expectedTargets = [prepared, restoredTarget];
    const refreshedTargets = [restoredTarget, publishedTarget];
    const register = vi.fn((_plugins, target) => {
      order.push("register");
      expect(target).toBe(publishedTarget);
      return target;
    });
    let revalidation = 0;

    const result = finalizeCreatedSandbox(
      {
        sandboxName: "openclaw",
        restoreBackupPath: "/tmp/managed-openclaw-backup",
        preUpgradeBackup: true,
        targetAgentType: "openclaw",
        validateManagedDcode: false,
        provider: "compatible-endpoint",
        model: "demo",
        preferredInferenceApi: "openai-completions",
      },
      {
        discoverFreshOpenClawImagePluginInstalls: vi.fn(),
        prepareRegistration: () => {
          order.push("prepare");
          return prepared;
        },
        revalidatePreparedRegistration: (target) => {
          order.push("revalidate");
          expect(target).toBe(expectedTargets[revalidation]);
          return refreshedTargets[revalidation++]!;
        },
        restoreRecreatedSandboxState: (_name, _backupPath, _options, resolveTarget) => {
          order.push("restore");
          expect(resolveTarget?.()).toBe(restoredTarget);
          return {
            success: true,
            restoredDirs: ["workspace"],
            failedDirs: [],
            restoredFiles: [],
            failedFiles: [],
          };
        },
        getDcodeSelectionDrift: vi.fn(),
        register,
        note: vi.fn(),
        error: vi.fn(),
        exitProcess: (code): never => {
          throw new Error(`exit ${code}`);
        },
      },
    );

    expect(result).toBe(publishedTarget);
    expect(order).toEqual(["prepare", "restore", "revalidate", "revalidate", "register"]);
    expect(register).toHaveBeenCalledWith(undefined, publishedTarget);
  });

  it("does not publish the prepared target when managed restore fails (#10546)", () => {
    const prepared = { name: "openclaw" } as SandboxEntry;
    const register = vi.fn();

    expect(() =>
      finalizeCreatedSandbox(
        {
          sandboxName: "openclaw",
          restoreBackupPath: "/tmp/managed-openclaw-backup",
          preUpgradeBackup: true,
          targetAgentType: "openclaw",
          validateManagedDcode: false,
          provider: "compatible-endpoint",
          model: "demo",
          preferredInferenceApi: "openai-completions",
        },
        {
          discoverFreshOpenClawImagePluginInstalls: vi.fn(),
          prepareRegistration: () => prepared,
          revalidatePreparedRegistration: () => prepared,
          restoreRecreatedSandboxState: (_name, _backupPath, _options, resolveTarget) => {
            expect(resolveTarget?.()).toBe(prepared);
            return {
              success: false,
              restoredDirs: [],
              failedDirs: ["workspace"],
              restoredFiles: [],
              failedFiles: [],
              error: "copy failed",
            };
          },
          getDcodeSelectionDrift: vi.fn(),
          register,
          note: vi.fn(),
          error: vi.fn(),
          exitProcess: (code): never => {
            throw new Error(`exit ${code}`);
          },
        },
      ),
    ).toThrow("exit 1");

    expect(register).not.toHaveBeenCalled();
  });

  it("fails closed before restore when prepared registration authority is unavailable", () => {
    const register = vi.fn();
    const error = vi.fn();
    const restoreRecreatedSandboxState = vi.fn();

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
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("has no prepared registration authority"),
    );
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
          ...preparedRestoreAuthority("openclaw"),
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
          ...preparedRestoreAuthority("openclaw"),
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
              receiptAgentDefinition: null,
              ensurePreparedWorkload: vi.fn(),
              ensurePreparedProfile: vi.fn(() => null),
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
