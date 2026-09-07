// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HarnessManagedExtensionsDeclaration } from "@nvidia/nemoclaw-harness-contract";
import { describe, expect, it } from "vitest";

import {
  buildManagedExtensionCleanupCommand,
  buildManagedExtensionRestoreTarArgs,
  isAllowedManagedStateSymlink,
  parseManagedExtensionInspection,
  planManagedExtensionRestore,
} from "./snapshot/managed-extensions.js";

const DECLARATION = {
  support: "managed",
  controller: { command: ["/opt/future/state-controller"], timeout_seconds: 30 },
  state_directory: "addons",
  preserved_directories: ["core-addon"],
  allowed_symlinks: [
    {
      kind: "relative-within",
      source_pattern: "addons/*/bin/*",
      root_ancestor_depth: 1,
      forbidden_prefixes: ["bin"],
    },
    {
      kind: "exact-target",
      source_pattern: "addons/*/runtime",
      targets: ["/opt/future/runtime"],
    },
  ],
} as const satisfies Extract<HarnessManagedExtensionsDeclaration, { readonly support: "managed" }>;

describe("receipt-backed managed extensions", () => {
  it("accepts a synthetic package response without learning its package ID", () => {
    expect(
      parseManagedExtensionInspection(
        {
          schemaVersion: 1,
          extensions: [
            { id: "future-weather", directory: "weather", configPaths: ["/opt/weather"] },
            { id: "future-search", directory: null, configPaths: [] },
          ],
        },
        DECLARATION,
      ),
    ).toEqual({
      ok: true,
      extensions: [
        { id: "future-search", directory: null, configPaths: [] },
        { id: "future-weather", directory: "weather", configPaths: ["/opt/weather"] },
      ],
    });
  });

  it.each([
    ["an unknown response field", { schemaVersion: 1, extensions: [], native: true }],
    [
      "a traversing directory",
      {
        schemaVersion: 1,
        extensions: [{ id: "future", directory: "../outside", configPaths: [] }],
      },
    ],
    [
      "a relative configuration path",
      {
        schemaVersion: 1,
        extensions: [{ id: "future", directory: null, configPaths: ["./outside"] }],
      },
    ],
    [
      "duplicate directory ownership",
      {
        schemaVersion: 1,
        extensions: [
          { id: "future-a", directory: "shared", configPaths: [] },
          { id: "future-b", directory: "shared", configPaths: [] },
        ],
      },
    ],
  ])("rejects %s", (_name, response) => {
    expect(parseManagedExtensionInspection(response, DECLARATION)).toEqual(
      expect.objectContaining({ ok: false }),
    );
  });

  it("plans preservation from only the typed package declaration and two baselines", () => {
    expect(
      planManagedExtensionRestore({
        declaration: DECLARATION,
        restoredStateDirectories: ["addons", "workspace"],
        freshExtensions: [
          { id: "new", directory: "new-addon", configPaths: [] },
          { id: "external", directory: null, configPaths: ["/opt/external"] },
        ],
        previousExtensions: [{ id: "old", directory: "old-addon", configPaths: [] }],
      }),
    ).toEqual({
      ok: true,
      freshDirectories: ["new-addon"],
      previousDirectories: ["old-addon"],
      preservedDirectories: ["core-addon", "new-addon"],
      archiveExcludedDirectories: ["core-addon", "new-addon", "old-addon"],
      requiredFreshDirectories: ["new-addon"],
    });
  });

  it("matches only the finite package-declared symlink shapes", () => {
    expect(isAllowedManagedStateSymlink(DECLARATION, "addons/weather/bin/tool", "../tool.py")).toBe(
      true,
    );
    expect(
      isAllowedManagedStateSymlink(DECLARATION, "addons/weather/bin/tool", "../../outside"),
    ).toBe(false);
    expect(isAllowedManagedStateSymlink(DECLARATION, "addons/weather/bin/tool", "other-tool")).toBe(
      false,
    );
    expect(
      isAllowedManagedStateSymlink(DECLARATION, "addons/weather/runtime", "/opt/future/runtime"),
    ).toBe(true);
    expect(
      isAllowedManagedStateSymlink(DECLARATION, "addons/weather/runtime", "/opt/attacker/runtime"),
    ).toBe(false);
    expect(
      isAllowedManagedStateSymlink(DECLARATION, "workspace/weather/runtime", "/opt/future/runtime"),
    ).toBe(false);
  });

  it("builds restore commands from the synthetic package directory names", () => {
    expect(
      buildManagedExtensionRestoreTarArgs("/tmp/backup", ["addons", "workspace"], "addons", [
        "core-addon",
        "old-addon",
      ]),
    ).toContain("addons/old-addon");
    const cleanup = buildManagedExtensionCleanupCommand({
      root: "/sandbox/.future",
      localDirectories: ["addons", "workspace"],
      staleDirectories: ["cache"],
      declaration: DECLARATION,
      preservedDirectories: ["core-addon", "new-addon"],
      requiredDirectories: new Set(["new-addon"]),
    });
    expect(cleanup).toContain("/sandbox/.future/addons");
    expect(cleanup).toContain("core-addon");
    expect(cleanup).toContain("/sandbox/.future/workspace");
    expect(cleanup).not.toContain("openclaw");
  });
});
