// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const CHECK_DOCS = path.join(REPO_ROOT, "test", "e2e", "e2e-cloud-experimental", "check-docs.sh");

type CliParityFixture = {
  binDir: string;
  nodeInvocationLog: string;
  nodeShim: string;
  root: string;
};

type HarnessPackageIdentity = {
  kind: string;
  id: string;
  packageVersion: string;
  contractVersion: number;
  contentDigest: string;
};

type HarnessPackageValidationReport = {
  schemaVersion: number;
  valid: boolean;
  identity: HarnessPackageIdentity;
  displayName: string;
  manifest: string;
  runtimeKind: string;
  entryCount: number;
  totalBytes: number;
};

function writeArtifactFile(
  artifactDirectory: string,
  relativePath: string,
  contents: string,
): void {
  const target = path.join(artifactDirectory, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, contents, { mode: 0o600 });
  fs.chmodSync(target, 0o600);
}

function createBuiltHarnessArtifact(fixtureRoot: string): string {
  const artifactDirectory = path.join(fixtureRoot, "built-harness");
  fs.mkdirSync(artifactDirectory, { mode: 0o700 });
  fs.chmodSync(artifactDirectory, 0o700);
  writeArtifactFile(
    artifactDirectory,
    "nemoclaw-package.json",
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "agent-runtime",
      id: "example-runtime",
      displayName: "Example Runtime",
      packageVersion: "1.2.3",
      contractVersion: 1,
      manifest: "agents/example-runtime/manifest.yaml",
    })}\n`,
  );
  writeArtifactFile(
    artifactDirectory,
    "agents/example-runtime/manifest.yaml",
    "name: example-runtime\nruntime:\n  kind: terminal\n  headless_command: example-runtime run\n",
  );
  writeArtifactFile(artifactDirectory, "runtime/payload.txt", "first payload\n");
  return artifactDirectory;
}

function artifactSnapshot(artifactDirectory: string): string[] {
  const snapshot: string[] = [];
  const visit = (directory: string, relativeDirectory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolutePath = path.join(directory, name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const stats = fs.lstatSync(absolutePath);
      snapshot.push(
        stats.isDirectory()
          ? `${relativePath}/:${String(stats.mode & 0o777)}`
          : `${relativePath}:${String(stats.mode & 0o777)}:${fs.readFileSync(absolutePath).toString("base64")}`,
      );
      stats.isDirectory() ? visit(absolutePath, relativePath) : undefined;
    }
  };
  visit(artifactDirectory, "");
  return snapshot;
}

function createCliParityFixture(): CliParityFixture {
  const fixtureParent = path.join(REPO_ROOT, "node_modules/.cache/nemoclaw-docs-cli-parity");
  fs.mkdirSync(fixtureParent, { recursive: true, mode: 0o700 });
  fs.chmodSync(fixtureParent, 0o700);
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(fixtureParent), "fixture-"));
  fs.chmodSync(root, 0o700);
  const binDir = path.join(root, "bin");
  const shim = path.join(binDir, "nemoclaw");
  const nodeShim = path.join(binDir, "node");
  const nodeInvocationLog = path.join(root, "node-invocations.log");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    shim,
    `#!/usr/bin/env bash
exec "$NEMOCLAW_TEST_NODE" "$NEMOCLAW_TEST_CLI_ENTRYPOINT" "$@"
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    nodeShim,
    `#!/usr/bin/env bash
set -o pipefail

_entrypoint="$1"
shift

case "\${1:-}" in
  --dump-commands) _invocation="dump-commands" ;;
  --dump-command-flags) _invocation="dump-command-flags" ;;
  *) _invocation="custom-help" ;;
esac
printf '%s\\n' "$_invocation" >>"$NEMOCLAW_TEST_INVOCATION_LOG"

if [[ "\${1:-}" == "--dump-command-flags" && "\${NEMOCLAW_TEST_EMPTY_AGENT_METADATA:-0}" == "1" ]]; then
  "$NEMOCLAW_TEST_NODE" "$_entrypoint" "$@" | LC_ALL=C awk -F '\\t' 'BEGIN { OFS = "\\t" } $1 == "nemoclaw <name> agent" { $3 = ""; print; next } { print }'
  exit $?
fi

if [[ "\${NEMOCLAW_TEST_ADD_AGENT_HELP_FLAG:-0}" == "1" && "$_invocation" == "custom-help" ]]; then
  if [[ "$#" -eq 3 && "$1" == "placeholder-sandbox" && "$2" == "agent" && "$3" == "--help" ]]; then
    printf '  Usage: nemoclaw <name> agent --synthetic-undocumented\\n'
  fi
  exit 0
fi

exec "$NEMOCLAW_TEST_NODE" "$_entrypoint" "$@"
`,
    { mode: 0o755 },
  );
  return { binDir, nodeInvocationLog, nodeShim, root };
}

function runInstalledCli(fixture: CliParityFixture, args: readonly string[]) {
  return spawnSync(path.join(fixture.binDir, "nemoclaw"), args, {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: fixture.root,
      NEMOCLAW_TEST_CLI_ENTRYPOINT: CLI_ENTRYPOINT,
      NEMOCLAW_TEST_NODE: process.execPath,
      PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    killSignal: "SIGKILL",
    timeout: 120_000,
  });
}

function runCliParity(fixture: CliParityFixture, env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", [CHECK_DOCS, "--only-cli"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: {
      ...process.env,
      CHECK_DOC_LINKS_REMOTE: "0",
      HOME: fixture.root,
      NEMOCLAW_TEST_CLI_ENTRYPOINT: CLI_ENTRYPOINT,
      NEMOCLAW_TEST_INVOCATION_LOG: fixture.nodeInvocationLog,
      NEMOCLAW_TEST_NODE: process.execPath,
      NODE: fixture.nodeShim,
      PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      ...env,
    },
    killSignal: "SIGKILL",
    timeout: 120_000,
  });
}

function readCliInvocations(fixture: CliParityFixture): string[] {
  return fs.readFileSync(fixture.nodeInvocationLog, "utf-8").trim().split("\n");
}

describe("public compiled CLI contracts", () => {
  it("prints the public NemoClaw version prefix (#7616)", () => {
    const result = spawnSync(process.execPath, [CLI_ENTRYPOINT, "--version"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: 30_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^nemoclaw v/);
  });

  it(
    "installs one reviewed harness and lists its receipt-bound identity",
    { timeout: 30_000 },
    () => {
      const fixture = createCliParityFixture();

      try {
        const emptyList = runInstalledCli(fixture, ["harness", "list", "--json"]);
        expect(emptyList.error).toBeUndefined();
        expect(emptyList.signal).toBeNull();
        expect(emptyList.status, emptyList.stderr).toBe(0);

        const emptyInventory = JSON.parse(emptyList.stdout) as {
          schemaVersion: number;
          installed: unknown[];
          available: Array<{
            displayName: string;
            identity: HarnessPackageIdentity;
            installationState: string;
          }>;
        };
        expect(emptyInventory.schemaVersion).toBe(1);
        expect(emptyInventory.installed).toEqual([]);
        const reviewedPackage = emptyInventory.available.find(
          ({ identity }) => identity.id === "openclaw",
        );
        expect(reviewedPackage).toBeDefined();
        const reviewedOpenClaw = reviewedPackage!;
        expect(reviewedOpenClaw.installationState).toBe("not-installed");

        const install = runInstalledCli(fixture, [
          "harness",
          "install",
          reviewedOpenClaw.identity.id,
        ]);
        expect(install.error).toBeUndefined();
        expect(install.signal).toBeNull();
        expect(install.status, install.stderr).toBe(0);
        expect(install.stdout).toContain("Installed harness package 'openclaw'");

        const installedList = runInstalledCli(fixture, ["harness", "list", "--json"]);
        expect(installedList.error).toBeUndefined();
        expect(installedList.signal).toBeNull();
        expect(installedList.status, installedList.stderr).toBe(0);
        const installedInventory = JSON.parse(installedList.stdout) as {
          installed: Array<{
            id: string;
            displayName: string;
            health: string;
            identity: HarnessPackageIdentity;
          }>;
          available: Array<{
            identity: HarnessPackageIdentity;
            installationState: string;
          }>;
        };
        expect(installedInventory.installed).toEqual([
          {
            id: reviewedOpenClaw.identity.id,
            displayName: reviewedOpenClaw.displayName,
            health: "healthy",
            identity: reviewedOpenClaw.identity,
          },
        ]);
        expect(
          installedInventory.available.find(
            ({ identity }) => identity.id === reviewedOpenClaw.identity.id,
          )?.installationState,
        ).toBe("active");

        const receiptPath = path.join(
          fixture.root,
          ".nemoclaw",
          "harnesses",
          "receipts",
          reviewedOpenClaw.identity.id,
          "sha256",
          `${reviewedOpenClaw.identity.contentDigest}.json`,
        );
        const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf-8")) as {
          identity: HarnessPackageIdentity;
        };
        expect(receipt.identity).toEqual(reviewedOpenClaw.identity);
        expect(installedInventory.installed[0]?.identity).toEqual(receipt.identity);
      } finally {
        fs.rmSync(fixture.root, { force: true, recursive: true });
      }
    },
  );

  it(
    "validates a changed built agent runtime without installing or executing it",
    { timeout: 30_000 },
    () => {
      const fixture = createCliParityFixture();
      const artifactDirectory = createBuiltHarnessArtifact(fixture.root);
      const before = artifactSnapshot(artifactDirectory);

      try {
        const first = runInstalledCli(fixture, [
          "harness",
          "validate",
          artifactDirectory,
          "--json",
        ]);
        expect(first.error).toBeUndefined();
        expect(first.signal).toBeNull();
        expect(first.status, first.stderr).toBe(0);
        const firstReport = JSON.parse(first.stdout) as HarnessPackageValidationReport;
        expect(firstReport).toMatchObject({
          schemaVersion: 1,
          valid: true,
          identity: {
            kind: "agent-runtime",
            id: "example-runtime",
            packageVersion: "1.2.3",
            contractVersion: 1,
            contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
          },
          displayName: "Example Runtime",
          manifest: "agents/example-runtime/manifest.yaml",
          runtimeKind: "terminal",
        });
        expect(first.stdout).not.toContain(artifactDirectory);
        expect(artifactSnapshot(artifactDirectory)).toEqual(before);
        expect(fs.existsSync(path.join(fixture.root, ".nemoclaw", "harnesses"))).toBe(false);

        writeArtifactFile(artifactDirectory, "runtime/payload.txt", "second payload\n");
        const changed = runInstalledCli(fixture, [
          "harness",
          "validate",
          artifactDirectory,
          "--json",
        ]);
        expect(changed.status, changed.stderr).toBe(0);
        const changedReport = JSON.parse(changed.stdout) as HarnessPackageValidationReport;
        expect(changedReport.identity.contentDigest).not.toBe(firstReport.identity.contentDigest);

        writeArtifactFile(
          artifactDirectory,
          "agents/example-runtime/manifest.yaml",
          "name: example-runtime\nruntime:\n  kind: terminal\n",
        );
        const malformed = runInstalledCli(fixture, ["harness", "validate", artifactDirectory]);
        expect(malformed.status).not.toBe(0);
        expect(malformed.stderr).toContain("must define interactive_command or headless_command");
        expect(fs.existsSync(path.join(fixture.root, ".nemoclaw", "harnesses"))).toBe(false);
      } finally {
        fs.rmSync(fixture.root, { force: true, recursive: true });
      }
    },
  );

  it(
    "keeps compiled CLI commands aligned with their documentation headings (#7616)",
    {
      timeout: 150_000,
    },
    () => {
      // `npm run test:package` builds the CLI before this project. Empty one
      // custom-help metadata row to prove its code-owned classification still
      // selects rendered help without returning to one start per command.
      const fixture = createCliParityFixture();

      try {
        const result = runCliParity(fixture, { NEMOCLAW_TEST_EMPTY_AGENT_METADATA: "1" });

        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.stdout).toContain("check-docs: running: [cli]");
        expect(result.stdout).toContain("command-level parity OK");
        expect(result.stdout).toContain("flag-level parity OK");
        const invocations = readCliInvocations(fixture);
        expect(invocations.filter((invocation) => invocation === "dump-commands")).toHaveLength(1);
        expect(
          invocations.filter((invocation) => invocation === "dump-command-flags"),
        ).toHaveLength(1);
        expect(invocations).toContain("custom-help");
        expect(invocations.length).toBeLessThanOrEqual(20);
      } finally {
        fs.rmSync(fixture.root, { force: true, recursive: true });
      }
    },
  );

  it(
    "rejects an undocumented flag from custom rendered help (#7616)",
    {
      timeout: 150_000,
    },
    () => {
      const fixture = createCliParityFixture();

      try {
        const result = runCliParity(fixture, { NEMOCLAW_TEST_ADD_AGENT_HELP_FLAG: "1" });

        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("flag --synthetic-undocumented");
        expect(result.stderr).toContain("not in 'nemoclaw <name> agent' section");
        expect(readCliInvocations(fixture)).toContain("custom-help");
      } finally {
        fs.rmSync(fixture.root, { force: true, recursive: true });
      }
    },
  );

  it(
    "validates every repository-local documentation link (#7616)",
    {
      timeout: 150_000,
    },
    () => {
      const result = spawnSync("bash", [CHECK_DOCS, "--only-links", "--local-only"], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        env: {
          ...process.env,
          CHECK_DOC_LINKS_REMOTE: "0",
        },
        killSignal: "SIGKILL",
        timeout: 120_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("check-docs: running: [links]");
      expect(result.stdout).toContain("remote: skipped (local paths only)");
      expect(result.stdout).toContain("phase 2/2: skipped");
    },
  );
});
