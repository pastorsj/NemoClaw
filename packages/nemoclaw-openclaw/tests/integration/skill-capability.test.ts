// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildAgentDefinition } from "../../../../src/lib/agent-runtime/manifest-loader.ts";
import { loadValidatedHarnessManifest } from "../../../../src/lib/agent-runtime/manifest-readers.ts";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const MANIFEST_PATH = path.join(PACKAGE_ROOT, "manifest.yaml");

describe("OpenClaw skill capability", () => {
  it("declares its durable root, loader mirror, replacement, removal, and activation", () => {
    const definition = buildAgentDefinition({
      manifest: loadValidatedHarnessManifest(MANIFEST_PATH, "openclaw"),
      manifestPath: MANIFEST_PATH,
      packageRoot: PACKAGE_ROOT,
    });

    expect(definition.skillCapability).toEqual({
      support: "managed",
      install_root: "/sandbox/.openclaw/skills",
      mirror_root: "$HOME/.openclaw/skills",
      collision: "replace",
      removal: "remove",
      activation: {
        kind: "reset-session-index",
        path: "/sandbox/.openclaw/agents/main/sessions/sessions.json",
      },
    });
  });
});
