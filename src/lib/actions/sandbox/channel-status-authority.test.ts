// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxMessagingProfileAuthority } from "../../messaging";
import type { ChannelManifestRegistry } from "../../messaging/manifest/registry";
import type { SandboxEntry } from "../../state/registry";
import {
  entry,
  fakeAgent,
  makeDeps,
  showSandboxChannelStatus,
} from "./channel-status.test-helpers";

const PACKAGE_IDENTITY = Object.freeze({
  kind: "agent-runtime" as const,
  id: "openclaw",
  packageVersion: "1.0.0",
  contentDigest: "a".repeat(64),
});

function receiptBackedEntry(channels: string[] = ["whatsapp"]): SandboxEntry {
  return { ...entry(channels), harnessPackage: PACKAGE_IDENTITY };
}

function packageProfile(
  integration: SandboxMessagingProfileAuthority["integration"],
): SandboxMessagingProfileAuthority {
  const agent = fakeAgent("openclaw");
  return Object.freeze({
    agent,
    packageAuthority: Object.freeze({
      recordedAgent: "openclaw",
      effectiveAgentId: "openclaw",
      definition: agent,
      harnessPackage: PACKAGE_IDENTITY,
      harnessPackageMigration: null,
    }),
    integration,
  });
}

function channelFromRegistry(registry: ChannelManifestRegistry, channelId: string) {
  const channel = registry.get(channelId);
  if (!channel) throw new Error(`test channel '${channelId}' is missing`);
  return channel;
}

describe("channel status package authority", () => {
  it("uses the package declaration without consulting the legacy agent catalogue", async () => {
    const authority = packageProfile({
      kind: "channels",
      packageId: "openclaw",
      channelIds: ["whatsapp"],
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
      channelIds: ["telegram"],
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
