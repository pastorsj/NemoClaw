// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildAgentDefinition } from "../../../../src/lib/agent-runtime/manifest-loader.ts";
import { loadManifestRecord } from "../../../../src/lib/agent-runtime/manifest-readers.ts";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const MANIFEST_PATH = path.join(PACKAGE_ROOT, "manifest.yaml");

describe("Deep Agents Code skill capability", () => {
  it("declares its agent-owned directory as fresh-only and removal-refused", () => {
    const definition = buildAgentDefinition({
      manifest: loadManifestRecord(MANIFEST_PATH),
      manifestPath: MANIFEST_PATH,
      packageRoot: PACKAGE_ROOT,
    });

    expect(definition.skillCapability).toEqual({
      support: "managed",
      install_root: "/sandbox/.deepagents/agent/skills",
      collision: "refuse",
      removal: "refuse",
      activation: { kind: "new-session" },
    });
  });
});
