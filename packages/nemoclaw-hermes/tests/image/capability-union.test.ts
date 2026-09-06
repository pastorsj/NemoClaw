// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  collectManagedImageHermesUvPackages,
  installManagedImageCapabilityUnion,
} from "../../../../src/lib/messaging/applier/build/messaging-build-applier.mts";
import { BUILT_IN_CHANNEL_MANIFESTS } from "../../../../src/lib/messaging/channels/built-ins.ts";
import type { ChannelManifest } from "../../../../src/lib/messaging/manifest/types.ts";
import {
  MANAGED_IMAGE_HERMES_NEUTRAL_PLATFORMS,
  MANAGED_IMAGE_HERMES_SUPPORTED_PLATFORMS,
} from "../../config/managed-policy.ts";

function renderedHermesPlatforms(manifest: ChannelManifest): string[] {
  return manifest.render.flatMap((render) =>
    render.agent === "hermes" &&
    render.kind === "json-fragment" &&
    render.fragment.path.startsWith("platforms.")
      ? [render.fragment.path.slice("platforms.".length)]
      : [],
  );
}

describe("Hermes managed-image capability union", () => {
  it("derives its reviewed packages and supported platforms from trusted manifests (#7744)", () => {
    expect(collectManagedImageHermesUvPackages()).toEqual([
      "microsoft-teams-apps==2.0.13.4",
      "google-cloud-pubsub==2.39.0",
      "google-api-python-client==2.194.0",
      "google-auth==2.55.1",
    ]);

    const supportedPlatforms = BUILT_IN_CHANNEL_MANIFESTS.filter((manifest) =>
      manifest.supportedAgents.includes("hermes"),
    ).flatMap(renderedHermesPlatforms);
    expect(MANAGED_IMAGE_HERMES_SUPPORTED_PLATFORMS).toEqual(supportedPlatforms);
    expect(MANAGED_IMAGE_HERMES_NEUTRAL_PLATFORMS).toEqual([
      "a2a",
      "bluebubbles",
      "buzz",
      "dingtalk",
      "discord",
      "email",
      "feishu",
      "google_chat",
      "homeassistant",
      "irc",
      "line",
      "matrix",
      "mattermost",
      "msgraph_webhook",
      "ntfy",
      "photon",
      "qqbot",
      "raft",
      "relay",
      "signal",
      "simplex",
      "slack",
      "sms",
      "teams",
      "telegram",
      "wecom",
      "wecom_callback",
      "weixin",
      "whatsapp",
      "whatsapp_cloud",
      "webhook",
      "yuanbao",
    ]);
  });

  it("requires explicit neutral-image mode before installing its union (#7744)", () => {
    expect(() =>
      installManagedImageCapabilityUnion("hermes", {
        NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "0",
      }),
    ).toThrow(
      "Managed-image capability union installation requires NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=1",
    );
  });

  it("installs its pinned union through the reviewed Python package boundary (#7744)", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-union-"));
    const trace = path.join(temporaryRoot, "uv.trace");
    fs.writeFileSync(
      path.join(temporaryRoot, "uv"),
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$UV_TRACE"\n',
      { mode: 0o755 },
    );

    try {
      installManagedImageCapabilityUnion("hermes", {
        PATH: `${temporaryRoot}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        UV_TRACE: trace,
        NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "1",
      });
      expect(fs.readFileSync(trace, "utf8").trim()).toBe(
        "pip install --python /opt/hermes/.venv/bin/python --no-cache -- microsoft-teams-apps==2.0.13.4 google-cloud-pubsub==2.39.0 google-api-python-client==2.194.0 google-auth==2.55.1",
      );
    } finally {
      fs.rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });
});
