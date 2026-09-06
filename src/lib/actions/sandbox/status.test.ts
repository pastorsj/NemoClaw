// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import type { ProviderHealthProbeOptions } from "../../inference/health";
import type { SandboxEntry } from "../../state/registry";
import {
  classifySandboxContainerFailureForStatus,
  classifySandboxStatusPreflightFailure,
  getSandboxStatusInferenceHealth,
  getSandboxStatusReport,
  isDockerDaemonUnreachableForStatus,
  maybeGetSandboxStatusInferenceHealth,
  resolveLegacyDcodeAutoApprovalMode,
  sandboxGpuProofStatusSuffix,
  sandboxGpuProofUnverified,
} from "./status";
import { resolveSandboxStatusAgent } from "./status-snapshot";

function futurePackageStatusFixture(runtimeKind: "gateway" | "terminal") {
  const agentName = `future-${runtimeKind}`;
  const harnessPackage = {
    kind: "agent-runtime" as const,
    id: agentName,
    packageVersion: "4.5.6",
    contentDigest: (runtimeKind === "gateway" ? "c" : "d").repeat(64),
  };
  const entry = {
    name: agentName,
    agent: agentName,
    harnessPackage,
  } satisfies SandboxEntry;
  const selectedAgent = {
    recordedAgent: agentName,
    effectiveAgentId: agentName,
    definition: {
      name: agentName,
      displayName: `Future ${runtimeKind}`,
      packageRoot: `/state/harnesses/objects/${harnessPackage.contentDigest}`,
      runtime: { kind: runtimeKind },
    },
    harnessPackage,
    harnessPackageMigration: null,
  };
  return { agentName, entry, selectedAgent };
}

describe("sandbox status package definition", () => {
  it.each(["gateway", "terminal"] as const)(
    "describes a receipt-backed future %s from its exact definition",
    (runtimeKind) => {
      const fixture = futurePackageStatusFixture(runtimeKind);
      const resolveSandboxAgentImpl = vi.fn(() => fixture.selectedAgent);

      const statusAgent = resolveSandboxStatusAgent(fixture.entry, {
        resolveSandboxAgentImpl: resolveSandboxAgentImpl as never,
      });

      expect(statusAgent).toMatchObject({
        agentName: fixture.agentName,
        agentDisplayName: `Future ${runtimeKind}`,
        agentRuntime: runtimeKind,
        agentDefinition: fixture.selectedAgent.definition,
      });
      expect(statusAgent.agentLoadError).toBeUndefined();
      expect(statusAgent.packageAuthorityInvalid).toBeUndefined();
      expect(resolveSandboxAgentImpl).toHaveBeenCalledWith(fixture.entry);
    },
  );

  it("resolves package-backed OpenClaw when its recorded agent is null", () => {
    const fixture = futurePackageStatusFixture("gateway");
    const harnessPackage = { ...fixture.entry.harnessPackage!, id: "openclaw" };
    const entry = { ...fixture.entry, agent: null, harnessPackage };
    const selectedAgent = {
      ...fixture.selectedAgent,
      recordedAgent: null,
      effectiveAgentId: "openclaw",
      definition: { ...fixture.selectedAgent.definition, name: "openclaw" },
      harnessPackage,
    };

    const statusAgent = resolveSandboxStatusAgent(entry, {
      resolveSandboxAgentImpl: vi.fn(() => selectedAgent) as never,
    });

    expect(statusAgent).toMatchObject({
      agentName: "openclaw",
      agentRuntime: "gateway",
    });
    expect(statusAgent.packageAuthorityInvalid).toBeUndefined();
  });

  it("reports unknown instead of using an ambient definition when receipt authority disagrees", () => {
    const fixture = futurePackageStatusFixture("gateway");
    const loadAgentImpl = vi.fn();

    const statusAgent = resolveSandboxStatusAgent(fixture.entry, {
      loadAgentImpl: loadAgentImpl as never,
      resolveSandboxAgentImpl: vi.fn(() => ({
        ...fixture.selectedAgent,
        definition: { ...fixture.selectedAgent.definition, name: "different-gateway" },
      })) as never,
    });

    expect(statusAgent.agentRuntime).toBe("unknown");
    expect(statusAgent.agentDefinition).toBeNull();
    expect(statusAgent.agentLoadError).toContain("does not match the sandbox package receipt");
    expect(statusAgent.packageAuthorityInvalid).toBe(true);
    expect(loadAgentImpl).not.toHaveBeenCalled();
  });

  it("keeps a missing legacy definition nonfatal", () => {
    const statusAgent = resolveSandboxStatusAgent("legacy-missing", {
      loadAgentImpl: vi.fn(() => {
        throw new Error("legacy definition unavailable");
      }),
    });

    expect(statusAgent).toMatchObject({
      agentName: "legacy-missing",
      agentRuntime: "unknown",
      agentLoadError: "legacy definition unavailable",
    });
    expect(statusAgent.packageAuthorityInvalid).toBeUndefined();
  });
});

describe("sandbox status DCode auto-approval (#6478)", () => {
  it("defaults legacy DCode entries to disabled", () => {
    expect(
      resolveLegacyDcodeAutoApprovalMode({
        name: "dcode",
        agent: "langchain-deepagents-code",
      } as never),
    ).toBe("disabled");
  });

  it("projects durable serving profile provenance into JSON status (#8384)", async () => {
    const provenance = {
      schemaVersion: 1,
      catalogDigest: `sha256:${"1".repeat(64)}`,
      preset: {
        id: "vllm.dgx-spark-gb10.single.example",
        digest: `sha256:${"2".repeat(64)}`,
        displayName: "Example Spark profile",
        supportState: "experimental",
      },
      recipe: {
        id: "vllm.dgx-spark-gb10.single.example",
        digest: `sha256:${"3".repeat(64)}`,
        backend: "vllm",
      },
      model: { id: "example/model", revision: "revision-1" },
      runtimeImage: null,
      estimatedImageDownloadBytes: null,
      estimatedModelDownloadBytes: null,
    } as const;
    const report = await getSandboxStatusReport("profile-test", {
      getSandbox: () =>
        ({
          name: "profile-test",
          agent: "openclaw",
          servingProfileProvenance: provenance,
        }) as never,
      reconcile: async () => ({ state: "missing" as const, output: "not found" }),
    });

    expect(report.servingProfileProvenance).toEqual(provenance);
  });

  it("projects effective DCode mode into JSON while using null for other agents", async () => {
    const missingLookup = async () => ({ state: "missing" as const, output: "not found" });
    const legacyDcode = await getSandboxStatusReport("dcode", {
      getSandbox: () => ({ name: "dcode", agent: "langchain-deepagents-code" }) as never,
      reconcile: missingLookup,
    });
    const openclaw = await getSandboxStatusReport("openclaw", {
      getSandbox: () => ({ name: "openclaw", agent: "openclaw" }) as never,
      reconcile: missingLookup,
    });

    expect(legacyDcode.dcodeAutoApprovalMode).toBe("disabled");
    expect(openclaw.dcodeAutoApprovalMode).toBeNull();
  });

  it("reports the recorded DCode mode and omits it for other agents", () => {
    expect(
      resolveLegacyDcodeAutoApprovalMode({
        name: "dcode",
        agent: "langchain-deepagents-code",
        dcodeAutoApprovalMode: "thread-opt-in",
      } as never),
    ).toBe("thread-opt-in");
    expect(
      resolveLegacyDcodeAutoApprovalMode({
        name: "openclaw",
        agent: "openclaw",
        dcodeAutoApprovalMode: "thread-opt-in",
      } as never),
    ).toBeNull();
  });

  it("does not project the legacy DCode field through receipt-backed package authority", () => {
    expect(
      resolveLegacyDcodeAutoApprovalMode({
        name: "dcode",
        agent: "langchain-deepagents-code",
        dcodeAutoApprovalMode: "thread-opt-in",
        harnessPackage: {
          kind: "agent-runtime",
          id: "langchain-deepagents-code",
          packageVersion: "1.2.3",
          contentDigest: "a".repeat(64),
        },
      } as never),
    ).toBeNull();
  });
});

describe("sandbox status host mounts", () => {
  it("projects durable read-only host mounts into JSON status", async () => {
    const source = fs.mkdtempSync(path.join(process.cwd(), ".status-host-mount-test-"));
    const hostMounts = [{ source, target: "/sandbox/project", readOnly: true as const }];
    try {
      const report = await getSandboxStatusReport("alpha", {
        getSandbox: () => ({ name: "alpha", hostMounts }) as never,
        reconcile: async () => ({ state: "missing" as const, output: "not found" }),
      });

      expect(report.hostMounts).toEqual(hostMounts);
      expect(report.hostMounts).not.toBe(hostMounts);
      expect(report.hostMounts?.[0]).not.toBe(hostMounts[0]);
    } finally {
      fs.rmSync(source, { recursive: true, force: true });
    }
  });

  it("rejects malformed and terminal-control host mounts before JSON rendering", async () => {
    const reportFor = (hostMounts: unknown) =>
      getSandboxStatusReport("alpha", {
        getSandbox: () => ({ name: "alpha", hostMounts }) as never,
        reconcile: async () => ({ state: "missing" as const, output: "not found" }),
      });

    await expect(reportFor("not-an-array")).rejects.toThrow(
      "Persisted host mount state must be an array",
    );
    await expect(
      reportFor([
        {
          source: "/srv/project\u202e",
          target: "/sandbox/project",
          readOnly: true,
        },
      ]),
    ).rejects.toThrow("unsafe terminal control characters");
  });
});

describe("sandbox status inference health", () => {
  it("passes the current model with the current provider", () => {
    let observed: { provider: string; options?: ProviderHealthProbeOptions } | null = null;

    const result = getSandboxStatusInferenceHealth(
      true,
      "nvidia-prod",
      "moonshotai/kimi-k2.6",
      (provider, options) => {
        observed = { provider, options };
        return {
          ok: true,
          probed: true,
          providerLabel: "NVIDIA Endpoints",
          endpoint: "https://integrate.api.nvidia.com/v1/chat/completions",
          detail: "healthy",
        };
      },
    );

    expect(result?.ok).toBe(true);
    expect(observed).toEqual({
      provider: "nvidia-prod",
      options: { model: "moonshotai/kimi-k2.6" },
    });
  });

  it("does not probe when the sandbox gateway is not present", () => {
    let called = false;

    const result = getSandboxStatusInferenceHealth(
      false,
      "nvidia-prod",
      "moonshotai/kimi-k2.6",
      () => {
        called = true;
        return null;
      },
    );

    expect(result).toBeNull();
    expect(called).toBe(false);
  });
});

describe("isDockerDaemonUnreachableForStatus", () => {
  it("returns false when sandbox entry is null", () => {
    expect(isDockerDaemonUnreachableForStatus(null, () => false)).toBe(false);
  });

  it("returns false when the openshell driver is not docker", () => {
    expect(
      isDockerDaemonUnreachableForStatus(
        { name: "alpha", openshellDriver: "vm" } as never,
        () => false,
      ),
    ).toBe(false);
  });

  it("returns true when driver is docker and the probe reports unreachable", () => {
    expect(
      isDockerDaemonUnreachableForStatus(
        { name: "alpha", openshellDriver: "docker" } as never,
        () => false,
      ),
    ).toBe(true);
  });

  it("returns false when driver is docker and the probe reports reachable", () => {
    expect(
      isDockerDaemonUnreachableForStatus(
        { name: "alpha", openshellDriver: "docker" } as never,
        () => true,
      ),
    ).toBe(false);
  });
});

describe("classifySandboxContainerFailureForStatus", () => {
  it("returns null when sandbox entry is null", async () => {
    const probe = async () => {
      throw new Error("probe should not be invoked");
    };
    await expect(classifySandboxContainerFailureForStatus(null, probe)).resolves.toBeNull();
  });

  it("returns null when the openshell driver is not docker", async () => {
    let called = false;
    const probe = async () => {
      called = true;
      return null;
    };
    await expect(
      classifySandboxContainerFailureForStatus(
        { name: "alpha", openshellDriver: "vm" } as never,
        probe,
      ),
    ).resolves.toBeNull();
    expect(called).toBe(false);
  });

  it("forwards the sandbox name and dashboard port to the probe and propagates its verdict", async () => {
    const observed: { sandboxName: string; port: number | null }[] = [];
    const probe = async (sandboxName: string, dashboardPort: number | null) => {
      observed.push({ sandboxName, port: dashboardPort });
      return {
        layer: "sandbox_dashboard_port_conflict" as const,
        detail: "stub failure",
      };
    };
    const result = await classifySandboxContainerFailureForStatus(
      {
        name: "alpha",
        openshellDriver: "docker",
        dashboardPort: 18900,
      } as never,
      probe,
    );
    expect(result).toEqual({
      layer: "sandbox_dashboard_port_conflict",
      detail: "stub failure",
    });
    expect(observed).toEqual([{ sandboxName: "alpha", port: 18900 }]);
  });

  it("passes null when the sandbox entry has no dashboard port recorded", async () => {
    const observed: { sandboxName: string; port: number | null }[] = [];
    const probe = async (sandboxName: string, dashboardPort: number | null) => {
      observed.push({ sandboxName, port: dashboardPort });
      return null;
    };
    await expect(
      classifySandboxContainerFailureForStatus(
        { name: "alpha", openshellDriver: "docker" } as never,
        probe,
      ),
    ).resolves.toBeNull();
    expect(observed).toEqual([{ sandboxName: "alpha", port: null }]);
  });
});

describe("maybeGetSandboxStatusInferenceHealth", () => {
  it("does not invoke the provider probe when suppressInferenceProbe is true even with a present gateway and string provider", () => {
    let probeCalls = 0;
    const result = maybeGetSandboxStatusInferenceHealth(
      true,
      true,
      "nvidia-prod",
      "nvidia/nemotron",
      (...args) => {
        probeCalls += 1;
        throw new Error(`probeProviderHealth should not be invoked (args=${JSON.stringify(args)})`);
      },
    );
    expect(result).toBeNull();
    expect(probeCalls).toBe(0);
  });

  it("delegates to the probe when suppressInferenceProbe is false", () => {
    const calls: { provider: string; options?: ProviderHealthProbeOptions }[] = [];
    const result = maybeGetSandboxStatusInferenceHealth(
      false,
      true,
      "nvidia-prod",
      "nvidia/nemotron",
      (provider, options) => {
        calls.push({ provider, options });
        return {
          ok: true,
          probed: true,
          providerLabel: "NVIDIA Endpoints",
          endpoint: "https://integrate.api.nvidia.com/v1/chat/completions",
          detail: "healthy",
        };
      },
    );
    expect(result?.ok).toBe(true);
    expect(calls).toEqual([{ provider: "nvidia-prod", options: { model: "nvidia/nemotron" } }]);
  });
});

describe("classifySandboxStatusPreflightFailure", () => {
  it("returns docker_unreachable when the daemon probe reports unreachable", async () => {
    let sandboxProbeCalled = false;
    const result = await classifySandboxStatusPreflightFailure(
      { name: "alpha", openshellDriver: "docker" } as never,
      {
        dockerProbe: () => false,
        sandboxContainerProbe: async () => {
          sandboxProbeCalled = true;
          return null;
        },
      },
    );
    expect(result).toEqual({ layer: "docker_unreachable", dockerUnreachable: true });
    // Short-circuits: a daemon that is already known to be down must not
    // trigger a follow-up `docker ps` round trip.
    expect(sandboxProbeCalled).toBe(false);
  });

  it("returns the sandbox container failure when the daemon is reachable", async () => {
    const result = await classifySandboxStatusPreflightFailure(
      { name: "alpha", openshellDriver: "docker", dashboardPort: 18789 } as never,
      {
        dockerProbe: () => true,
        sandboxContainerProbe: async (sandboxName, dashboardPort) => {
          expect(sandboxName).toBe("alpha");
          expect(dashboardPort).toBe(18789);
          return {
            layer: "sandbox_dashboard_port_conflict",
            detail: "stub failure",
          };
        },
      },
    );
    expect(result).toEqual({
      layer: "sandbox_dashboard_port_conflict",
      dockerUnreachable: false,
    });
  });

  it("returns null when the sandbox container probe finds no failure", async () => {
    const result = await classifySandboxStatusPreflightFailure(
      { name: "alpha", openshellDriver: "docker" } as never,
      {
        dockerProbe: () => true,
        sandboxContainerProbe: async () => null,
      },
    );
    expect(result).toBeNull();
  });

  it("returns null when the sandbox is not on the docker driver", async () => {
    let dockerCalled = false;
    let sandboxCalled = false;
    const result = await classifySandboxStatusPreflightFailure(
      { name: "alpha", openshellDriver: "vm" } as never,
      {
        dockerProbe: () => {
          dockerCalled = true;
          return false;
        },
        sandboxContainerProbe: async () => {
          sandboxCalled = true;
          return null;
        },
      },
    );
    expect(result).toBeNull();
    // Both gates are docker-driver-only; a vm sandbox must not provoke
    // either probe.
    expect(dockerCalled).toBe(false);
    expect(sandboxCalled).toBe(false);
  });

  it("returns null when the sandbox entry is null", async () => {
    const result = await classifySandboxStatusPreflightFailure(null);
    expect(result).toBeNull();
  });
});

describe("sandbox GPU proof status rendering (#4231)", () => {
  it("does not call an unproven GPU healthy", () => {
    expect(sandboxGpuProofUnverified(null)).toBe(true);
    expect(sandboxGpuProofUnverified(undefined)).toBe(true);
    expect(sandboxGpuProofUnverified({ status: "unverified", cudaVerified: false, at: "t" })).toBe(
      true,
    );
    expect(sandboxGpuProofUnverified({ status: "verified", cudaVerified: true, at: "t" })).toBe(
      false,
    );
    expect(sandboxGpuProofUnverified({ status: "failed", cudaVerified: false, at: "t" })).toBe(
      false,
    );
  });

  it("renders verified / unverified / failed suffixes distinctly", () => {
    expect(
      sandboxGpuProofStatusSuffix({ status: "verified", cudaVerified: true, at: "t" }),
    ).toContain("CUDA verified");
    // No recorded proof (older entries) must not read as healthy.
    expect(sandboxGpuProofStatusSuffix(null)).toContain("CUDA unverified");
    expect(
      sandboxGpuProofStatusSuffix({ status: "unverified", cudaVerified: false, at: "t" }),
    ).toContain("CUDA unverified");
    const failed = sandboxGpuProofStatusSuffix({
      status: "failed",
      cudaVerified: false,
      label: "cuInit(0)",
      at: "t",
    });
    expect(failed).toContain("last CUDA proof failed");
    expect(failed).toContain("cuInit(0)");
  });
});
