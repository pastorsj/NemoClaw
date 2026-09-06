// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CONTRACT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.dirname(CONTRACT_ROOT);
const EXPECTED_PUBLISHED_FILES = Object.freeze(
  [
    "Dockerfile",
    "Dockerfile.base",
    "host/config-adapter.cts",
    "host/mcp-adapter.cts",
    "host/messaging-adapter.cts",
    "host/restore-adapter.cts",
    "host/session-adapter.cts",
    "host/startup-adapter.cts",
    "fabric/future.fabric-adapter.json",
    "fabric/turn.cjs",
    "manifest.yaml",
    "messaging/profile.json",
    "package.json",
    "policy-additions.yaml",
    "start.sh",
  ].sort(),
);
const EXPECTED_ARTIFACT_FILES = Object.freeze(
  [...EXPECTED_PUBLISHED_FILES, "nemoclaw-package.json"].sort(),
);

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

function writeFile(root: string, relativePath: string, contents: string, mode = 0o644): void {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents, { mode });
}

function runCommand(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
  input?: string,
): CommandResult {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    env: environment,
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    timeout: 120_000,
    input,
  });
  assert.equal(
    result.status,
    0,
    [
      `${command} ${arguments_.join(" ")} failed`,
      result.error?.message ?? "",
      result.stdout,
      result.stderr,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return Object.freeze({ stdout: result.stdout, stderr: result.stderr });
}

function packLocalPackage(packageRoot: string, archiveRoot: string, runPrepare = false): string {
  const result = runCommand(
    "npm",
    [
      "pack",
      "--json",
      "--silent",
      ...(runPrepare ? [] : ["--ignore-scripts"]),
      "--pack-destination",
      archiveRoot,
      packageRoot,
    ],
    archiveRoot,
  );
  const reports = JSON.parse(result.stdout) as ReadonlyArray<{ readonly filename?: unknown }>;
  assert.equal(reports.length, 1);
  assert.equal(typeof reports[0]?.filename, "string");
  const archivePath = path.join(archiveRoot, reports[0]?.filename as string);
  assert.equal(fs.lstatSync(archivePath).isFile(), true);
  return archivePath;
}

function listFiles(root: string, relativeDirectory = ""): string[] {
  const directory = path.join(root, relativeDirectory);
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      return entry.isDirectory() ? listFiles(root, relativePath) : [relativePath];
    })
    .sort();
}

function makeDirectoriesWritable(root: string): void {
  if (!fs.existsSync(root)) return;
  const stats = fs.lstatSync(root);
  if (stats.isSymbolicLink() || !stats.isDirectory()) return;
  fs.chmodSync(root, 0o700);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      makeDirectoriesWritable(path.join(root, entry.name));
    }
  }
}

function createExternalPackage(packageRoot: string, archives: readonly string[]): void {
  const [contractArchive, typescriptArchive, yamlArchive] = archives;
  assert.ok(contractArchive && typescriptArchive && yamlArchive);
  writeFile(
    packageRoot,
    "package.json",
    `${JSON.stringify(
      {
        name: "@example/nemoclaw-future-terminal",
        version: "1.0.0",
        description: "Independent typed harness contract proof",
        license: "Apache-2.0",
        scripts: {
          "build:adapters": "nemoclaw-build-adapters .",
          "check:adapters": "tsc -p tsconfig.adapters.json && nemoclaw-build-adapters . --check",
          "check:package": "nemoclaw-validate-package --json .",
          "build:package":
            "nemoclaw-build-package --json --create-output-parent . ../dist/future-terminal",
          "test:fabric": "node fabric-check.cjs",
        },
        files: [
          "Dockerfile.base",
          "Dockerfile",
          "fabric/*.json",
          "fabric/*.cjs",
          "manifest.yaml",
          "messaging/*.json",
          "policy-additions.yaml",
          "start.sh",
          "host/*-adapter.cts",
        ],
        devDependencies: {
          "@nvidia/nemoclaw-harness-contract": `file:${contractArchive}`,
          typescript: `file:${typescriptArchive}`,
          yaml: `file:${yamlArchive}`,
        },
        nemoclaw: {
          harnessManifest: "manifest.yaml",
          minimumNemoClawVersion: "0.0.113",
          maximumNemoClawVersionExclusive: "0.0.121",
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFile(
    packageRoot,
    "tsconfig.adapters.json",
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "Node16",
          moduleResolution: "Node16",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ["host/source/**/*.cts", "authoring-check.mts"],
      },
      null,
      2,
    )}\n`,
  );
  writeFile(packageRoot, "Dockerfile.base", "FROM scratch\n");
  writeFile(packageRoot, "Dockerfile", "FROM scratch\n");
  writeFile(
    packageRoot,
    "manifest.yaml",
    [
      "name: future-terminal",
      'display_name: "Future Terminal"',
      "runtime:",
      "  kind: gateway",
      "  interactive_command: future-terminal",
      "  prompt_transport: stdin",
      "  headless_command: node fabric/turn.cjs",
      "  process_lifecycle:",
      "    support: managed",
      "    command: [/usr/local/bin/future-process]",
      "managed_image:",
      "  repository: registry.example/future/agent",
      "  architectures: [linux/amd64]",
      "  runtime_identity:",
      "    uid: 1000",
      "    gid: 1000",
      "    workdir: /sandbox",
      "  state_root:",
      "    mount_target: /sandbox/.future-terminal",
      '    mode: "2770"',
      "config:",
      "  dir: /sandbox/.future-terminal",
      "  config_file: config.json",
      "  format: json",
      "inference:",
      "  config_update:",
      "    support: unsupported",
      "    reason: This terminal has no mutable inference configuration.",
      "state_lifecycle:",
      "  backup_quiescence:",
      "    kind: command",
      "    command: [/usr/local/bin/future-state, backup-ready]",
      "    timeout_seconds: 30",
      "  snapshot_restore: [repair-mutable-config]",
      "  rebuild:",
      "    image_plugin_provenance: not-required",
      "    scheduled_work:",
      "      support: disabled",
      "      reason: This package does not run scheduled work.",
      "    post_restore:",
      "      kind: managed",
      "      command: null",
      "      reapply_messaging: true",
      "      restart_runtime: false",
      "      mutable_config: repair",
      "      config_integrity:",
      "        kind: not-required",
      "      settle_device_pairing: false",
      "      notify_gateway_token_change: false",
      "state_files:",
      "  - path: config.json",
      "    restore:",
      "      merge: package-config",
      "mcp:",
      "  support: bridge",
      "  adapter: future-mcp",
      "  policy_binaries: [/usr/local/bin/future-terminal]",
      "messaging:",
      "  support: channels",
      "  channels: [future-chat]",
      "sessions:",
      "  operations: [list, delete, reset, export]",
      "",
    ].join("\n"),
  );
  writeFile(packageRoot, "policy-additions.yaml", "network_policies: []\n");
  writeFile(packageRoot, "start.sh", "#!/bin/sh\nexec sleep infinity\n", 0o755);
  writeFile(
    packageRoot,
    "messaging/profile.json",
    `${JSON.stringify([
      {
        channelId: "future-chat",
        config: { renders: [] },
        policy: [],
        lifecycle: { hookIds: [] },
      },
    ])}\n`,
  );
  writeFile(
    packageRoot,
    "fabric/future.fabric-adapter.json",
    `${JSON.stringify({
      contract_version: "fabric.adapter/v1alpha2",
      adapter_id: "example.future-terminal",
      adapter_kind: "python",
      runner: { module: "future_terminal_fabric.adapter" },
      requirements: { binaries: ["future-terminal"] },
      settings_schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      capabilities: {
        streaming: false,
        cancellation: false,
        updates: false,
        service: false,
      },
    })}\n`,
  );
  writeFile(
    packageRoot,
    "fabric/turn.cjs",
    [
      '"use strict";',
      "let prompt = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { prompt += chunk; });",
      "process.stdin.on('end', () => {",
      "  const text = prompt.trim();",
      "  if (!text || Buffer.byteLength(text, 'utf8') > 4096) process.exitCode = 2;",
      "  else process.stdout.write(JSON.stringify({ harness: 'example.future-terminal', status: 'completed', output: `future:${text}` }) + '\\n');",
      "});",
      "",
    ].join("\n"),
  );
  writeFile(
    packageRoot,
    "fabric-check.cjs",
    [
      '"use strict";',
      'const assert = require("node:assert/strict");',
      'const { spawnSync } = require("node:child_process");',
      'const fs = require("node:fs");',
      'const descriptor = JSON.parse(fs.readFileSync("fabric/future.fabric-adapter.json", "utf8"));',
      'assert.equal(descriptor.contract_version, "fabric.adapter/v1alpha2");',
      'assert.equal(descriptor.adapter_id, "example.future-terminal");',
      'assert.equal(descriptor.runner.module, "future_terminal_fabric.adapter");',
      'const turn = spawnSync(process.execPath, ["fabric/turn.cjs"], { encoding: "utf8", input: "external package turn\\n", timeout: 5000 });',
      "assert.equal(turn.status, 0);",
      'assert.deepEqual(JSON.parse(turn.stdout), { harness: "example.future-terminal", status: "completed", output: "future:external package turn" });',
      "",
    ].join("\n"),
  );
  writeFile(
    packageRoot,
    "authoring-check.mts",
    [
      'import { assertHarnessAdapterArtifactsCurrent, buildHarnessAdapterArtifacts } from "@nvidia/nemoclaw-harness-contract/build-adapters";',
      'import { validateHarnessManifest } from "@nvidia/nemoclaw-harness-contract/manifest-validator";',
      'import type { HarnessAgentManifest, HarnessProcessLifecycleDeclaration } from "@nvidia/nemoclaw-harness-contract";',
      "",
      'const packageRoot: string = ".";',
      "buildHarnessAdapterArtifacts(packageRoot);",
      "assertHarnessAdapterArtifactsCurrent(packageRoot);",
      "const manifest: HarnessAgentManifest = {",
      '  name: "future-terminal",',
      '  runtime: { kind: "gateway", interactive_command: "future-terminal", headless_command: "node fabric/turn.cjs", prompt_transport: "stdin", process_lifecycle: { support: "managed", command: ["/usr/local/bin/future-process"] } },',
      '  managed_image: { repository: "registry.example/future/agent", architectures: ["linux/amd64"], runtime_identity: { uid: 1000, gid: 1000, workdir: "/sandbox" }, state_root: { mount_target: "/sandbox/.future-terminal", mode: "2770" } },',
      '  config: { dir: "/sandbox/.future-terminal", config_file: "config.json", format: "json" },',
      '  inference: { config_update: { support: "unsupported", reason: "fixed" } },',
      '  state_lifecycle: { backup_quiescence: { kind: "command", command: ["/usr/local/bin/future-state", "backup-ready"], timeout_seconds: 30 }, snapshot_restore: ["repair-mutable-config"], rebuild: { image_plugin_provenance: "not-required", scheduled_work: { support: "disabled", reason: "No scheduled work." }, post_restore: { kind: "managed", command: null, reapply_messaging: true, restart_runtime: false, mutable_config: "repair", config_integrity: { kind: "not-required" }, settle_device_pairing: false, notify_gateway_token_change: false } } },',
      '  state_files: [{ path: "config.json", restore: { merge: "package-config" } }],',
      '  mcp: { support: "bridge", adapter: "future-mcp", policy_binaries: ["/usr/local/bin/future-terminal"] },',
      '  messaging: { support: "channels", channels: ["future-chat"] },',
      '  sessions: { operations: ["list", "delete", "reset", "export"] },',
      "};",
      'const unsupportedProcess: HarnessProcessLifecycleDeclaration = { support: "unsupported", reason: "No managed process." };',
      'if (unsupportedProcess.support !== "unsupported") throw new Error("Typed unsupported process declaration was lost");',
      'validateHarnessManifest(manifest, "future-terminal");',
      "",
    ].join("\n"),
  );
  writeFile(
    packageRoot,
    "contract-check.cjs",
    [
      '"use strict";',
      'const assert = require("node:assert/strict");',
      'const fs = require("node:fs");',
      'const { parse } = require("yaml");',
      'const { validateHarnessManifest } = require("@nvidia/nemoclaw-harness-contract/manifest-validator");',
      'const manifest = parse(fs.readFileSync("manifest.yaml", "utf8"));',
      'validateHarnessManifest(manifest, "future-terminal");',
      'assert.equal(manifest.runtime.process_lifecycle.support, "managed");',
      'assert.equal(manifest.state_lifecycle.backup_quiescence.kind, "command");',
      'assert.equal(manifest.state_lifecycle.rebuild.post_restore.kind, "managed");',
      'assert.equal(manifest.state_files[0].restore.merge, "package-config");',
      'assert.equal(manifest.runtime.headless_command, "node fabric/turn.cjs");',
      'validateHarnessManifest({ ...manifest, runtime: { kind: "terminal", interactive_command: "future-terminal", headless_command: "node fabric/turn.cjs", prompt_transport: "stdin", process_lifecycle: { support: "unsupported", reason: "This terminal owns no persistent process." } } }, "future-terminal");',
      'const config = require("./host/config-adapter.cts");',
      'const configTarget = { directory: "/sandbox/.future-terminal", file: "config.json", format: "json", sensitiveFiles: [] };',
      'assert.equal(config.describeInferenceConfig({ target: configTarget }).kind, "unsupported");',
      'assert.equal(config.prepareInferenceConfig({ target: configTarget, config: {}, route: { upstreamProvider: "nvidia", model: "future", providerKey: "nvidia", primaryModelRef: null, baseUrl: "https://inference.local/v1", api: "openai-completions", compatibility: null }, contextWindow: null, reasoning: { effort: null, explicit: false } }).kind, "unsupported");',
      'assert.equal(config.prepareConfigUpdate({ config: {}, serializedConfig: "{}\\n", expectedConfigSha256: "a".repeat(64), target: configTarget }).kind, "immutable");',
      'assert.deepEqual(config.classifyConfigUrl({ config: {}, key: "endpoint", relativePath: [] }), { allowPrivateUrls: false, allowOpenShellBridge: false });',
      'assert.equal(config.describeMutableConfig({ target: configTarget, sandboxUid: null, sandboxGid: null }).kind, "not-required");',
      'const messaging = require("./host/messaging-adapter.cts");',
      'assert.deepEqual(messaging.describeMessagingIntegration({ packageId: "future-terminal" }), { kind: "channels", packageId: "future-terminal", channelIds: ["future-chat"], profilePath: "messaging/profile.json", build: { configRoot: "~/.future-terminal", packageManagers: [] } });',
      'const startup = require("./host/startup-adapter.cts");',
      'assert.equal(startup.buildStartupPlan({ packageId: "future-terminal", settings: {}, applicationEnvironment: {} }).packageId, "future-terminal");',
      'assert.equal(startup.prepareStartupProfile({ packageId: "future-terminal" }).kind, "unsupported");',
      'assert.equal(startup.buildInitialStartupProfile({ packageId: "future-terminal", harnessPackage: { kind: "agent-runtime", id: "future-terminal", packageVersion: "1.0.0", contentDigest: "a".repeat(64) }, desiredState: {} }).kind, "package-config");',
      'assert.equal(startup.reconcileStartupProfile({ packageId: "future-terminal", harnessPackage: { kind: "agent-runtime", id: "future-terminal", packageVersion: "1.0.0", contentDigest: "a".repeat(64) }, desiredState: {}, currentPackageConfig: {} }).changed, false);',
      'const mcp = require("./host/mcp-adapter.cts");',
      'const mcpEntry = { server: "docs", url: "https://example.test/mcp", headers: {} };',
      'assert.equal(mcp.buildMcpRegistrationPlan({ entry: mcpEntry, managedEntries: [], replaceExisting: false, teardownRollback: false, configDirectory: null }).execution.command.argv[0], "future-mcp");',
      'assert.equal(mcp.buildMcpRemovalPlan({ entry: mcpEntry, force: false, adaptiveTeardown: false, configDirectory: null }).outcome.kind, "removed");',
      'assert.equal(mcp.buildMcpInspectionCommand({ entry: mcpEntry, failOnMismatch: false, configDirectory: null }).script, "future-mcp inspect docs");',
      'assert.equal(mcp.describeMcpMutationCapability({ sandboxName: "future" }).kind, "command");',
      'assert.equal(mcp.describeMcpTeardownCapability({ sandboxName: "future" }).kind, "not-required");',
      'assert.equal(mcp.describeMcpRuntimeIntentVerification({ entries: [mcpEntry], managedServerNames: ["docs"] }).kind, "not-required");',
      'assert.deepEqual(mcp.buildMcpRuntimePlan({ command: ["probe"] }), { command: ["future-mcp", "runtime", "probe"], environmentVariablesToRemove: ["FUTURE_MCP_TOKEN"] });',
      'assert.equal(mcp.buildMcpSnapshotRestorePlan({ sandboxName: "future", entries: [] }).kind, "not-required");',
      'const sessions = require("./host/session-adapter.cts");',
      'assert.equal(sessions.buildSessionListPlan({ arguments: [], useListSubcommand: true }).kind, "capture");',
      'assert.equal(sessions.interpretSessionListOutput({ output: "[]", jsonOutput: true, hiddenSessionIdPrefix: "warmup-" }).kind, "output");',
      'const mutationRequest = { operation: "delete", key: "future", agent: null, keepTranscript: false, jsonOutput: true, verboseOutput: false };',
      "const mutationPlan = sessions.buildSessionMutationPlan(mutationRequest);",
      'assert.equal(mutationPlan.kind, "capture");',
      'assert.equal(sessions.interpretSessionMutationOutput({ request: mutationRequest, plan: mutationPlan, output: "{}" }).kind, "completed");',
      'assert.equal(sessions.buildSessionExportPlan({ agent: null, keys: [], format: "dir", includeTrajectory: false, stagingFiles: { tar: "/sandbox/tmp/future.tar", jsonl: "/sandbox/tmp/future.jsonl" } }).kind, "native-file");',
      'assert.equal(sessions.interpretSessionExportIndex({ output: "[]", agent: "future-terminal", selectedKeys: "all", includeTrajectory: false, hiddenSessionIdPrefix: "warmup-" }).kind, "selection");',
      'assert.equal(sessions.buildSessionListPlan({ arguments: ["--unsupported"], useListSubcommand: true }).kind, "unsupported");',
      'const restore = require("./host/restore-adapter.cts");',
      'const restored = restore.mergeConfigState({ backupContent: "{\\"user\\":true}", currentContent: "{\\"managed\\":true}", managedChannelNames: [], previousImagePluginInstalls: null, freshImagePluginInstalls: null });',
      "assert.deepEqual(JSON.parse(restored.content), { user: true, managed: true });",
      "try {",
      "  validateHarnessManifest({",
      "    ...manifest,",
      '    config: { ...manifest.config, config_file: "/sandbox/config.json" },',
      '  }, "future-terminal");',
      '  throw new Error("Malformed manifest unexpectedly passed validation");',
      "} catch (error) {",
      '  if (!String(error).includes("config.config_file")) throw error;',
      "}",
      "",
    ].join("\n"),
  );
  writeFile(
    packageRoot,
    "host/source/config-adapter.cts",
    [
      "// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.",
      "// SPDX-License-Identifier: Apache-2.0",
      "",
      'import type { HarnessConfigAdapterModule } from "@nvidia/nemoclaw-harness-contract";',
      "",
      "const configAdapter: HarnessConfigAdapterModule = {",
      "  describeInferenceConfig() {",
      '    return { kind: "unsupported", reason: "This terminal has no inference configuration." };',
      "  },",
      "  prepareInferenceConfig() {",
      '    return { kind: "unsupported", reason: "This terminal has no inference configuration." };',
      "  },",
      "  prepareConfigUpdate() {",
      '    return { kind: "immutable", reason: "This terminal has no mutable configuration." };',
      "  },",
      "  classifyConfigUrl() {",
      "    return { allowPrivateUrls: false, allowOpenShellBridge: false };",
      "  },",
      "  describeMutableConfig() {",
      '    return { kind: "not-required", reason: "This terminal has no mutable configuration." };',
      "  },",
      "};",
      "",
      "export = configAdapter;",
      "",
    ].join("\n"),
  );
  writeFile(
    packageRoot,
    "host/source/messaging-adapter.cts",
    [
      "// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.",
      "// SPDX-License-Identifier: Apache-2.0",
      "",
      'import type { HarnessMessagingAdapterModule } from "@nvidia/nemoclaw-harness-contract";',
      "",
      "const messagingAdapter: HarnessMessagingAdapterModule = {",
      "  describeMessagingIntegration(request) {",
      '    if (request.packageId !== "future-terminal") {',
      '      throw new Error("Messaging request does not match the installed package.");',
      "    }",
      "    return {",
      '      kind: "channels",',
      '      packageId: "future-terminal",',
      '      channelIds: ["future-chat"],',
      '      profilePath: "messaging/profile.json",',
      '      build: { configRoot: "~/.future-terminal", packageManagers: [] },',
      "    };",
      "  },",
      "};",
      "",
      "export = messagingAdapter;",
      "",
    ].join("\n"),
  );
  writeFile(
    packageRoot,
    "host/source/startup-adapter.cts",
    [
      "// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.",
      "// SPDX-License-Identifier: Apache-2.0",
      "",
      'import type { HarnessStartupAdapterModule } from "@nvidia/nemoclaw-harness-contract";',
      "",
      "const startupAdapter: HarnessStartupAdapterModule = {",
      "  buildStartupPlan() {",
      "    return {",
      "      schemaVersion: 1,",
      '      packageId: "future-terminal",',
      "      configurationEnvironment: {},",
      "      runtimeEnvironment: {},",
      "      applicationRuntime: { exportEnvironment: {}, unsetEnvironment: [] },",
      '      managedState: { root: "/sandbox/.future-terminal", files: ["config.json"], directories: [] },',
      "      materials: [],",
      "      actions: [],",
      "    };",
      "  },",
      "  prepareStartupProfile() {",
      '    return { kind: "unsupported", reason: "This fixture requires explicit startup state." };',
      "  },",
      "  buildInitialStartupProfile() {",
      '    return { kind: "package-config", packageConfig: { profile: "initial" } };',
      "  },",
      "  reconcileStartupProfile(request) {",
      '    return { kind: "package-config", packageConfig: request.currentPackageConfig, changed: false };',
      "  },",
      "};",
      "",
      "export = startupAdapter;",
      "",
    ].join("\n"),
  );
  writeFile(
    packageRoot,
    "host/source/mcp-adapter.cts",
    [
      "// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.",
      "// SPDX-License-Identifier: Apache-2.0",
      "",
      'import type { HarnessMcpAdapterModule } from "@nvidia/nemoclaw-harness-contract";',
      "",
      "const mcpAdapter: HarnessMcpAdapterModule = {",
      "  buildMcpRegistrationPlan(request) {",
      "    return {",
      '      execution: { command: { kind: "argv", argv: ["future-mcp", "register", request.entry.server] }, timeoutSeconds: 15, success: { kind: "exit-zero" }, failureMessage: "MCP registration failed." },',
      '      verification: { kind: "inspection", failureMessage: "MCP verification failed." },',
      '      credentialConvergence: { kind: "none" },',
      "    };",
      "  },",
      "  buildMcpRemovalPlan(request) {",
      '    return { execution: { command: { kind: "argv", argv: ["future-mcp", "remove", request.entry.server] }, timeoutSeconds: 15, success: { kind: "exit-zero" }, failureMessage: "MCP removal failed." }, outcome: { kind: "removed" } };',
      "  },",
      "  buildMcpInspectionCommand(request) {",
      '    return { kind: "shell", script: `future-mcp inspect ${request.entry.server}`, shellTrust: "package-authored-code" };',
      "  },",
      "  describeMcpMutationCapability(request) {",
      '    return { kind: "command", command: { kind: "argv", argv: ["future-mcp", "probe", request.sandboxName] }, success: { kind: "exit-zero" }, timeoutSeconds: 10, failureMessage: "MCP is unavailable." };',
      "  },",
      '  describeMcpTeardownCapability() { return { kind: "not-required" }; },',
      '  describeMcpRuntimeIntentVerification() { return { kind: "not-required" }; },',
      "  buildMcpRuntimePlan(request) {",
      '    return { command: ["future-mcp", "runtime", ...request.command], environmentVariablesToRemove: ["FUTURE_MCP_TOKEN"] };',
      "  },",
      '  buildMcpSnapshotRestorePlan() { return { kind: "not-required" }; },',
      "};",
      "",
      "export = mcpAdapter;",
      "",
    ].join("\n"),
  );
  writeFile(
    packageRoot,
    "host/source/session-adapter.cts",
    [
      "// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.",
      "// SPDX-License-Identifier: Apache-2.0",
      "",
      'import type { HarnessSessionAdapterModule } from "@nvidia/nemoclaw-harness-contract";',
      "",
      "const sessionAdapter: HarnessSessionAdapterModule = {",
      "  buildSessionListPlan(request) {",
      '    return request.arguments.includes("--unsupported") ? { kind: "unsupported", reason: "Unsupported fixture option." } : { kind: "capture", command: ["future-terminal", "sessions", "list"] };',
      "  },",
      '  interpretSessionListOutput(request) { return { kind: "output", output: request.output }; },',
      "  buildSessionMutationPlan(request) {",
      '    return { kind: "capture", command: ["future-terminal", "sessions", request.operation, request.key] };',
      "  },",
      "  interpretSessionMutationOutput(request) {",
      '    if (request.request.operation === "delete") return { kind: "completed", operation: "delete", key: request.request.key, removedTranscript: !request.request.keepTranscript, entry: {} };',
      '    return { kind: "completed", operation: "reset", key: request.request.key, reason: request.request.reason, entry: {} };',
      "  },",
      "  buildSessionExportPlan(request) {",
      '    return { kind: "native-file", agent: request.agent ?? "future-terminal", format: "jsonl", selectedKeys: "all", remoteFile: request.stagingFiles.jsonl, command: ["future-terminal", "sessions", "export", request.stagingFiles.jsonl], allowEmpty: true };',
      "  },",
      "  interpretSessionExportIndex() {",
      '    return { kind: "selection", sessions: [], relativeFiles: [] };',
      "  },",
      "};",
      "",
      "export = sessionAdapter;",
      "",
    ].join("\n"),
  );
  writeFile(
    packageRoot,
    "host/source/restore-adapter.cts",
    [
      "// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.",
      "// SPDX-License-Identifier: Apache-2.0",
      "",
      'import type { HarnessConfigRestoreModule } from "@nvidia/nemoclaw-harness-contract";',
      "",
      "const restoreAdapter: HarnessConfigRestoreModule = {",
      "  mergeConfigState(request) {",
      "    const backup = JSON.parse(request.backupContent) as Record<string, unknown>;",
      "    const current = request.currentContent === null ? {} : JSON.parse(request.currentContent) as Record<string, unknown>;",
      '    return { kind: "merged", content: `${JSON.stringify({ ...backup, ...current })}\\n`, write: { kind: "atomic" } };',
      "  },",
      "};",
      "",
      "export = restoreAdapter;",
      "",
    ].join("\n"),
  );
  writeFile(
    packageRoot,
    "tests/authoring-only.test.ts",
    'throw new Error("This authoring test must never ship.");\n',
  );
}

test("an independent package consumes the packed typed contract with normal npm semantics", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-external-contract-"));
  const archiveRoot = path.join(fixtureRoot, "archives");
  const packageRoot = path.join(fixtureRoot, "nemoclaw-future-terminal");
  const artifactRoot = path.join(fixtureRoot, "dist", "future-terminal");
  fs.mkdirSync(archiveRoot);
  fs.mkdirSync(packageRoot);

  try {
    const contractArchive = packLocalPackage(CONTRACT_ROOT, archiveRoot, true);
    const typescriptArchive = packLocalPackage(
      path.join(REPOSITORY_ROOT, "node_modules/typescript"),
      archiveRoot,
    );
    const yamlArchive = packLocalPackage(
      path.join(REPOSITORY_ROOT, "node_modules/yaml"),
      archiveRoot,
    );
    createExternalPackage(packageRoot, [contractArchive, typescriptArchive, yamlArchive]);

    const offlineEnvironment = {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_offline: "true",
      npm_config_update_notifier: "false",
    };
    runCommand(
      "npm",
      ["install", "--offline", "--no-audit", "--no-fund"],
      packageRoot,
      offlineEnvironment,
    );

    const installedContract = path.join(
      packageRoot,
      "node_modules/@nvidia/nemoclaw-harness-contract",
    );
    assert.equal(fs.lstatSync(installedContract).isSymbolicLink(), false);
    assert.equal(
      fs.realpathSync(installedContract).startsWith(`${fs.realpathSync(fixtureRoot)}${path.sep}`),
      true,
    );
    assert.equal(
      fs.realpathSync(installedContract).startsWith(`${REPOSITORY_ROOT}${path.sep}`),
      false,
    );
    assert.equal(fs.existsSync(path.join(installedContract, "build-adapters.d.mts")), true);
    assert.equal(fs.existsSync(path.join(installedContract, "build-package.d.mts")), true);
    assert.equal(fs.existsSync(path.join(installedContract, "runtime/gateway-runtime.py")), true);
    assert.equal(fs.existsSync(path.join(installedContract, "runtime/messaging-build.mts")), true);
    assert.equal(
      fs.existsSync(path.join(installedContract, "dist/src/manifest-validator.js")),
      true,
    );

    runCommand("npm", ["run", "build:adapters"], packageRoot, offlineEnvironment);
    const runtimeMaterializer = path.join(
      packageRoot,
      "node_modules/.bin/nemoclaw-materialize-runtime",
    );
    runCommand(
      runtimeMaterializer,
      ["managed-gateway", "shared-runtime/managed-gateway.py"],
      packageRoot,
      offlineEnvironment,
    );
    runCommand(
      runtimeMaterializer,
      ["messaging-build", "shared-runtime/messaging-build.mts"],
      packageRoot,
      offlineEnvironment,
    );
    assert.equal(fs.existsSync(path.join(packageRoot, "shared-runtime/managed-gateway.py")), true);
    assert.equal(fs.existsSync(path.join(packageRoot, "shared-runtime/messaging-build.mts")), true);
    fs.rmSync(path.join(packageRoot, "shared-runtime"), { force: true, recursive: true });
    runCommand("npm", ["run", "check:adapters"], packageRoot, offlineEnvironment);
    runCommand("node", ["contract-check.cjs"], packageRoot, offlineEnvironment);
    runCommand("npm", ["run", "test:fabric"], packageRoot, offlineEnvironment);
    runCommand(
      "node",
      [
        "--input-type=module",
        "--eval",
        'import("@nvidia/nemoclaw-harness-contract/build-adapters").then(({ assertHarnessAdapterArtifactsCurrent }) => assertHarnessAdapterArtifactsCurrent(process.cwd()))',
      ],
      packageRoot,
      offlineEnvironment,
    );
    const conformance = runCommand(
      "npm",
      ["run", "--silent", "check:package"],
      packageRoot,
      offlineEnvironment,
    );
    const report = JSON.parse(conformance.stdout) as {
      readonly harnessId?: unknown;
      readonly packedFiles?: unknown;
    };
    assert.equal(report.harnessId, "future-terminal");
    assert.deepEqual(report.packedFiles, EXPECTED_PUBLISHED_FILES);

    runCommand("npm", ["run", "--silent", "build:package"], packageRoot, offlineEnvironment);
    assert.deepEqual(listFiles(artifactRoot), EXPECTED_ARTIFACT_FILES);
    const turn = runCommand(
      "node",
      ["fabric/turn.cjs"],
      artifactRoot,
      offlineEnvironment,
      "hello from the external package\n",
    );
    assert.deepEqual(JSON.parse(turn.stdout), {
      harness: "example.future-terminal",
      status: "completed",
      output: "future:hello from the external package",
    });
    for (const authoringPath of [
      "authoring-check.mts",
      "contract-check.cjs",
      "fabric-check.cjs",
      "host/source",
      "tests",
      "node_modules",
      "package-lock.json",
      "tsconfig.adapters.json",
    ]) {
      assert.equal(fs.existsSync(path.join(artifactRoot, authoringPath)), false);
    }
  } finally {
    makeDirectoriesWritable(artifactRoot);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
