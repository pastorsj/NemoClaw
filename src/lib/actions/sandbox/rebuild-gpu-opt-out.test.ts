// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentDefinition } from "../../agent/defs";
import type { HarnessPackageIdentity } from "../../harness/package-identity";
import type { ResolvedSandboxAgent } from "../../onboard/sandbox-agent";
import type { SandboxBaseImageResolutionMetadata } from "../../sandbox-base-image";

import {
  buildRebuildRecreateOnboardOpts,
  getRebuildSandboxGpuOverrides,
  rebuildShouldOptOutGpu,
} from "./rebuild-gpu-opt-out";

function packageIdentity(id: string): HarnessPackageIdentity {
  return {
    kind: "agent-runtime" as const,
    id,
    packageVersion: "1.0.0",
    contractVersion: 1,
    contentDigest: "a".repeat(64),
  };
}

function pinnedDefinition(name: string): AgentDefinition {
  const terminal = name === "langchain-deepagents-code";
  return {
    name,
    packageRoot: `/pinned/${name}`,
    runtime: { kind: terminal ? "terminal" : "service" },
    forward_ports: terminal ? [] : [18_789],
  } as AgentDefinition;
}

const OPENCLAW_PACKAGE = packageIdentity("openclaw");
const HERMES_PACKAGE = packageIdentity("hermes");
const DCODE_PACKAGE = packageIdentity("langchain-deepagents-code");
const OPENCLAW_DEFINITION = pinnedDefinition("openclaw");
const HERMES_DEFINITION = pinnedDefinition("hermes");
const DCODE_DEFINITION = pinnedDefinition("langchain-deepagents-code");

function pinnedAuthority(
  recordedAgent: string | null,
  definition: AgentDefinition,
  harnessPackage: HarnessPackageIdentity,
): ResolvedSandboxAgent {
  return {
    recordedAgent,
    effectiveAgentId: definition.name,
    definition,
    harnessPackage,
    harnessPackageMigration: null,
  };
}

const OPENCLAW_AUTHORITY = pinnedAuthority(null, OPENCLAW_DEFINITION, OPENCLAW_PACKAGE);
const HERMES_AUTHORITY = pinnedAuthority("hermes", HERMES_DEFINITION, HERMES_PACKAGE);
const DCODE_AUTHORITY = pinnedAuthority(
  "langchain-deepagents-code",
  DCODE_DEFINITION,
  DCODE_PACKAGE,
);
const OPENCLAW_MIGRATION = {
  schemaVersion: 1,
  source: "legacy-current-bundle",
  legacyAgent: null,
  migratedAt: "2026-08-28T05:00:00.000Z",
} as const;

describe("rebuildShouldOptOutGpu", () => {
  it("returns false when the registry entry is null", () => {
    expect(rebuildShouldOptOutGpu(null)).toBe(false);
    expect(rebuildShouldOptOutGpu(undefined)).toBe(false);
  });

  it("returns true when sandboxGpuMode is the explicit opt-out '0'", () => {
    expect(rebuildShouldOptOutGpu({ sandboxGpuMode: "0", sandboxGpuEnabled: false })).toBe(true);
    expect(rebuildShouldOptOutGpu({ sandboxGpuMode: "0" })).toBe(true);
  });

  it("returns false when sandboxGpuMode is 'auto' (CPU fallback is not explicit opt-out)", () => {
    expect(
      rebuildShouldOptOutGpu({
        sandboxGpuMode: "auto",
        sandboxGpuEnabled: false,
      }),
    ).toBe(false);
    expect(
      rebuildShouldOptOutGpu({
        sandboxGpuMode: "auto",
        sandboxGpuEnabled: true,
      }),
    ).toBe(false);
  });

  it("returns false when sandboxGpuMode is '1' regardless of sandboxGpuEnabled", () => {
    expect(rebuildShouldOptOutGpu({ sandboxGpuMode: "1", sandboxGpuEnabled: true })).toBe(false);
    expect(rebuildShouldOptOutGpu({ sandboxGpuMode: "1", sandboxGpuEnabled: false })).toBe(false);
  });

  it("falls back to gpuEnabled=false for legacy entries with no sandboxGpuMode", () => {
    expect(rebuildShouldOptOutGpu({ gpuEnabled: false })).toBe(true);
  });

  it("ignores legacy gpuEnabled=false when sandboxGpuEnabled=true is recorded", () => {
    expect(rebuildShouldOptOutGpu({ sandboxGpuEnabled: true, gpuEnabled: false })).toBe(false);
  });

  it("returns false when no GPU metadata is recorded", () => {
    expect(rebuildShouldOptOutGpu({})).toBe(false);
  });

  it("returns false when only gpuEnabled=true is recorded", () => {
    expect(rebuildShouldOptOutGpu({ gpuEnabled: true })).toBe(false);
  });

  it("does NOT route malformed sandboxGpuMode values through the legacy gpuEnabled fallback", () => {
    expect(
      rebuildShouldOptOutGpu({
        sandboxGpuMode: "bogus" as unknown as string,
        gpuEnabled: false,
      }),
    ).toBe(false);
    expect(
      rebuildShouldOptOutGpu({
        sandboxGpuMode: "bogus" as unknown as string,
        sandboxGpuEnabled: true,
      }),
    ).toBe(false);
  });

  it("falls back to legacy gpuEnabled when sandboxGpuMode is an empty string", () => {
    expect(
      rebuildShouldOptOutGpu({
        sandboxGpuMode: "" as unknown as string,
        gpuEnabled: false,
      }),
    ).toBe(true);
  });

  it("normalises mixed-case mode 'AUTO' and aliases like 'off' through normalizeSandboxGpuMode", () => {
    expect(
      rebuildShouldOptOutGpu({
        sandboxGpuMode: "AUTO" as unknown as string,
        sandboxGpuEnabled: false,
      }),
    ).toBe(false);
    expect(
      rebuildShouldOptOutGpu({
        sandboxGpuMode: "off" as unknown as string,
      }),
    ).toBe(true);
    expect(
      rebuildShouldOptOutGpu({
        sandboxGpuMode: "false" as unknown as string,
      }),
    ).toBe(true);
    expect(
      rebuildShouldOptOutGpu({
        sandboxGpuMode: "TRUE" as unknown as string,
        sandboxGpuEnabled: false,
      }),
    ).toBe(false);
  });
});

describe("getRebuildSandboxGpuOverrides", () => {
  it("pins forced GPU mode and its recorded device", () => {
    expect(
      getRebuildSandboxGpuOverrides({
        sandboxGpuMode: "1",
        sandboxGpuEnabled: true,
        sandboxGpuDevice: "nvidia.com/gpu=2",
      }),
    ).toEqual({
      sandboxGpu: "enable",
      sandboxGpuDevice: "nvidia.com/gpu=2",
      sessionGpuPassthrough: true,
    });
  });

  it("pins opt-out while keeping auto distinct from cached enabled state", () => {
    expect(getRebuildSandboxGpuOverrides({ sandboxGpuMode: "0" })).toEqual({
      sandboxGpu: "disable",
      sandboxGpuDevice: null,
      sessionGpuPassthrough: false,
    });
    expect(
      getRebuildSandboxGpuOverrides({ sandboxGpuMode: "auto", sandboxGpuEnabled: true }),
    ).toEqual({
      sandboxGpu: null,
      sandboxGpuDevice: null,
      sessionGpuPassthrough: false,
    });
  });

  it("does not treat legacy effective-enabled fields as forced sandbox GPU", () => {
    expect(getRebuildSandboxGpuOverrides({ sandboxGpuEnabled: true, gpuEnabled: true })).toEqual({
      sandboxGpu: null,
      sandboxGpuDevice: null,
      sessionGpuPassthrough: false,
    });
  });
});

describe("buildRebuildRecreateOnboardOpts", () => {
  const baseArgs = {
    agentAuthority: OPENCLAW_AUTHORITY,
    storedFromDockerfile: null,
    autoYes: true,
    usageNoticeAccepted: true as const,
  };
  const dashboard = {
    agent: null,
    harnessPackage: OPENCLAW_PACKAGE,
    dashboardPort: 18789,
  };

  it("forwards noGpu:true when the recorded sandboxGpuMode is the explicit opt-out '0'", () => {
    const opts = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      sb: { ...dashboard, sandboxGpuMode: "0", sandboxGpuEnabled: false },
    });
    expect(opts.noGpu).toBe(true);
    expect(opts).toMatchObject({
      resume: true,
      nonInteractive: true,
      recreateSandbox: true,
      authoritativeResumeConfig: true,
      agent: null,
      fromDockerfile: null,
      sandboxGpu: "disable",
      sandboxGpuDevice: null,
      autoYes: true,
      toolDisclosure: "progressive",
      observabilityEnabled: false,
      observabilityRequestedExplicitly: false,
    });
  });

  it("carries recorded DCode auto-approval into authoritative recreation (#6478)", () => {
    const opts = buildRebuildRecreateOnboardOpts({
      sb: {
        agent: "langchain-deepagents-code",
        harnessPackage: DCODE_PACKAGE,
        dashboardPort: 0,
        gatewayName: "nemoclaw",
        dcodeAutoApprovalMode: "thread-opt-in",
      },
      agentAuthority: DCODE_AUTHORITY,
      storedFromDockerfile: null,
      autoYes: true,
      usageNoticeAccepted: true,
    });

    expect(opts.dcodeAutoApprovalMode).toBe("thread-opt-in");
    expect(opts.dcodeAutoApprovalRequestedExplicitly).toBe(false);
  });

  it("carries an explicit direct tool-disclosure selection into inner onboard", () => {
    const opts = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      sb: { ...dashboard, toolDisclosure: "direct" },
    });

    expect(opts.toolDisclosure).toBe("direct");
  });

  it("carries durable read-only host mounts into authoritative recreation", () => {
    const hostMounts = [
      { source: process.cwd(), target: "/sandbox/project", readOnly: true as const },
    ];
    const opts = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      sb: { ...dashboard, hostMounts },
    });

    expect(opts.hostMounts).toEqual([
      {
        ...hostMounts[0],
        sourceIdentity: { device: expect.any(String), inode: expect.any(String) },
      },
    ]);
    expect(opts.hostMounts).not.toBe(hostMounts);
  });

  it("preserves only recognized endpoint provenance across authoritative rebuild", () => {
    const onboard = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      sb: { ...dashboard, endpointSource: "onboard" },
    });
    const legacy = buildRebuildRecreateOnboardOpts({ ...baseArgs, sb: dashboard });
    const malformed = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      sb: { ...dashboard, endpointSource: "forged" } as typeof dashboard & {
        endpointSource: never;
      },
    });

    expect(onboard.endpointSource).toBe("onboard");
    expect(legacy.endpointSource).toBeNull();
    expect(malformed.endpointSource).toBeNull();
  });

  it("carries durable observability intent into inner onboard", () => {
    const enabled = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      agentAuthority: DCODE_AUTHORITY,
      sb: {
        agent: "langchain-deepagents-code",
        harnessPackage: DCODE_PACKAGE,
        dashboardPort: 0,
        observabilityEnabled: true,
      },
    });
    const legacy = buildRebuildRecreateOnboardOpts({ ...baseArgs, sb: dashboard });

    expect(enabled.observabilityEnabled).toBe(true);
    expect(legacy.observabilityEnabled).toBe(false);
  });

  it("carries the authoritative restricted tier with observability into inner onboard", () => {
    const opts = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      agentAuthority: DCODE_AUTHORITY,
      sb: {
        agent: "langchain-deepagents-code",
        harnessPackage: DCODE_PACKAGE,
        dashboardPort: 0,
        observabilityEnabled: true,
        policyTier: "restricted",
      },
    });

    expect(opts.policyTier).toBe("restricted");
    expect(opts.observabilityEnabled).toBe(true);
  });

  it("rejects an invalid recorded policy tier before destructive recreate work", () => {
    expect(() =>
      buildRebuildRecreateOnboardOpts({
        ...baseArgs,
        sb: { ...dashboard, policyTier: "unknown-tier" },
      }),
    ).toThrow("Invalid recorded policy tier 'unknown-tier'.");
  });

  it.each([
    ["openclaw", OPENCLAW_AUTHORITY, dashboard],
    [
      "hermes",
      HERMES_AUTHORITY,
      { agent: "hermes", harnessPackage: HERMES_PACKAGE, dashboardPort: 18_789 },
    ],
  ] as const)(
    "rejects malformed %s observability state before recreate onboarding",
    (_agentName, agentAuthority, entry) => {
      expect(() =>
        buildRebuildRecreateOnboardOpts({
          ...baseArgs,
          agentAuthority,
          sb: { ...entry, observabilityEnabled: true },
        }),
      ).toThrow(
        "Recorded observability state is valid only for agent 'langchain-deepagents-code'.",
      );
    },
  );

  it("forwards noGpu:true for legacy entries with gpuEnabled:false and no sandboxGpuMode", () => {
    const opts = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      sb: { ...dashboard, gpuEnabled: false },
    });
    expect(opts.noGpu).toBe(true);
  });

  it("omits noGpu for auto-mode CPU fallback so resume stays auto", () => {
    const opts = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      sb: { ...dashboard, sandboxGpuMode: "auto", sandboxGpuEnabled: false },
    });
    expect(opts).not.toHaveProperty("noGpu");
    expect(opts.sandboxGpu).toBeNull();
    expect(opts.sandboxGpuDevice).toBeNull();
  });

  it("omits noGpu when sandboxGpuMode is '1'", () => {
    const opts = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      sb: {
        ...dashboard,
        sandboxGpuMode: "1",
        sandboxGpuEnabled: true,
        sandboxGpuDevice: "nvidia.com/gpu=2",
      },
    });
    expect(opts).not.toHaveProperty("noGpu");
    expect(opts.sandboxGpu).toBe("enable");
    expect(opts.sandboxGpuDevice).toBe("nvidia.com/gpu=2");
  });

  it("fails closed when a dashboard-managed sandbox has no durable port", () => {
    expect(() =>
      buildRebuildRecreateOnboardOpts({
        ...baseArgs,
        sb: { agent: null, harnessPackage: OPENCLAW_PACKAGE },
      }),
    ).toThrow("without its persisted dashboard port");
  });

  it("uses the pinned DCode definition without requiring a dashboard port", () => {
    const opts = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      agentAuthority: DCODE_AUTHORITY,
      sb: {
        agent: "langchain-deepagents-code",
        harnessPackage: DCODE_PACKAGE,
      },
    });

    expect(opts.controlUiPort).toBeNull();
  });

  it("rejects package or migration authority that differs from the registry entry", () => {
    expect(() =>
      buildRebuildRecreateOnboardOpts({
        ...baseArgs,
        agentAuthority: {
          ...OPENCLAW_AUTHORITY,
          harnessPackage: { ...OPENCLAW_PACKAGE, packageVersion: "1.0.1" },
        },
        sb: dashboard,
      }),
    ).toThrow("Pinned rebuild package authority does not match the sandbox registry entry.");

    expect(() =>
      buildRebuildRecreateOnboardOpts({
        ...baseArgs,
        agentAuthority: {
          ...OPENCLAW_AUTHORITY,
          harnessPackageMigration: {
            ...OPENCLAW_MIGRATION,
            migratedAt: "2026-08-29T05:00:00.000Z",
          },
        },
        sb: { ...dashboard, harnessPackageMigration: OPENCLAW_MIGRATION },
      }),
    ).toThrow("Pinned rebuild package authority does not match the sandbox registry entry.");
  });

  it("preserves storedFromDockerfile and autoYes regardless of GPU opt-out", () => {
    const opts = buildRebuildRecreateOnboardOpts({
      sb: {
        agent: "hermes",
        harnessPackage: HERMES_PACKAGE,
        dashboardPort: 18_789,
        sandboxGpuMode: "0",
      },
      agentAuthority: HERMES_AUTHORITY,
      storedFromDockerfile: "/sandbox/.openclaw/Dockerfile.custom",
      autoYes: false,
      usageNoticeAccepted: true,
    });
    expect(opts.agent).toBe("hermes");
    expect(opts.fromDockerfile).toBe("/sandbox/.openclaw/Dockerfile.custom");
    expect(opts.autoYes).toBe(false);
    expect(opts.noGpu).toBe(true);
  });

  it("passes the sandbox-specific base-image hint directly into recreate onboarding (#4680)", () => {
    const hint = { key: "sandbox-a" } as SandboxBaseImageResolutionMetadata;
    const opts = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      sb: dashboard,
      baseImageResolutionHint: hint,
    });
    expect(opts.baseImageResolutionHint).toBe(hint);
  });

  it("forwards the ephemeral prepared DCode rebuild handoff as one capability (#6195)", () => {
    const preparedDcodeRebuild = {
      buildContext: {
        buildCtx: "/tmp/dcode-rebuild",
        stagedDockerfile: "/tmp/dcode-rebuild/Dockerfile",
        buildId: "dcode-build",
        cleanupBuildCtx: () => true,
        origin: "generated" as const,
      },
      dcodeAutoApprovalMode: "disabled" as const,
      gatewayName: "nemoclaw",
    };
    const opts = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      sb: {
        agent: "langchain-deepagents-code",
        harnessPackage: DCODE_PACKAGE,
        sandboxGpuMode: "0",
      },
      agentAuthority: DCODE_AUTHORITY,
      preparedDcodeRebuild,
    });

    expect(opts.preparedDcodeRebuild).toBe(preparedDcodeRebuild);
  });
});
