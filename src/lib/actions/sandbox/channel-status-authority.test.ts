// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxMessagingProfileAuthority } from "../../messaging";
import type { ChannelManifest } from "../../messaging/manifest";
import type { ChannelManifestRegistry } from "../../messaging/manifest/registry";
import type { SandboxEntry } from "../../state/registry";
import {
  entry,
  fakeAgent,
  makeDeps,
  showSandboxChannelStatus,
} from "./channel-status.test-helpers";

function packageIdentity(id = "openclaw") {
  return Object.freeze({
    kind: "agent-runtime" as const,
    id,
    packageVersion: "1.0.0",
    contentDigest: "a".repeat(64),
  });
}

function receiptBackedEntry(
  channels: string[] = ["whatsapp"],
  packageId = "openclaw",
): SandboxEntry {
  return { ...entry(channels), agent: packageId, harnessPackage: packageIdentity(packageId) };
}

function packageProfile(
  integration: NonNullable<SandboxMessagingProfileAuthority["integration"]>,
): SandboxMessagingProfileAuthority {
  const packageId = integration.packageId;
  const agent = Object.freeze({
    ...fakeAgent("openclaw"),
    name: packageId,
    displayName: packageId,
  });
  return Object.freeze({
    agent,
    packageAuthority: Object.freeze({
      recordedAgent: packageId,
      effectiveAgentId: packageId,
      definition: agent,
      harnessPackage: packageIdentity(packageId),
      harnessPackageMigration: null,
    }),
    integration,
  });
}

function messagingChannels(...channelIds: string[]) {
  return channelIds.map((channelId) => ({
    channelId,
    config: { renders: [] },
    policy: [],
    lifecycle: { hookIds: [] },
  }));
}

function channelFromRegistry(registry: ChannelManifestRegistry, channelId: string) {
  const channel = registry.get(channelId);
  if (!channel) throw new Error(`test channel '${channelId}' is missing`);
  return channel;
}

function packageChannelFromRegistry(
  registry: ChannelManifestRegistry,
  channelId: string,
  packageId: string,
): ChannelManifest {
  const service = channelFromRegistry(registry, channelId);
  return { ...service, supportedAgents: [packageId], hooks: [] };
}

describe("channel status package authority", () => {
  it("uses the package declaration without consulting the legacy agent catalogue", async () => {
    const authority = packageProfile({
      kind: "channels",
      packageId: "openclaw",
      build: { configRoot: "~/.openclaw", packageManagers: ["node-package"] },
      channels: messagingChannels("whatsapp"),
    });
    const loadAgent = vi.fn();
    const resolveMessagingProfileAuthority = vi.fn(() => authority);
    const listMessagingChannelsForProfile = vi.fn((_authority, registry) => [
      channelFromRegistry(registry, "whatsapp"),
    ]);
    const { deps } = makeDeps({
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      sandbox: receiptBackedEntry(),
      loadAgent,
      resolveMessagingProfileAuthority,
      listMessagingChannelsForProfile,
    });

    const result = await showSandboxChannelStatus("alpha", { deps });

    expect(result && "channels" in result && result.channels).toHaveLength(1);
    expect(resolveMessagingProfileAuthority).toHaveBeenCalledOnce();
    expect(listMessagingChannelsForProfile).toHaveBeenCalledWith(authority, expect.anything());
    expect(loadAgent).not.toHaveBeenCalled();
  });

  it("rejects disabled package messaging before policy, config, or runtime inspection", async () => {
    const authority = packageProfile({
      kind: "disabled",
      packageId: "openclaw",
      reason: "Messaging is not enabled for this package.",
    });
    const getAppliedPresets = vi.fn(() => ["whatsapp"]);
    const getGatewayPresets = vi.fn(() => ["whatsapp"]);
    const { deps } = makeDeps({
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      sandbox: receiptBackedEntry(),
      resolveMessagingProfileAuthority: () => authority,
      listMessagingChannelsForProfile: () => [],
    });
    deps.getAppliedPresets = getAppliedPresets;
    deps.getGatewayPresets = getGatewayPresets;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    await expect(showSandboxChannelStatus("alpha", { deps, channel: "whatsapp" })).rejects.toThrow(
      "process.exit(1)",
    );

    exitSpy.mockRestore();
    expect(getAppliedPresets).not.toHaveBeenCalled();
    expect(getGatewayPresets).not.toHaveBeenCalled();
    expect(deps.execSandbox).not.toHaveBeenCalled();
  });

  it("rejects invalid receipt authority before profile or status inspection", async () => {
    const getAppliedPresets = vi.fn(() => ["whatsapp"]);
    const listMessagingChannelsForProfile = vi.fn();
    const { deps } = makeDeps({
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      sandbox: receiptBackedEntry(),
      resolveMessagingProfileAuthority: () => {
        throw new Error("receipt integrity validation failed");
      },
      listMessagingChannelsForProfile,
    });
    deps.getAppliedPresets = getAppliedPresets;

    await expect(showSandboxChannelStatus("alpha", { deps, channel: "whatsapp" })).rejects.toThrow(
      "receipt integrity validation failed",
    );

    expect(listMessagingChannelsForProfile).not.toHaveBeenCalled();
    expect(getAppliedPresets).not.toHaveBeenCalled();
    expect(deps.execSandbox).not.toHaveBeenCalled();
  });

  it("reports stale configured channels without inspecting unsupported package behavior", async () => {
    const authority = packageProfile({
      kind: "channels",
      packageId: "openclaw",
      build: { configRoot: "~/.openclaw", packageManagers: ["node-package"] },
      channels: messagingChannels("telegram"),
    });
    const getAppliedPresets = vi.fn(() => ["whatsapp"]);
    const { deps } = makeDeps({
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      sandbox: receiptBackedEntry(),
      resolveMessagingProfileAuthority: () => authority,
      listMessagingChannelsForProfile: (_authority, registry) => [
        channelFromRegistry(registry, "telegram"),
      ],
    });
    deps.getAppliedPresets = getAppliedPresets;

    const result = await showSandboxChannelStatus("alpha", { deps });

    expect(result && "channels" in result && result.channels[0]).toMatchObject({
      channel: "whatsapp",
      signals: [
        {
          label: "Harness package support",
          severity: "warn",
          detail: "installed harness package 'openclaw' does not declare channel 'whatsapp'",
        },
      ],
    });
    expect(getAppliedPresets).not.toHaveBeenCalled();
    expect(deps.execSandbox).not.toHaveBeenCalled();
  });

  it("routes a receipt-backed future package through its composed channel profile", async () => {
    const packageId = "future-harness";
    const authority = packageProfile({
      kind: "channels",
      packageId,
      build: { configRoot: "~/.future-harness", packageManagers: [] },
      channels: messagingChannels("telegram"),
    });
    let packageManifest: ChannelManifest | undefined;
    const { deps } = makeDeps({
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      sandbox: receiptBackedEntry([], packageId),
      resolveMessagingProfileAuthority: () => authority,
      listMessagingChannelsForProfile: (_authority, registry) => {
        packageManifest = packageChannelFromRegistry(registry, "telegram", packageId);
        return [packageManifest];
      },
    });

    const result = await showSandboxChannelStatus("alpha", { deps, channel: "telegram" });
    const { resolveChannelHookAgent } = await import("./channel-status");

    expect(resolveChannelHookAgent("openclaw")).toBe("openclaw");
    expect(resolveChannelHookAgent("hermes")).toBe("hermes");
    expect(resolveChannelHookAgent(packageId)).toBeNull();
    expect(packageManifest).toBeDefined();
    expect(resolveChannelHookAgent(packageId, packageManifest ? [packageManifest] : [])).toBe(
      packageId,
    );
    expect(result).toMatchObject({
      sandbox: "alpha",
      channel: "telegram",
      verdict: "info",
    });
    expect(deps.execSandbox).not.toHaveBeenCalled();
  });

  it("keeps no-receipt status on the isolated legacy catalogue path", async () => {
    const loadAgent = vi.fn(() => fakeAgent("openclaw"));
    const resolveMessagingProfileAuthority = vi.fn();
    const { deps } = makeDeps({
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      sandbox: entry([]),
      loadAgent,
      resolveMessagingProfileAuthority,
    });

    await showSandboxChannelStatus("alpha", { deps });

    expect(loadAgent).toHaveBeenCalledWith("openclaw");
    expect(resolveMessagingProfileAuthority).not.toHaveBeenCalled();
  });
});
