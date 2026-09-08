// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildAgentDefinition } from "../../../../src/lib/agent-runtime/manifest-loader.ts";
import { loadValidatedHarnessManifest } from "../../../../src/lib/agent-runtime/manifest-readers.ts";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const MANIFEST_PATH = path.join(PACKAGE_ROOT, "manifest.yaml");

describe("Pi skill capability", () => {
  it("does not claim lifecycle support without a native skill inventory", () => {
    const definition = buildAgentDefinition({
      manifest: loadValidatedHarnessManifest(MANIFEST_PATH, "pi"),
      manifestPath: MANIFEST_PATH,
      packageRoot: PACKAGE_ROOT,
    });

    expect(definition.skillCapability).toEqual({
      support: "disabled",
      reason: "Pi accepts prompt-scoped skill paths but does not expose a native skill inventory.",
    });
    expect(definition.skillIntegration).toBeNull();
  });
});
