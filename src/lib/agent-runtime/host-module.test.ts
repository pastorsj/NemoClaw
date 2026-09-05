// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadHarnessAdapter } from "./adapter/loader";
import { HARNESS_MCP_ADAPTER_CONTRACT } from "./adapter/mcp";
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
  buildMcpRegistrationPlan(request) {
    return {
      execution: {
        command: [
          "future-register",
          request.entry.server,
          request.entry.headers.Authorization || "anonymous",
          request.replaceExisting ? "replace" : "create",
          String(request.managedEntries.length),
          request.teardownRollback ? "rollback" : "active",
          request.configDirectory || "default-directory",
        ],
        timeoutSeconds: 15,
        success: { kind: "exit-zero" },
        failureMessage: "Future registration failed",
      },
      verification: { kind: "inspection", failureMessage: "Future verification failed" },
      credentialConvergence: { kind: "none" },
    };
  },
  buildMcpRemovalPlan(request) {
    return {
      execution: {
        command: [
          "future-remove",
          request.entry.server,
          request.force ? "force" : "owned",
          request.adaptiveTeardown ? "adaptive" : "current",
          request.configDirectory || "default-directory",
        ],
        timeoutSeconds: 15,
        success: { kind: "exit-zero" },
        failureMessage: "Future removal failed",
      },
      outcome: { kind: "removed" },
    };
  },
  buildMcpInspectionCommand(request) {
    return [
      "future-inspect",
      request.entry.server,
      request.failOnMismatch ? "strict" : "observe",
      request.configDirectory || "default-directory",
    ].join(":");
  },
  describeMcpMutationCapability(request) {
    return {
      kind: "command",
      command: ["future-probe", request.sandboxName],
      success: { kind: "stdout-trimmed-equals", value: "FUTURE_MCP_READY" },
      timeoutSeconds: 30,
      failureMessage: "Future Harness MCP support is unavailable",
    };
  },
  describeMcpTeardownCapability() {
    return { kind: "not-required" };
  },
  describeMcpRuntimeIntentVerification(request) {
    return {
      kind: "command",
      command: [
        "future-verify",
        String(request.entries.length),
        request.managedServerNames.join(","),
      ],
      success: { kind: "exit-zero" },
      timeoutSeconds: 10,
      failureMessage: "Future runtime intent mismatch",
    };
  },
  buildMcpRuntimePlan(request) {
    return { command: ["future-runtime", ...request.command], environmentVariablesToRemove: [] };
  },
  buildMcpSnapshotRestorePlan() {
    return { kind: "not-required" };
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
      minimumNemoClawVersion: "0.0.113",
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

function installFuturePackageWithoutMcpCapability(): InstalledHarnessPackage {
  writeFuturePackage();
  writeFixtureFile(
    "packages/nemoclaw-future-harness/manifest.yaml",
    [
      "name: future-harness",
      "display_name: Future Harness",
      "mcp:",
      "  support: disabled",
      "",
    ].join("\n"),
  );
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
  it("loads a synthetic fourth harness through the fixed MCP plan contract", () => {
    const installed = installFuturePackage();
    const module = loadHarnessMcpAdapterHostModule(installed.identity, { storeRoot });

    expect(
      module.buildMcpRegistrationPlan({
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
        configDirectory: "/sandbox/.future",
      }),
    ).toMatchObject({
      execution: {
        command: [
          "future-register",
          "docs",
          "Bearer placeholder",
          "replace",
          "2",
          "active",
          "/sandbox/.future",
        ],
      },
      verification: { kind: "inspection" },
      credentialConvergence: { kind: "none" },
    });
    expect(
      module.buildMcpRemovalPlan({
        entry: { server: "docs", url: "https://example.test/mcp", headers: {} },
        force: true,
        adaptiveTeardown: true,
        configDirectory: null,
      }),
    ).toMatchObject({
      execution: {
        command: ["future-remove", "docs", "force", "adaptive", "default-directory"],
      },
      outcome: { kind: "removed" },
    });
    expect(
      module.buildMcpInspectionCommand({
        entry: { server: "docs", url: "https://example.test/mcp", headers: {} },
        failOnMismatch: true,
        configDirectory: "/sandbox/.future",
      }),
    ).toBe("future-inspect:docs:strict:/sandbox/.future");
    expect(module.describeMcpMutationCapability({ sandboxName: "future-sandbox" })).toEqual({
      kind: "command",
      command: ["future-probe", "future-sandbox"],
      success: { kind: "stdout-trimmed-equals", value: "FUTURE_MCP_READY" },
      timeoutSeconds: 30,
      failureMessage: "Future Harness MCP support is unavailable",
    });
    expect(module.describeMcpTeardownCapability({ sandboxName: "future-sandbox" })).toEqual({
      kind: "not-required",
    });
    expect(
      module.describeMcpRuntimeIntentVerification({
        entries: [{ server: "docs", url: "https://example.test/mcp", headers: {} }],
        managedServerNames: ["docs", "search"],
      }),
    ).toEqual({
      kind: "command",
      command: ["future-verify", "1", "docs,search"],
      success: { kind: "exit-zero" },
      timeoutSeconds: 10,
      failureMessage: "Future runtime intent mismatch",
    });
    expect(module.buildMcpRuntimePlan({ command: ["node", "probe.mjs"] })).toEqual({
      command: ["future-runtime", "node", "probe.mjs"],
      environmentVariablesToRemove: [],
    });
    expect(module.buildMcpSnapshotRestorePlan({ sandboxName: "sandbox", entries: [] })).toEqual({
      kind: "not-required",
    });
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

  it("rejects a package that does not declare MCP before the generic loader runs it", () => {
    const installed = installFuturePackageWithoutMcpCapability();

    expect(() =>
      loadHarnessAdapter(installed.identity, HARNESS_MCP_ADAPTER_CONTRACT, { storeRoot }),
    ).toThrow(/manifest does not declare MCP adapter/u);
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

  it("rejects an MCP adapter that omits a required plan builder", () => {
    const installed = installFuturePackage(
      "module.exports = { buildMcpRegistrationPlan() { return {}; } };\n",
    );

    expect(() => loadHarnessMcpAdapterHostModule(installed.identity, { storeRoot })).toThrow(
      /must export buildMcpRemovalPlan/u,
    );
  });

  it("rejects a plan builder that returns the wrong shape", () => {
    const installed = installFuturePackage(`
module.exports = {
  buildMcpRegistrationPlan() { return { command: "register" }; },
  buildMcpRemovalPlan() { return { command: "remove" }; },
  buildMcpInspectionCommand() { return "inspect"; },
  describeMcpMutationCapability() { return { kind: "not-required" }; },
  describeMcpTeardownCapability() { return { kind: "not-required" }; },
  describeMcpRuntimeIntentVerification() { return { kind: "not-required" }; },
  buildMcpRuntimePlan() { return "runtime"; },
  buildMcpSnapshotRestorePlan() { return { kind: "not-required" }; },
};
`);
    const module = loadHarnessMcpAdapterHostModule(installed.identity, { storeRoot });

    expect(() =>
      module.buildMcpRegistrationPlan({
        entry: { server: "docs", url: "https://example.test/mcp", headers: {} },
        managedEntries: [],
        replaceExisting: false,
        teardownRollback: false,
        configDirectory: null,
      }),
    ).toThrow(/returned an invalid registration plan/u);
  });

  it("validates requests before package code receives them", () => {
    const installed = installFuturePackage();
    const module = loadHarnessMcpAdapterHostModule(installed.identity, { storeRoot });
    const invalidRequest = {
      entry: { server: "docs", url: "https://example.test/mcp", headers: {} },
      managedEntries: [],
      replaceExisting: "yes",
      teardownRollback: false,
      configDirectory: null,
    } as unknown as Parameters<typeof module.buildMcpRegistrationPlan>[0];

    expect(() => module.buildMcpRegistrationPlan(invalidRequest)).toThrow(
      /request does not satisfy its schema/u,
    );
  });

  it("rejects raw shell text from the runtime wrapper operation", () => {
    const installed = installFuturePackage(
      VALID_MODULE.replace(
        'return { command: ["future-runtime", ...request.command], environmentVariablesToRemove: [] };',
        'return { command: ["future-runtime", ...request.command].join(" "), environmentVariablesToRemove: [] };',
      ),
    );
    const module = loadHarnessMcpAdapterHostModule(installed.identity, { storeRoot });

    expect(() => module.buildMcpRuntimePlan({ command: ["node", "probe.mjs"] })).toThrow(
      /returned an invalid runtime plan/u,
    );
  });

  it("rejects unsafe environment variable names from a runtime plan", () => {
    const installed = installFuturePackage(
      VALID_MODULE.replace(
        "environmentVariablesToRemove: [] }",
        'environmentVariablesToRemove: ["SAFE; touch /tmp/unsafe"] }',
      ),
    );
    const module = loadHarnessMcpAdapterHostModule(installed.identity, { storeRoot });

    expect(() => module.buildMcpRuntimePlan({ command: ["node", "probe.mjs"] })).toThrow(
      /returned an invalid runtime plan/u,
    );
  });

  it("gives package code a detached frozen request and freezes its result", () => {
    const installed = installFuturePackage(`
module.exports = {
  buildMcpRegistrationPlan(request) {
    try { request.entry.server = "changed"; } catch {}
    try { request.managedEntries.push(request.entry); } catch {}
    return {
      execution: {
        command: [request.entry.server, String(request.managedEntries.length)],
        timeoutSeconds: 15,
        success: { kind: "exit-zero" },
        failureMessage: "Future registration failed",
      },
      verification: { kind: "inspection", failureMessage: "Future verification failed" },
      credentialConvergence: { kind: "none" },
    };
  },
  buildMcpRemovalPlan() {
    return {
      execution: { command: ["remove"], timeoutSeconds: 15, success: { kind: "exit-zero" }, failureMessage: "Future removal failed" },
      outcome: { kind: "removed" },
    };
  },
  buildMcpInspectionCommand() { return "inspect"; },
  describeMcpMutationCapability() { return { kind: "not-required" }; },
  describeMcpTeardownCapability() { return { kind: "not-required" }; },
  describeMcpRuntimeIntentVerification() { return { kind: "not-required" }; },
  buildMcpRuntimePlan() { return "runtime"; },
  buildMcpSnapshotRestorePlan() { return { kind: "not-required" }; },
};
`);
    const module = loadHarnessMcpAdapterHostModule(installed.identity, { storeRoot });
    const request = {
      entry: { server: "docs", url: "https://example.test/mcp", headers: {} },
      managedEntries: [],
      replaceExisting: false,
      teardownRollback: false,
      configDirectory: null,
    };

    const plan = module.buildMcpRegistrationPlan(request);

    expect(plan.execution.command).toEqual(["docs", "0"]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.execution.command)).toBe(true);
    expect(request.entry.server).toBe("docs");
    expect(request.managedEntries).toEqual([]);
  });

  it("rejects capability data outside the fixed probe descriptions", () => {
    const installed = installFuturePackage(
      VALID_MODULE.replace(
        'describeMcpTeardownCapability() {\n    return { kind: "not-required" };\n  }',
        'describeMcpTeardownCapability() {\n    return { kind: "callback", module: "probe.js" };\n  }',
      ),
    );
    const module = loadHarnessMcpAdapterHostModule(installed.identity, { storeRoot });

    expect(() => module.describeMcpTeardownCapability({ sandboxName: "future-sandbox" })).toThrow(
      /returned an invalid teardown capability probe/u,
    );
  });

  it("rejects package modules that import host dependencies", () => {
    const installed = installFuturePackage(`
require("node:fs");
module.exports = {
  buildMcpRegistrationPlan() { return {}; },
  buildMcpRemovalPlan() { return {}; },
};
`);

    expect(() => loadHarnessMcpAdapterHostModule(installed.identity, { storeRoot })).toThrow(
      /must be self-contained/u,
    );
  });
});
