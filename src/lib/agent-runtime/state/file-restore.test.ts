// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AGENTS_DIR, loadAgent } from "../../agent/defs";

const tempAgentDirs: string[] = [];

function writeTempAgentManifest(name: string, contents: string): void {
  const agentDir = path.join(AGENTS_DIR, name);
  tempAgentDirs.push(agentDir);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "manifest.yaml"), contents);
}

afterEach(() => {
  for (const agentDir of tempAgentDirs.splice(0)) {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

describe("state file restore ownership", () => {
  it("parses the finite privileged-copy backup fallback", () => {
    const agentName = `backup-privileged-copy-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Backup",
        "state_files:",
        "  - path: config.json",
        "    backup:",
        "      fallback: privileged-copy",
      ].join("\n"),
    );

    expect(loadAgent(agentName).stateFiles).toEqual([
      {
        path: "config.json",
        strategy: "copy",
        backup: { fallback: "privileged-copy" },
      },
    ]);
  });

  it.each([
    {
      label: "an arbitrary fallback",
      backupLines: ["      fallback: package-command"],
      expected: /backup\.fallback.*privileged-copy/,
    },
    {
      label: "an arbitrary backup field",
      backupLines: ["      fallback: privileged-copy", "      command: capture-config"],
      expected: /backup\.command.*not allowed/,
    },
  ])("rejects $label", ({ backupLines, expected }) => {
    const agentName = `backup-invalid-${String(Date.now())}-${Math.random().toString(16).slice(2)}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Backup",
        "state_files:",
        "  - path: config.json",
        "    backup:",
        ...backupLines,
      ].join("\n"),
    );

    expect(() => loadAgent(agentName)).toThrow(expected);
  });

  it("rejects privileged-copy for a sqlite backup", () => {
    const agentName = `backup-sqlite-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Backup",
        "state_files:",
        "  - path: state.db",
        "    strategy: sqlite_backup",
        "    backup:",
        "      fallback: privileged-copy",
      ].join("\n"),
    );

    expect(() => loadAgent(agentName)).toThrow(/state_files\[0\]\.backup.*strategy 'copy'/);
  });

  it("parses a declarative key-allowlist restore ownership block (#6334)", () => {
    const agentName = `restore-keyallowlist-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Restore",
        "state_files:",
        "  - path: config.toml",
        "    restore:",
        "      merge: key-allowlist",
        "      require_fresh_tables:",
        "        - models",
        "      require_fresh_headers:",
        '        - "# Generated"',
        "        - match: prefix",
        '          value: "# route: "',
        "      user_keys:",
        "        - key: ui.show_scrollbar",
        "          type: boolean",
        "        - key: threads.sort_order",
        "          type: enum",
        "          values:",
        "            - updated_at",
        "            - created_at",
      ].join("\n"),
    );

    expect(loadAgent(agentName).stateFiles).toEqual([
      {
        path: "config.toml",
        strategy: "copy",
        restore: {
          merge: "key-allowlist",
          userKeys: [
            { key: "ui.show_scrollbar", type: "boolean" },
            { key: "threads.sort_order", type: "enum", values: ["updated_at", "created_at"] },
          ],
          requireFreshTables: ["models"],
          requireFreshHeaders: [
            { match: "exact", value: "# Generated" },
            { match: "prefix", value: "# route: " },
          ],
        },
      },
    ]);
  });

  it("parses the package-owned configuration restore strategy", () => {
    const agentName = `restore-package-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Restore",
        "state_files:",
        "  - path: future.json",
        "    restore:",
        "      merge: package-config",
      ].join("\n"),
    );

    expect(loadAgent(agentName).stateFiles).toEqual([
      { path: "future.json", strategy: "copy", restore: { merge: "package-config" } },
    ]);
  });

  it("rejects an unknown state-file restore merge strategy (#6334)", () => {
    const agentName = `restore-badmerge-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Restore",
        "state_files:",
        "  - path: config.toml",
        "    restore:",
        "      merge: wholesale",
      ].join("\n"),
    );

    expect(() => loadAgent(agentName)).toThrow(/state_files\[0\]\.restore\.merge/);
  });

  it("rejects a key-allowlist restore without user_keys (#6334)", () => {
    const agentName = `restore-nokeys-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Restore",
        "state_files:",
        "  - path: config.toml",
        "    restore:",
        "      merge: key-allowlist",
      ].join("\n"),
    );

    expect(() => loadAgent(agentName)).toThrow(/state_files\[0\]\.restore\.user_keys/);
  });

  it("rejects a restore block on a sqlite_backup state file (#6334)", () => {
    const agentName = `restore-sqlite-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Restore",
        "state_files:",
        "  - path: history.db",
        "    strategy: sqlite_backup",
        "    restore:",
        "      merge: key-allowlist",
        "      user_keys:",
        "        - key: ui.theme",
        "          type: string",
      ].join("\n"),
    );

    expect(() => loadAgent(agentName)).toThrow(/state_files\[0\]\.restore.*strategy 'copy'/);
  });

  it("rejects enum user_keys without values (#6334)", () => {
    const agentName = `restore-enum-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Restore",
        "state_files:",
        "  - path: config.toml",
        "    restore:",
        "      merge: key-allowlist",
        "      user_keys:",
        "        - key: threads.sort_order",
        "          type: enum",
      ].join("\n"),
    );

    expect(() => loadAgent(agentName)).toThrow(/user_keys\[0\]\.values.*enum/);
  });

  it("rejects values on a non-enum user_key (#6334)", () => {
    const agentName = `restore-badvalues-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Restore",
        "state_files:",
        "  - path: config.toml",
        "    restore:",
        "      merge: key-allowlist",
        "      user_keys:",
        "        - key: ui.show_scrollbar",
        "          type: boolean",
        "          values:",
        "            - true",
      ].join("\n"),
    );

    expect(() => loadAgent(agentName)).toThrow(/user_keys\[0\]\.values.*only allowed for enum/);
  });

  it("rejects user_keys bounds on non-numeric types (#6334)", () => {
    const agentName = `restore-badbounds-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Restore",
        "state_files:",
        "  - path: config.toml",
        "    restore:",
        "      merge: key-allowlist",
        "      user_keys:",
        "        - key: ui.show_scrollbar",
        "          type: boolean",
        "          min: 1",
      ].join("\n"),
    );

    expect(() => loadAgent(agentName)).toThrow(/user_keys\[0\]\.min.*integer or number/);
  });

  it("rejects unknown state-file fields instead of silently dropping restore intent (#6334)", () => {
    const agentName = `restore-typo-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Restore",
        "state_files:",
        "  - path: config.toml",
        "    restroe:",
        "      merge: key-allowlist",
      ].join("\n"),
    );

    expect(() => loadAgent(agentName)).toThrow(/state_files\[0\]\.restroe.*not allowed/);
  });

  it("rejects unsafe shorthand state-file paths (#6334)", () => {
    const agentName = `restore-unsafe-short-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [`name: ${agentName}`, "display_name: Restore", "state_files:", "  - ../config.toml"].join(
        "\n",
      ),
    );

    expect(() => loadAgent(agentName)).toThrow(/state_files\[0\].*canonical relative path/);
  });

  it("rejects unsafe object state-file paths (#6334)", () => {
    const agentName = `restore-unsafe-object-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Restore",
        "state_files:",
        "  - path: /tmp/config.toml",
      ].join("\n"),
    );

    expect(() => loadAgent(agentName)).toThrow(/state_files\[0\]\.path.*relative path/);
  });

  it.each([
    "rebuild-manifest.json",
    "REBUILD-MANIFEST.JSON",
    ".nemoclaw-rebuild-recovery.json/nested",
    ".NEMOCLAW-REBUILD-RECOVERY.JSON/nested",
    `rebuild-policy-handoff.${"a".repeat(64)}.yaml`,
    `REBUILD-POLICY-HANDOFF.${"A".repeat(64)}.YAML`,
  ])("rejects snapshot control path %s as agent state (#6334)", (statePath) => {
    const agentName = `restore-reserved-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Restore",
        "state_files:",
        `  - path: ${statePath}`,
      ].join("\n"),
    );

    expect(() => loadAgent(agentName)).toThrow(/state_files\[0\]\.path.*snapshot metadata/);
  });

  it("rejects duplicate or ancestor-overlapping user-owned keys (#6334)", () => {
    const agentName = `restore-overlap-user-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Restore",
        "state_files:",
        "  - path: config.toml",
        "    restore:",
        "      merge: key-allowlist",
        "      user_keys:",
        "        - key: ui",
        "          type: string",
        "        - key: ui.show_scrollbar",
        "          type: boolean",
      ].join("\n"),
    );

    expect(() => loadAgent(agentName)).toThrow(/user_keys\[0\].*user_keys\[1\].*contain/);
  });

  it("rejects user-owned keys that overlap authoritative fresh tables (#6334)", () => {
    const agentName = `restore-overlap-fresh-${String(Date.now())}`;
    writeTempAgentManifest(
      agentName,
      [
        `name: ${agentName}`,
        "display_name: Restore",
        "state_files:",
        "  - path: config.toml",
        "    restore:",
        "      merge: key-allowlist",
        "      require_fresh_tables:",
        "        - models",
        "      user_keys:",
        "        - key: models.default",
        "          type: string",
      ].join("\n"),
    );

    expect(() => loadAgent(agentName)).toThrow(/user_keys\[0\]\.key.*require_fresh_tables\[0\]/);
  });
});
