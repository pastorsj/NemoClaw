// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadHarnessMcpAdapterHostModule } from "./host-module";
import { installHarnessPackage } from "./package/install";
import type { InstalledHarnessPackage } from "./package/store";

const TEST_PARENT = path.join(process.cwd(), "node_modules/.cache/nemoclaw-host-module-tests");
const SOURCE_IDENTITY = Object.freeze({
  kind: "bundled" as const,
  nemoclawBuildIdentity: Object.freeze({
    nemoclawVersion: "0.0.113",
    sourceRevision: "d".repeat(40),
  }),
});

const VALID_MODULE = `
module.exports = {
  buildMcpRegistrationCommand(request) {
    return [
      "future-register",
      request.entry.server,
      request.entry.headers.Authorization || "anonymous",
      request.replaceExisting ? "replace" : "create",
      String(request.managedEntries.length),
      request.teardownRollback ? "rollback" : "active",
      request.configRoot || "default-root",
    ];
  },
  buildMcpRemovalCommand(request) {
    return [
      "future-remove",
      request.entry.server,
      request.force ? "force" : "owned",
      request.adaptiveTeardown ? "adaptive" : "current",
      request.configRoot || "default-root",
    ];
  },
};
`;

fs.mkdirSync(TEST_PARENT, { recursive: true, mode: 0o700 });

let fixtureRoot = path.join(TEST_PARENT, "unused");
let sourceRoot = path.join(fixtureRoot, "source");
let storeRoot = path.join(fixtureRoot, "store");

function writeFixtureFile(relativePath: string, contents: string): void {
  const target = path.join(sourceRoot, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, contents, { mode: 0o600 });
  fs.chmodSync(target, 0o600);
}

function writeFuturePackage(moduleSource: string = VALID_MODULE): void {
  fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(sourceRoot, 0o700);
  writeFixtureFile(
    "nemoclaw-package.json",
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "agent-runtime",
      id: "future-harness",
      displayName: "Future Harness",
      packageVersion: "1.0.0",
      manifest: "packages/nemoclaw-future-harness/manifest.yaml",
    })}\n`,
  );
  writeFixtureFile(
    "packages/nemoclaw-future-harness/manifest.yaml",
    [
      "name: future-harness",
      "display_name: Future Harness",
      "mcp:",
      "  support: bridge",
      "  adapter: future-config",
      "  policy_binaries:",
      "    - /usr/local/bin/future-harness",
      "",
    ].join("\n"),
  );
  writeFixtureFile("runtime/payload.txt", "future runtime\n");
  writeFixtureFile("packages/nemoclaw-future-harness/host/mcp-adapter.cts", moduleSource);
}

function installFuturePackage(moduleSource: string = VALID_MODULE): InstalledHarnessPackage {
  writeFuturePackage(moduleSource);
  return installHarnessPackage(
    { packageRoot: sourceRoot, sourceIdentity: SOURCE_IDENTITY },
    { storeRoot },
  );
}

function installFuturePackageWithoutHostModule(): InstalledHarnessPackage {
  writeFuturePackage();
  fs.rmSync(path.join(sourceRoot, "packages/nemoclaw-future-harness/host/mcp-adapter.cts"));
  return installHarnessPackage(
    { packageRoot: sourceRoot, sourceIdentity: SOURCE_IDENTITY },
    { storeRoot },
  );
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(TEST_PARENT, "fixture-"));
  fs.chmodSync(fixtureRoot, 0o700);
  sourceRoot = path.join(fixtureRoot, "source");
  storeRoot = path.join(fixtureRoot, "store");
  fs.mkdirSync(storeRoot, { mode: 0o700 });
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("installed harness host module", () => {
  it("loads a synthetic fourth harness through the fixed MCP command contract", () => {
    const installed = installFuturePackage();
    const module = loadHarnessMcpAdapterHostModule(installed.identity, { storeRoot });

    expect(
      module.buildMcpRegistrationCommand({
        entry: {
          server: "docs",
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer placeholder" },
        },
        managedEntries: [
          { server: "docs", url: "https://example.test/mcp", headers: {} },
          { server: "search", url: "https://search.test/mcp", headers: {} },
        ],
        replaceExisting: true,
        teardownRollback: false,
        configRoot: "/sandbox/.future",
      }),
    ).toEqual([
      "future-register",
      "docs",
      "Bearer placeholder",
      "replace",
      "2",
      "active",
      "/sandbox/.future",
    ]);
    expect(
      module.buildMcpRemovalCommand({
        entry: { server: "docs", url: "https://example.test/mcp", headers: {} },
        force: true,
        adaptiveTeardown: true,
        configRoot: null,
      }),
    ).toEqual(["future-remove", "docs", "force", "adaptive", "default-root"]);
  });

  it("rejects an installed package without the fixed MCP adapter file", () => {
    const installed = installFuturePackageWithoutHostModule();

    expect(() => loadHarnessMcpAdapterHostModule(installed.identity, { storeRoot })).toThrow(
      /does not contain host\/mcp-adapter\.cts/u,
    );
  });

  it("rejects a package whose manifest declares another MCP adapter", () => {
    const installed = installFuturePackage();

    expect(() =>
      loadHarnessMcpAdapterHostModule(installed.identity, {
        storeRoot,
        expectedAdapter: "other-config",
      }),
    ).toThrow(/manifest does not match the requested MCP adapter/u);
  });

  it("rejects an MCP adapter whose installed bytes no longer match its receipt", () => {
    const installed = installFuturePackage();
    fs.writeFileSync(
      path.join(installed.packageRoot, "packages/nemoclaw-future-harness/host/mcp-adapter.cts"),
      `${VALID_MODULE}\n`,
    );

    expect(() => loadHarnessMcpAdapterHostModule(installed.identity, { storeRoot })).toThrow(
      /integrity validation/u,
    );
  });

  it("rejects an MCP adapter that omits a required command builder", () => {
    const installed = installFuturePackage(
      "module.exports = { buildMcpRegistrationCommand() { return 'register'; } };\n",
    );

    expect(() => loadHarnessMcpAdapterHostModule(installed.identity, { storeRoot })).toThrow(
      /must export buildMcpRemovalCommand/u,
    );
  });

  it("rejects a command builder that returns the wrong shape", () => {
    const installed = installFuturePackage(`
module.exports = {
  buildMcpRegistrationCommand() { return { command: "register" }; },
  buildMcpRemovalCommand() { return ["remove"]; },
};
`);
    const module = loadHarnessMcpAdapterHostModule(installed.identity, { storeRoot });

    expect(() =>
      module.buildMcpRegistrationCommand({
        entry: { server: "docs", url: "https://example.test/mcp", headers: {} },
        managedEntries: [],
        replaceExisting: false,
        teardownRollback: false,
        configRoot: null,
      }),
    ).toThrow(/returned an invalid command/u);
  });

  it("rejects package modules that import host dependencies", () => {
    const installed = installFuturePackage(`
require("node:fs");
module.exports = {
  buildMcpRegistrationCommand() { return "register"; },
  buildMcpRemovalCommand() { return "remove"; },
};
`);

    expect(() => loadHarnessMcpAdapterHostModule(installed.identity, { storeRoot })).toThrow(
      /must be self-contained/u,
    );
  });
});
