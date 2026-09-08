// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildAgentDefinition } from "../../../../src/lib/agent-runtime/manifest-loader.ts";
import { loadValidatedHarnessManifest } from "../../../../src/lib/agent-runtime/manifest-readers.ts";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const MANIFEST_PATH = path.join(PACKAGE_ROOT, "manifest.yaml");

describe("Deep Agents Code skill capability", () => {
  it("declares its agent-owned directory and native list/remove commands", () => {
    const definition = buildAgentDefinition({
      manifest: loadValidatedHarnessManifest(MANIFEST_PATH, "langchain-deepagents-code"),
      manifestPath: MANIFEST_PATH,
      packageRoot: PACKAGE_ROOT,
    });

    expect(definition.skillCapability).toEqual({
      support: "managed",
      install_root: "/sandbox/.deepagents/agent/skills",
      collision: "refuse",
      removal: "remove",
      activation: { kind: "new-session" },
      list_command: ["skills", "list", "--agent", "agent"],
      remove_command: ["skills", "delete", "{name}", "--agent", "agent", "--force", "--json"],
    });
  });
});
