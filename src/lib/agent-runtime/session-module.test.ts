// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TEST_CONFIG_ADAPTER_SOURCE,
  TEST_MESSAGING_ADAPTER_SOURCE,
  TEST_STARTUP_ADAPTER_SOURCE,
} from "../../../test/helpers/adapter-fixtures";
import { installHarnessPackage } from "./package/install";
import type { InstalledHarnessPackage } from "./package/store";
import { loadHarnessSessionAdapterHostModule } from "./session-module";

const TEST_PARENT = path.join(process.cwd(), "node_modules/.cache/nemoclaw-session-module-tests");
const SOURCE_IDENTITY = Object.freeze({
  kind: "bundled" as const,
  nemoclawBuildIdentity: Object.freeze({
    nemoclawVersion: "0.0.113",
    sourceRevision: "7".repeat(40),
  }),
});

const SESSION_MODULE = `
module.exports = {
  buildSessionListPlan(request) {
    return { kind: "capture", command: ["future-sessions", "list", ...request.arguments] };
  },
  interpretSessionListOutput(request) {
    return { kind: "output", output: request.output.toUpperCase() };
  },
  buildSessionMutationPlan(request) {
    return { kind: "unsupported", reason: "future " + request.operation + " unavailable" };
  },
  interpretSessionMutationOutput() {
    return { kind: "refused", reason: "mutation unavailable" };
  },
  buildSessionExportPlan() {
    return { kind: "unsupported", reason: "future export unavailable" };
  },
  interpretSessionExportIndex() {
    return { kind: "refused", reason: "export unavailable" };
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

function installFuturePackage(
  operations: readonly string[] = ["list"],
  moduleSource = SESSION_MODULE,
): InstalledHarnessPackage {
  writeFixtureFile(
    "nemoclaw-package.json",
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "agent-runtime",
      id: "future-sessions",
      displayName: "Future Sessions",
      packageVersion: "1.0.0",
      minimumNemoClawVersion: "0.0.113",
      maximumNemoClawVersionExclusive: "0.0.121",
      manifest: "packages/nemoclaw-future-sessions/manifest.yaml",
    })}\n`,
  );
  writeFixtureFile(
    "packages/nemoclaw-future-sessions/manifest.yaml",
    [
      "name: future-sessions",
      "display_name: Future Sessions",
      "config:",
      "  dir: /sandbox/.future-sessions",
      "  config_file: config.json",
      "  format: json",
      "runtime:",
      "  kind: terminal",
      "  interactive_command: future-sessions",
      "  headless_command: future-sessions --prompt",
      "  prompt_transport: stdin",
      "inference:",
      "  config_update:",
      "    support: unsupported",
      "    reason: Future Sessions does not expose mutable inference configuration.",
      "messaging:",
      "  support: disabled",
      "policy:",
      "  owned_presets: []",
      "  automatic_presets: []",
      "  baseline_exclusion_impacts: {}",
      "sessions:",
      `  operations: ${JSON.stringify(operations)}`,
      "state_lifecycle:",
      "  backup_quiescence:",
      "    kind: not-required",
      "  snapshot_restore: []",
      "  rebuild:",
      "    managed_extensions:",
      "      support: disabled",
      "      reason: The synthetic package has no managed extensions.",
      "    scheduled_work:",
      "      support: disabled",
      "      reason: The synthetic package has no scheduled work.",
      "    post_restore:",
      "      kind: not-required",
      "",
    ].join("\n"),
  );
  writeFixtureFile(
    "packages/nemoclaw-future-sessions/host/config-adapter.cts",
    TEST_CONFIG_ADAPTER_SOURCE,
  );
  writeFixtureFile(
    "packages/nemoclaw-future-sessions/host/messaging-adapter.cts",
    TEST_MESSAGING_ADAPTER_SOURCE,
  );
  writeFixtureFile(
    "packages/nemoclaw-future-sessions/host/startup-adapter.cts",
    TEST_STARTUP_ADAPTER_SOURCE,
  );
  writeFixtureFile("packages/nemoclaw-future-sessions/host/session-adapter.cts", moduleSource);
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

describe("installed harness session adapter", () => {
  it("loads session-list behavior for an unknown receipt-backed package", () => {
    const installed = installFuturePackage();
    const adapter = loadHarnessSessionAdapterHostModule(installed.identity, { storeRoot });

    expect(
      adapter.buildSessionListPlan({ arguments: ["--limit", "4"], useListSubcommand: true }),
    ).toEqual({ kind: "capture", command: ["future-sessions", "list", "--limit", "4"] });
    expect(
      adapter.interpretSessionListOutput({
        output: "future output",
        jsonOutput: false,
        hiddenSessionIdPrefix: "nemoclaw-internal-",
      }),
    ).toEqual({ kind: "output", output: "FUTURE OUTPUT" });
  });

  it("rejects an executable list plan when the manifest does not declare list", () => {
    const installed = installFuturePackage([]);
    const adapter = loadHarnessSessionAdapterHostModule(installed.identity, { storeRoot });

    expect(() => adapter.buildSessionListPlan({ arguments: [], useListSubcommand: true })).toThrow(
      /does not match its declared list capability/u,
    );
  });

  it("rejects an unsupported plan when the manifest declares list", () => {
    const installed = installFuturePackage(
      ["list"],
      SESSION_MODULE.replace(
        'return { kind: "capture", command: ["future-sessions", "list", ...request.arguments] };',
        'return { kind: "unsupported", reason: "not available" };',
      ),
    );
    const adapter = loadHarnessSessionAdapterHostModule(installed.identity, { storeRoot });

    expect(() => adapter.buildSessionListPlan({ arguments: [], useListSubcommand: true })).toThrow(
      /does not match its declared list capability/u,
    );
  });

  it("rejects a malformed command before core can execute it", () => {
    const installed = installFuturePackage(
      ["list"],
      SESSION_MODULE.replace('["future-sessions", "list", ...request.arguments]', "[]"),
    );
    const adapter = loadHarnessSessionAdapterHostModule(installed.identity, { storeRoot });

    expect(() => adapter.buildSessionListPlan({ arguments: [], useListSubcommand: true })).toThrow(
      /returned an invalid session list plan/u,
    );
  });

  it("loads typed captured delete behavior for a synthetic unknown package", () => {
    const installed = installFuturePackage(
      ["list", "delete"],
      SESSION_MODULE.replace(
        'return { kind: "unsupported", reason: "future " + request.operation + " unavailable" };',
        'return request.operation === "delete" ? { kind: "capture", command: ["future-sessions", "delete", request.key] } : { kind: "unsupported", reason: "reset unavailable" };',
      ).replace(
        'interpretSessionMutationOutput() {\n    return { kind: "refused", reason: "mutation unavailable" };\n  },',
        'interpretSessionMutationOutput(input) {\n    const payload = JSON.parse(input.output);\n    return { kind: "completed", operation: "delete", key: payload.key, removedTranscript: true, entry: null };\n  },',
      ),
    );
    const adapter = loadHarnessSessionAdapterHostModule(installed.identity, { storeRoot });

    expect(
      adapter.buildSessionMutationPlan({
        operation: "delete",
        key: "session-1",
        agent: null,
        keepTranscript: false,
        jsonOutput: false,
        verboseOutput: false,
      }),
    ).toEqual({ kind: "capture", command: ["future-sessions", "delete", "session-1"] });

    expect(
      adapter.interpretSessionMutationOutput({
        request: {
          operation: "delete",
          key: "session-1",
          agent: null,
          keepTranscript: false,
          jsonOutput: false,
          verboseOutput: false,
        },
        plan: { kind: "capture", command: ["future-sessions", "delete", "session-1"] },
        output: '{"key":"future:session-1"}',
      }),
    ).toEqual({
      kind: "completed",
      operation: "delete",
      key: "future:session-1",
      removedTranscript: true,
      entry: null,
    });
  });

  it("rejects manifest and delete-plan disagreement before execution", () => {
    const installed = installFuturePackage(["list", "delete"]);
    const adapter = loadHarnessSessionAdapterHostModule(installed.identity, { storeRoot });

    expect(() =>
      adapter.buildSessionMutationPlan({
        operation: "delete",
        key: "session-1",
        agent: null,
        keepTranscript: false,
        jsonOutput: false,
        verboseOutput: false,
      }),
    ).toThrow(/does not match its declared delete capability/u);
  });

  it("rejects package installation without the fixed session adapter", () => {
    installFuturePackage();
    fs.rmSync(path.join(sourceRoot, "packages/nemoclaw-future-sessions/host/session-adapter.cts"));
    expect(() =>
      installHarnessPackage(
        { packageRoot: sourceRoot, sourceIdentity: SOURCE_IDENTITY },
        { storeRoot: path.join(fixtureRoot, "second-store") },
      ),
    ).toThrow(/requires a non-empty regular artifact 'host\/session-adapter\.cts'/u);
  });
});
