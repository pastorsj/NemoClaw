// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TEST_CONFIG_ADAPTER_SOURCE,
  TEST_MESSAGING_ADAPTER_SOURCE,
  TEST_STARTUP_ADAPTER_SOURCE,
} from "../../../test/helpers/adapter-fixtures";
import { installHarnessPackage } from "./package/install";
import { loadHarnessAgentRosterAdapterHostModule } from "./roster-module";

const TEST_PARENT = path.join(process.cwd(), "node_modules/.cache/nemoclaw-roster-module-tests");
const SOURCE_IDENTITY = Object.freeze({
  kind: "bundled" as const,
  nemoclawBuildIdentity: Object.freeze({
    nemoclawVersion: "0.0.113",
    sourceRevision: "7".repeat(40),
  }),
});
const ADAPTER_SOURCE = `
module.exports = {
  buildAgentRosterCommand(request) {
    return { kind: "stream", command: ["future-roster", request.operation, ...request.arguments] };
  },
  buildAgentRosterInspection() {
    return { kind: "capture", command: ["future-roster", "inspect"] };
  },
  buildAgentRosterApplyPlan(request) {
    const current = JSON.parse(request.current_output);
    return {
      kind: "ready",
      current_count: current.length,
      additions: [{ agent_id: "planner", command: ["future-roster", "add", "planner"] }],
      deletions: [],
      rebuild_only_fields: [],
      notices: [],
    };
  },
};
`;

fs.mkdirSync(TEST_PARENT, { recursive: true, mode: 0o700 });

let fixtureRoot = "";
let sourceRoot = "";
let storeRoot = "";

function writeFixtureFile(relativePath: string, contents: string): void {
  const target = path.join(sourceRoot, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, contents, { mode: 0o600 });
}

function installFutureRosterPackage(adapterSource = ADAPTER_SOURCE) {
  writeFixtureFile(
    "nemoclaw-package.json",
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "agent-runtime",
      id: "future-roster",
      displayName: "Future Roster",
      packageVersion: "1.0.0",
      minimumNemoClawVersion: "0.0.113",
      maximumNemoClawVersionExclusive: "0.0.121",
      manifest: "packages/nemoclaw-future-roster/manifest.yaml",
    })}\n`,
  );
  writeFixtureFile(
    "packages/nemoclaw-future-roster/manifest.yaml",
    [
      "name: future-roster",
      "runtime:",
      "  kind: terminal",
      "  interactive_command: future-roster",
      "  headless_command: future-roster --prompt",
      "  prompt_transport: stdin",
      "config:",
      "  dir: /sandbox/.future-roster",
      "  config_file: config.json",
      "  format: json",
      "inference:",
      "  config_update:",
      "    support: unsupported",
      "    reason: Fixed configuration.",
      "messaging:",
      "  support: disabled",
      "policy:",
      "  owned_presets: []",
      "  automatic_presets: []",
      "  baseline_exclusion_impacts: {}",
      "agent_roster:",
      "  support: managed",
      "  adapter: agent-roster",
      "  onboarding_environment: NEMOCLAW_EXTRA_AGENTS_JSON",
      "state_lifecycle:",
      "  backup_quiescence:",
      "    kind: not-required",
      "  snapshot_restore: []",
      "  rebuild:",
      "    managed_extensions:",
      "      support: disabled",
      "      reason: This package has no managed extensions.",
      "    scheduled_work:",
      "      support: disabled",
      "      reason: This package has no scheduled work.",
      "    post_restore:",
      "      kind: not-required",
      "",
    ].join("\n"),
  );
  writeFixtureFile(
    "packages/nemoclaw-future-roster/host/config-adapter.cts",
    TEST_CONFIG_ADAPTER_SOURCE,
  );
  writeFixtureFile(
    "packages/nemoclaw-future-roster/host/messaging-adapter.cts",
    TEST_MESSAGING_ADAPTER_SOURCE,
  );
  writeFixtureFile(
    "packages/nemoclaw-future-roster/host/startup-adapter.cts",
    TEST_STARTUP_ADAPTER_SOURCE,
  );
  writeFixtureFile("packages/nemoclaw-future-roster/host/agent-roster-adapter.cts", adapterSource);
  return installHarnessPackage(
    { packageRoot: sourceRoot, sourceIdentity: SOURCE_IDENTITY },
    { storeRoot },
  );
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(TEST_PARENT, "fixture-"));
  sourceRoot = path.join(fixtureRoot, "source");
  storeRoot = path.join(fixtureRoot, "store");
  fs.mkdirSync(storeRoot, { recursive: true, mode: 0o700 });
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("installed harness agent roster adapter", () => {
  it("loads all fixed operations for an unknown future package", () => {
    const installed = installFutureRosterPackage();
    const adapter = loadHarnessAgentRosterAdapterHostModule(installed.identity, { storeRoot });

    expect(adapter.buildAgentRosterCommand({ operation: "list", arguments: ["--json"] })).toEqual({
      kind: "stream",
      command: ["future-roster", "list", "--json"],
    });
    expect(adapter.buildAgentRosterInspection({ manifest: { workers: [] } })).toEqual({
      kind: "capture",
      command: ["future-roster", "inspect"],
    });
    expect(
      adapter.buildAgentRosterApplyPlan({ manifest: { workers: [] }, current_output: "[]" }),
    ).toMatchObject({
      kind: "ready",
      additions: [{ agent_id: "planner", command: ["future-roster", "add", "planner"] }],
    });
  });

  it("rejects malformed package commands before core can execute them", () => {
    const installed = installFutureRosterPackage(
      ADAPTER_SOURCE.replace('["future-roster", request.operation, ...request.arguments]', "[]"),
    );
    const adapter = loadHarnessAgentRosterAdapterHostModule(installed.identity, { storeRoot });

    expect(() => adapter.buildAgentRosterCommand({ operation: "list", arguments: [] })).toThrow(
      /invalid agent roster command plan/u,
    );
  });
});
