// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { MANAGED_IMAGE_OPENCLAW_MESSAGING_CAPABILITIES } from "../../config/generate-config.mts";
import { loadAgent } from "../../../../src/lib/agent/defs.ts";
import { collectManagedImageOpenClawPluginInstallSpecs } from "../../../../src/lib/messaging/applier/build/messaging-build-applier.mts";
import { BUILT_IN_CHANNEL_MANIFESTS } from "../../../../src/lib/messaging/channels/built-ins.ts";
import type { ChannelManifest } from "../../../../src/lib/messaging/manifest/types.ts";

function renderedOpenClawPluginIds(manifest: ChannelManifest): string[] {
  return manifest.render.flatMap((render) =>
    render.agent === "openclaw" &&
    render.kind === "json-fragment" &&
    render.fragment.path.startsWith("plugins.entries.")
      ? [render.fragment.path.slice("plugins.entries.".length)]
      : [],
  );
}

describe("OpenClaw managed-image capability union", () => {
  it("derives its reviewed package union from trusted manifests (#7744)", () => {
    const reviewedVersion = loadAgent("openclaw").expectedVersion;
    expect(
      reviewedVersion,
      "Revalidate the bundled OpenClaw weather skill before changing its reviewed egress contract",
    ).toBe("2026.7.1");
    expect(
      collectManagedImageOpenClawPluginInstallSpecs({
        OPENCLAW_VERSION: reviewedVersion ?? undefined,
      }),
    ).toEqual([
      "npm:@openclaw/discord@2026.7.1",
      "npm:@tencent-weixin/openclaw-weixin@2.4.3",
      "npm:@openclaw/slack@2026.7.1",
      "npm:@openclaw/whatsapp@2026.7.1",
      "npm:@openclaw/msteams@2026.7.1",
      "npm:@openclaw/googlechat@2026.7.1",
    ]);
  });

  it("keeps its neutral config capabilities aligned with supported manifests (#7744)", () => {
    const capabilities = BUILT_IN_CHANNEL_MANIFESTS.filter((manifest) =>
      manifest.supportedAgents.includes("openclaw"),
    ).flatMap((manifest) =>
      renderedOpenClawPluginIds(manifest).map((pluginId) => ({
        channelId: manifest.runtime?.openclaw?.channelName,
        pluginId,
      })),
    );

    expect(MANAGED_IMAGE_OPENCLAW_MESSAGING_CAPABILITIES).toEqual(capabilities);
    expect(MANAGED_IMAGE_OPENCLAW_MESSAGING_CAPABILITIES).toContainEqual({
      channelId: "googlechat",
      pluginId: "googlechat",
    });
  });
});
