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
const EXPECTED_PUBLISHED_FILES = Object.freeze([
  "Dockerfile",
  "Dockerfile.base",
  "host/config-adapter.cts",
  "host/messaging-adapter.cts",
  "manifest.yaml",
  "package.json",
  "policy-additions.yaml",
  "start.sh",
]);
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
): CommandResult {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    env: environment,
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    timeout: 120_000,
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
          "build:package": "nemoclaw-build-package --json . ../runtime-artifact",
        },
        files: [
          "Dockerfile.base",
          "Dockerfile",
          "manifest.yaml",
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
        include: ["host/source/**/*.cts"],
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
      "  kind: terminal",
      "  prompt_transport: stdin",
      "mcp:",
      "  support: disabled",
      "messaging:",
      "  support: disabled",
      "",
    ].join("\n"),
  );
  writeFile(packageRoot, "policy-additions.yaml", "network_policies: []\n");
  writeFile(packageRoot, "start.sh", "#!/bin/sh\nexec sleep infinity\n", 0o755);
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
      '      kind: "disabled",',
      '      packageId: "future-terminal",',
      '      reason: "This terminal has no messaging bridge.",',
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
    "tests/authoring-only.test.ts",
    'throw new Error("This authoring test must never ship.");\n',
  );
}

test("an independent package consumes the packed typed contract with normal npm semantics", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-external-contract-"));
  const archiveRoot = path.join(fixtureRoot, "archives");
  const packageRoot = path.join(fixtureRoot, "nemoclaw-future-terminal");
  const artifactRoot = path.join(fixtureRoot, "runtime-artifact");
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

    runCommand("npm", ["run", "build:adapters"], packageRoot, offlineEnvironment);
    runCommand("npm", ["run", "check:adapters"], packageRoot, offlineEnvironment);
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
    for (const authoringPath of [
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
