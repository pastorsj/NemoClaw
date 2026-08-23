// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { testTimeoutOptions } from "../../../../test/helpers/timeouts";
import { harnessPackageContentDigest } from "../../harness/package-registry";
import { loadDeepAgentsMcpRuntime } from "./runtime/mcp-bridge-adapter-deepagents-runtime";
import { loadHermesMcpRuntime } from "./runtime/mcp-bridge-adapter-hermes-runtime";
import { loadOpenClawMcpRuntime } from "./runtime/mcp-bridge-adapter-openclaw-runtime";

const temporaryHomes: string[] = [];
const ENTRY = Object.freeze({ server: "installed", url: "https://mcp.invalid", headers: {} });

const OPENCLAW_RUNTIME_SOURCE = [
  '"use strict";',
  "module.exports = {",
  "  DEFAULT_OPENCLAW_CONFIG_DIR: '/sandbox/.openclaw',",
  "  MCPORTER_VERSION: '0.7.3',",
  "  OPENCLAW_MCPORTER_ROOT: '/sandbox/.openclaw/workspace',",
  "  buildInspectCommand() { return 'installed-inspect'; },",
  "  buildRegisterCommand() { return 'installed-register'; },",
  "  buildRemoveCommand() { return 'installed-remove'; },",
  "  mcporterHeaderMatcherSource() { return 'const match = true;'; },",
  "  mcporterHeadersMatchExpected() { return true; },",
  "  mcporterAvailabilityProbe() { return { command: 'command -v mcporter', failureMessage: 'mcporter missing' }; },",
  "  openClawMcporterRoot() { return '/sandbox/.openclaw/workspace'; },",
  "};",
  "",
].join("\n");

const HERMES_RUNTIME_SOURCE = [
  '"use strict";',
  "function managedServerConfig(entry) {",
  "  return { url: entry.url, enabled: true, timeout: 120, connect_timeout: 60, tools: { resources: true, prompts: true } };",
  "}",
  "module.exports = {",
  "  HERMES_MCP_TRANSACTION_HELPER: '/usr/local/lib/nemoclaw/hermes-mcp.py',",
  "  buildInspectCommand() { return ['helper', 'inspect']; },",
  "  buildIntentPayload(entries) { return { present: Object.fromEntries(entries.map((entry) => [entry.server, managedServerConfig(entry)])), absent: [] }; },",
  "  buildProbeCommand() { return ['helper', 'probe']; },",
  "  buildRegisterCommand() { return ['helper', 'add']; },",
  "  buildRemoveCommand() { return ['helper', 'remove']; },",
  "  buildStatusCommand() { return 'printf registered'; },",
  "  managedServerConfig,",
  "};",
  "",
].join("\n");

const DEEP_AGENTS_RUNTIME_SOURCE = [
  '"use strict";',
  "module.exports = {",
  "  DEEPAGENTS_LEGACY_CONFIG_HELPERS: ['legacy'],",
  "  DEEPAGENTS_LEGACY_MCP_CONFIG_PATH: '/sandbox/.deepagents/.mcp.json',",
  "  DEEPAGENTS_MANAGED_PROJECTION_HELPERS: ['read', 'mutate'],",
  "  DEEPAGENTS_MANAGED_PROJECTION_MUTATION_HELPERS: ['mutate'],",
  "  DEEPAGENTS_MANAGED_PROJECTION_READ_HELPERS: ['read'],",
  "  DEEPAGENTS_MCP_CONFIG_PATH: '/sandbox/.deepagents/.nemoclaw-mcp.json',",
  "  DEEPAGENTS_MCP_MAX_SERVERS: 64,",
  "  DEEPAGENTS_STRICT_JSON_HELPERS: ['strict'],",
  "  buildRegisterCommand() { return 'installed-register'; },",
  "  buildRemoveCommand() { return 'installed-remove'; },",
  "  buildRollbackRegisterCommand() { return 'installed-rollback'; },",
  "  buildStatusCommand() { return 'installed-status'; },",
  "  getMutationCapability() { return { command: 'installed-capability', marker: 'NEMOCLAW_INSTALLED=1', failureMessage: 'capability missing' }; },",
  "  hasRollbackRestoredMarker() { return true; },",
  "  managedServerConfig(entry) { return { type: 'http', url: entry.url }; },",
  "  parseRemovalOutcome() { return 'removed'; },",
  "};",
  "",
].join("\n");

function writeInstalledRuntime(
  id: "openclaw" | "hermes" | "langchain-deepagents-code",
  runtimeRelativePath: string,
  runtimeSource: string,
): { home: string; runtimePath: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-runtime-boundary-"));
  temporaryHomes.push(home);
  const root = path.join(home, ".nemoclaw", "harnesses", `nemoclaw-${id}`);
  const runtimePath = path.join(root, ...runtimeRelativePath.split("/"));
  fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: `@nvidia/nemoclaw-${id}`,
      version: "1.2.3",
      nemoclaw: { harnessManifest: "manifest.yaml" },
    }),
  );
  fs.writeFileSync(path.join(root, "manifest.yaml"), `name: ${id}\n`);
  fs.writeFileSync(path.join(root, "Dockerfile"), "FROM scratch\n");
  fs.writeFileSync(path.join(root, "Dockerfile.base"), "FROM scratch\n");
  fs.writeFileSync(path.join(root, "start.sh"), "#!/usr/bin/env bash\n", { mode: 0o755 });
  fs.writeFileSync(path.join(root, "policy-additions.yaml"), "version: 1\n");
  fs.writeFileSync(runtimePath, runtimeSource);
  fs.writeFileSync(
    path.join(root, ".nemoclaw-install.json"),
    `${JSON.stringify({ installedDigest: harnessPackageContentDigest(root) })}\n`,
    { mode: 0o600 },
  );
  return { home, runtimePath };
}

afterEach(() => {
  vi.unstubAllEnvs();
  temporaryHomes.splice(0).forEach((home) => fs.rmSync(home, { force: true, recursive: true }));
});

describe("harness MCP runtime boundary", testTimeoutOptions(30_000), () => {
  it("keeps a captured OpenClaw runtime after its installed files change", () => {
    const installed = writeInstalledRuntime("openclaw", "mcp-adapter.cts", OPENCLAW_RUNTIME_SOURCE);
    vi.stubEnv("HOME", installed.home);

    expect(loadOpenClawMcpRuntime().buildRegisterCommand(ENTRY)).toBe("installed-register");
    fs.appendFileSync(installed.runtimePath, "// changed after capture\n");
    expect(loadOpenClawMcpRuntime().buildRemoveCommand(ENTRY)).toBe("installed-remove");
  });

  it("keeps a captured Hermes runtime after its installed files change", () => {
    const installed = writeInstalledRuntime(
      "hermes",
      "config/mcp-adapter.cts",
      HERMES_RUNTIME_SOURCE,
    );
    vi.stubEnv("HOME", installed.home);

    expect(loadHermesMcpRuntime().buildProbeCommand()).toEqual(["helper", "probe"]);
    fs.appendFileSync(installed.runtimePath, "// changed after capture\n");
    expect(loadHermesMcpRuntime().buildRegisterCommand(ENTRY)).toEqual(["helper", "add"]);
  });

  it("keeps a captured Deep Agents Code runtime after its installed files change", () => {
    const installed = writeInstalledRuntime(
      "langchain-deepagents-code",
      "mcp-adapter.cts",
      DEEP_AGENTS_RUNTIME_SOURCE,
    );
    vi.stubEnv("HOME", installed.home);

    expect(loadDeepAgentsMcpRuntime().buildRegisterCommand(ENTRY)).toBe("installed-register");
    fs.appendFileSync(installed.runtimePath, "// changed after capture\n");
    expect(loadDeepAgentsMcpRuntime().parseRemovalOutcome("ignored")).toBe("removed");
  });

  it("rejects OpenClaw probe text and comparison results outside the contract", () => {
    const source = OPENCLAW_RUNTIME_SOURCE.replace(
      "{ command: 'command -v mcporter', failureMessage: 'mcporter missing' }",
      "{ command: 'probe\\nbad', failureMessage: 'mcporter missing' }",
    ).replace(
      "mcporterHeadersMatchExpected() { return true; }",
      "mcporterHeadersMatchExpected() { return 'yes'; }",
    );
    const installed = writeInstalledRuntime("openclaw", "mcp-adapter.cts", source);
    vi.stubEnv("HOME", installed.home);
    const runtime = loadOpenClawMcpRuntime();

    expect(() => runtime.mcporterAvailabilityProbe("box")).toThrow(
      "OpenClaw harness MCP adapter returned an invalid availability probe command.",
    );
    expect(() => runtime.mcporterHeadersMatchExpected({}, {})).toThrow(
      "OpenClaw harness MCP adapter returned an invalid header comparison result.",
    );
  });

  it("rejects unsafe Hermes argv and changed managed-config shapes", () => {
    const source = HERMES_RUNTIME_SOURCE.replace(
      "buildProbeCommand() { return ['helper', 'probe']; }",
      "buildProbeCommand() { return ['helper', 'probe\\nbad']; }",
    ).replace(
      "return { url: entry.url, enabled: true, timeout: 120, connect_timeout: 60, tools: { resources: true, prompts: true } };",
      "return { url: entry.url, enabled: true, timeout: 120, connect_timeout: 60, tools: { resources: true, prompts: true }, injected: true };",
    );
    const installed = writeInstalledRuntime("hermes", "config/mcp-adapter.cts", source);
    vi.stubEnv("HOME", installed.home);
    const runtime = loadHermesMcpRuntime();

    expect(() => runtime.buildProbeCommand()).toThrow(
      "Hermes harness MCP adapter returned an invalid probe command.",
    );
    expect(() => runtime.managedServerConfig(ENTRY)).toThrow(
      "Hermes harness MCP adapter returned an invalid managed server config.",
    );
  });

  it("rejects unsafe Deep Agents capability markers and unknown result enums", () => {
    const source = DEEP_AGENTS_RUNTIME_SOURCE.replace(
      "marker: 'NEMOCLAW_INSTALLED=1'",
      "marker: 'NEMOCLAW_INSTALLED=1\\nbad'",
    ).replace(
      "parseRemovalOutcome() { return 'removed'; }",
      "parseRemovalOutcome() { return 'destroyed'; }",
    );
    const installed = writeInstalledRuntime("langchain-deepagents-code", "mcp-adapter.cts", source);
    vi.stubEnv("HOME", installed.home);
    const runtime = loadDeepAgentsMcpRuntime();

    expect(() => runtime.getMutationCapability("box")).toThrow(
      "Deep Agents Code harness MCP adapter returned an invalid mutation capability marker.",
    );
    expect(() => runtime.parseRemovalOutcome("ignored")).toThrow(
      "Deep Agents Code harness MCP adapter returned an invalid removal outcome.",
    );
  });
});
