// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testTimeoutOptions } from "../../../../test/helpers/timeouts";

const SCRIPT = path.join(import.meta.dirname, "../..", "checks", "update-agent.sh");
const HERMES_BASE_DOCKERFILE = path.join(import.meta.dirname, "../..", "Dockerfile.base");
const HERMES_MANIFEST = path.join(import.meta.dirname, "../..", "manifest.yaml");
const TARGET_TAG = "v2026.7.20";

const CURRENT_INSTALLED_BASE = [
  "# Calver tag v2026.6.5 = Hermes Agent v0.16.0.",
  "ARG HERMES_VERSION=v2026.6.5",
  "ARG HERMES_SEMVER=0.16.0",
  "ARG HERMES_TARBALL_SHA256=oldsha",
  "ARG HERMES_NPM_INTEGRITY=sha512-old",
  "",
].join("\n");

const CURRENT_INSTALLED_DOCKERFILE = [
  "COPY packages/nemoclaw-hermes/runtime/env-boundary.py /usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py",
  "COPY packages/nemoclaw-hermes/runtime/dashboard-config.py /usr/local/lib/nemoclaw/seed-hermes-dashboard-config.py",
  "COPY packages/nemoclaw-hermes/runtime/mcp-digest.py /usr/local/lib/nemoclaw/build-hermes-mcp-digest.py",
  'RUN mcp_digest="$(/opt/hermes/.venv/bin/python -I /usr/local/lib/nemoclaw/build-hermes-mcp-digest.py --guard /usr/local/lib/nemoclaw/hermes-runtime-config-guard.py --config /sandbox/.hermes/config.yaml)"',
  "COPY packages/nemoclaw-hermes/runtime/mcp-transaction.py /usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py",
  "COPY src/lib/actions/sandbox/openshell-child-visible-credentials.v0.0.106.json /usr/local/lib/nemoclaw/openshell-child-visible-credentials.v0.0.106.json",
  "RUN HERMES_HOME=/sandbox/.hermes /usr/local/bin/hermes doctor --fix \\",
  "    && node --experimental-strip-types /opt/nemoclaw-hermes-config/config/generate-config.ts",
  "RUN mkdir -p /sandbox/.hermes/profiles/dashboard-home",
  "",
].join("\n");

function writeInstalledHermesCopy(baseDockerfile: string, baseText = CURRENT_INSTALLED_BASE) {
  fs.mkdirSync(path.dirname(baseDockerfile), { recursive: true });
  fs.writeFileSync(baseDockerfile, baseText);
  fs.writeFileSync(
    path.join(path.dirname(baseDockerfile), "Dockerfile"),
    CURRENT_INSTALLED_DOCKERFILE,
  );
}

function writeExecutable(file: string, body: string) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

type HermesInventoryState = "absent" | "active" | "different" | "damaged" | "malformed";

function writeHarnessInventoryCli(directory: string, state: HermesInventoryState): string {
  const cliPath = path.join(directory, "nemoclaw-inventory");
  fs.mkdirSync(directory, { recursive: true });
  if (state === "malformed") {
    writeExecutable(cliPath, "#!/usr/bin/env bash\nprintf 'not-json\\n'\n");
    return cliPath;
  }
  const installed =
    state === "absent"
      ? []
      : [
          {
            id: "hermes",
            displayName: "Hermes Agent",
            health: state === "damaged" ? "damaged" : "healthy",
            identity:
              state === "damaged"
                ? null
                : {
                    kind: "agent-runtime",
                    id: "hermes",
                    packageVersion: "0.1.0",
                    contentDigest: "a".repeat(64),
                  },
          },
        ];
  const available = [
    {
      displayName: "Hermes Agent",
      identity: {
        kind: "agent-runtime",
        id: "hermes",
        packageVersion: "0.1.0",
        contentDigest: "b".repeat(64),
      },
      installationState:
        state === "active" ? "active" : state === "different" ? "different" : "not-installed",
    },
  ];
  const inventory = JSON.stringify({ schemaVersion: 1, installed, available });
  writeExecutable(
    cliPath,
    `#!/usr/bin/env bash\n[[ "$*" == "harness list --json" ]] || exit 64\nprintf '%s\\n' ${JSON.stringify(inventory)}\n`,
  );
  return cliPath;
}

describe("packages/nemoclaw-hermes/checks/update-agent.sh", testTimeoutOptions(30_000), () => {
  it("pins rebuild overrides to the accepted full image-ID local tag family", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-update-rebuild-"));
    const repo = path.join(tmp, "repo");
    const script = path.join(repo, "packages", "nemoclaw-hermes", "checks", "update-agent.sh");
    const fakeBin = path.join(tmp, "bin");
    const dockerLog = path.join(tmp, "docker.log");
    const nemohermesLog = path.join(tmp, "nemohermes.log");
    const imageId = `sha256:${"a".repeat(64)}`;
    const pinnedRef = `nemoclaw-hermes-sandbox-base-local:image-${"a".repeat(64)}`;
    const baseRef = "nemoclaw-hermes-base-local:test";
    const curlLog = path.join(tmp, "curl-argv.log");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.mkdirSync(path.join(repo, "packages", "nemoclaw-hermes"), { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    const inventoryCli = writeHarnessInventoryCli(fakeBin, "absent");
    fs.copyFileSync(SCRIPT, script);
    fs.chmodSync(script, 0o755);
    fs.copyFileSync(
      HERMES_BASE_DOCKERFILE,
      path.join(repo, "packages", "nemoclaw-hermes", "Dockerfile.base"),
    );
    fs.copyFileSync(
      HERMES_MANIFEST,
      path.join(repo, "packages", "nemoclaw-hermes", "manifest.yaml"),
    );
    writeExecutable(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_CURL_LOG"
output=""
previous=""
for arg in "$@"; do
  case "$previous" in
    -o) output="$arg" ;;
  esac
  previous="$arg"
done
printf 'fake archive' > "$output"
`,
    );
    writeExecutable(
      path.join(fakeBin, "tar"),
      "#!/usr/bin/env bash\nprintf 'version = \"0.19.0\"\\n'\n",
    );
    writeExecutable(path.join(fakeBin, "npm"), "#!/usr/bin/env bash\nprintf 'sha512-test\\n'\n");
    writeExecutable(
      path.join(fakeBin, "docker"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "\${1:-}" in
  image) printf '%s\\n' ${JSON.stringify(imageId)} ;;
esac
`,
    );
    writeExecutable(
      path.join(fakeBin, "nemohermes"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s|%s\\n' "\${NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF:-}" "$*" >> "$FAKE_NEMOHERMES_LOG"
if [[ "$*" == "hermes exec -- hermes --version" ]]; then
  printf '0.19.0\\n'
fi
`,
    );

    try {
      const run = spawnSync("bash", [script, "--tag", TARGET_TAG, "--rebuild"], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          HOME: path.join(tmp, "home"),
          HERMES_BASE_REF: baseRef,
          FAKE_DOCKER_LOG: dockerLog,
          FAKE_NEMOHERMES_LOG: nemohermesLog,
          FAKE_CURL_LOG: curlLog,
          NEMOCLAW_SOURCE_ROOT: undefined,
          NEMOCLAW_CLI: inventoryCli,
        },
        timeout: 10_000,
      });

      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(fs.readFileSync(dockerLog, "utf8")).toContain(`tag ${baseRef} ${pinnedRef}`);
      expect(fs.readFileSync(nemohermesLog, "utf8")).toContain(`${pinnedRef}|hermes rebuild`);
      expect(run.stdout).toContain("OK: sandbox reports Hermes Agent v0.19.0");
      // #9979: every archive fetch must reject protocol-downgrade redirects.
      const curlArgv = fs.readFileSync(curlLog, "utf8").trim();
      const curlCalls = curlArgv.split("\n").filter((line) => line.length > 0);
      expect(curlCalls.length).toBeGreaterThan(0);
      expect(
        curlCalls.every(
          (call) => call.includes("--proto =https") && call.includes("--proto-redir =https"),
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("pins the latest-release GitHub API lookup to HTTPS when --tag is omitted (#9979)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-update-latest-"));
    try {
      const repo = path.join(tmp, "repo");
      const script = path.join(repo, "packages", "nemoclaw-hermes", "checks", "update-agent.sh");
      const fakeBin = path.join(tmp, "bin");
      const curlLog = path.join(tmp, "curl-argv.log");
      fs.mkdirSync(path.dirname(script), { recursive: true });
      fs.mkdirSync(path.join(repo, "packages", "nemoclaw-hermes"), { recursive: true });
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.copyFileSync(SCRIPT, script);
      fs.chmodSync(script, 0o755);
      fs.copyFileSync(
        HERMES_BASE_DOCKERFILE,
        path.join(repo, "packages", "nemoclaw-hermes", "Dockerfile.base"),
      );
      fs.copyFileSync(
        HERMES_MANIFEST,
        path.join(repo, "packages", "nemoclaw-hermes", "manifest.yaml"),
      );
      writeExecutable(
        path.join(fakeBin, "curl"),
        `#!/usr/bin/env bash
set -euo pipefail
# Redact any bearer token before it ever touches disk, so a real
# credential can never end up in a test log even transiently.
printf '%s\\n' "$*" | sed -E 's/(Authorization: ?Bearer )[^ ]+/\\1[REDACTED]/' >> "$FAKE_CURL_LOG"
if [[ "$*" == *api.github.com* ]]; then
  printf '{"tag_name":"v2026.6.5"}'
fi
`,
      );

      const run = spawnSync("bash", [script, "--check"], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          HOME: path.join(tmp, "home"),
          FAKE_CURL_LOG: curlLog,
          // Exercise the authenticated path without inheriting or logging a real token.
          GITHUB_TOKEN: "test-not-a-real-token",
          NEMOCLAW_SOURCE_ROOT: undefined,
        },
        timeout: 10_000,
      });

      // --check returns 0 for current pins and 1 for stale pins.
      expect([0, 1], `${run.stdout}\n${run.stderr}`).toContain(run.status);
      expect(run.stdout).toMatch(/^(OK|STALE): Dockerfile\.base pins Hermes/m);

      const curlCalls = fs
        .readFileSync(curlLog, "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
      expect(curlCalls.length).toBeGreaterThan(0);
      expect(
        curlCalls.every(
          (call) => call.includes("--proto =https") && call.includes("--proto-redir =https"),
        ),
      ).toBe(true);
      expect(curlCalls.some((call) => call.includes("[REDACTED]"))).toBe(true);
      expect(curlCalls.join("\n")).not.toContain("test-not-a-real-token");
      expect(curlCalls.join("\n")).toContain(
        "api.github.com/repos/NousResearch/hermes-agent/releases/latest",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps installed-copy scanning opt-in unless rebuild needs it", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-update-home-"));
    const inventoryCli = writeHarnessInventoryCli(path.join(tmpHome, "bin"), "absent");
    const installedDockerfile = path.join(
      tmpHome,
      ".nemoclaw",
      "source",
      "packages",
      "nemoclaw-hermes",
      "Dockerfile.base",
    );
    writeInstalledHermesCopy(installedDockerfile);

    const run = (...args: string[]) =>
      spawnSync("bash", [SCRIPT, "--tag", TARGET_TAG, "--check", ...args], {
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpHome,
          NEMOCLAW_SOURCE_ROOT: undefined,
          NEMOCLAW_CLI: inventoryCli,
        },
        timeout: 5000,
      });

    try {
      const defaultCheck = run();
      expect(defaultCheck.status).toBe(0);
      expect(defaultCheck.stdout).toContain("Installed-copy scan skipped");

      const explicitScan = run("--update-installed-copies");
      expect(explicitScan.status).toBe(1);
      expect(explicitScan.stdout).toContain("STALE: installed copy");
      expect(explicitScan.stdout).toContain(installedDockerfile);

      const rebuildCheck = run("--rebuild");
      expect(rebuildCheck.status).toBe(1);
      expect(rebuildCheck.stdout).toContain("STALE: installed copy");
      expect(rebuildCheck.stdout).toContain(installedDockerfile);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("refuses unsafe installed-copy rewrite candidates", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-update-unsafe-"));
    const inventoryCli = writeHarnessInventoryCli(path.join(tmpHome, "bin"), "absent");
    const sourceRoot = path.join(tmpHome, "source-root");
    const symlinkRoot = path.join(tmpHome, "symlink-root");
    const symlinkTarget = path.join(tmpHome, "target-root");
    const hardlinkedDockerfile = path.join(
      sourceRoot,
      "packages",
      "nemoclaw-hermes",
      "Dockerfile.base",
    );
    const symlinkDockerfile = path.join(sourceRoot, "aliased", "Dockerfile.base");
    fs.mkdirSync(path.dirname(hardlinkedDockerfile), { recursive: true });
    fs.mkdirSync(path.dirname(symlinkDockerfile), { recursive: true });
    fs.mkdirSync(symlinkTarget, { recursive: true });
    fs.writeFileSync(hardlinkedDockerfile, "ARG HERMES_VERSION=v2026.6.5\n");
    fs.linkSync(hardlinkedDockerfile, path.join(sourceRoot, "Dockerfile.hardlink"));
    fs.symlinkSync(hardlinkedDockerfile, symlinkDockerfile);
    fs.symlinkSync(symlinkTarget, symlinkRoot);

    const run = (root: string) =>
      spawnSync("bash", [SCRIPT, "--tag", TARGET_TAG, "--check", "--update-installed-copies"], {
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpHome,
          NEMOCLAW_SOURCE_ROOT: root,
          NEMOCLAW_CLI: inventoryCli,
        },
        timeout: 5000,
      });

    try {
      const unsafeCandidates = run(sourceRoot);
      expect(unsafeCandidates.status).toBe(0);
      expect(unsafeCandidates.stdout).not.toContain("STALE: installed copy");
      expect(unsafeCandidates.stderr).toContain("SKIP unsafe installed copy");
      expect(fs.readFileSync(hardlinkedDockerfile, "utf-8")).toContain("v2026.6.5");

      const unsafeRoot = run(symlinkRoot);
      expect(unsafeRoot.status).toBe(0);
      expect(unsafeRoot.stderr).toContain("SKIP unsafe installed-copy root");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("uses the generic harness inventory without inspecting package-store files", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-update-package-"));
    const packageDockerfile = path.join(
      tmpHome,
      ".nemoclaw",
      "harnesses",
      "objects",
      "sha256",
      "a".repeat(64),
      "packages",
      "nemoclaw-hermes",
      "Dockerfile.base",
    );
    writeInstalledHermesCopy(packageDockerfile);

    const run = (state: HermesInventoryState) =>
      spawnSync("bash", [SCRIPT, "--tag", TARGET_TAG, "--check", "--update-installed-copies"], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: tmpHome,
          NEMOCLAW_CLI: writeHarnessInventoryCli(path.join(tmpHome, "bin"), state),
          NEMOCLAW_SOURCE_ROOT: undefined,
        },
        timeout: 10_000,
      });

    try {
      const active = run("active");
      expect(active.status, `${active.stdout}\n${active.stderr}`).toBe(0);
      expect(active.stdout).toContain(
        "OK: installed Hermes harness package matches this NemoClaw build",
      );
      expect(active.stdout).not.toContain("installed copy");

      const different = run("different");
      expect(different.status).toBe(1);
      expect(different.stderr).toContain(
        "STALE: installed Hermes harness package differs from this NemoClaw build",
      );
      expect(different.stderr).toContain("nemoclaw harness install hermes");

      const damaged = run("damaged");
      expect(damaged.status).toBe(1);
      expect(damaged.stderr).toContain(
        "INVALID: installed Hermes harness package failed integrity validation",
      );
      expect(fs.readFileSync(packageDockerfile, "utf8")).toBe(CURRENT_INSTALLED_BASE);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("fails closed when the generic harness inventory is malformed", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-update-inventory-"));
    try {
      const run = spawnSync(
        "bash",
        [SCRIPT, "--tag", TARGET_TAG, "--check", "--update-installed-copies"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: tmpHome,
            NEMOCLAW_CLI: writeHarnessInventoryCli(path.join(tmpHome, "bin"), "malformed"),
            NEMOCLAW_SOURCE_ROOT: undefined,
          },
          timeout: 10_000,
        },
      );

      expect(run.status).toBe(1);
      expect(run.stderr).toContain("NemoClaw returned an invalid harness inventory");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("refuses legacy installed copies missing HERMES_SEMVER/HERMES_NPM_INTEGRITY and current integration markers without mutating them", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-update-legacy-"));
    const inventoryCli = writeHarnessInventoryCli(path.join(tmpHome, "bin"), "absent");
    const installedDockerfile = path.join(
      tmpHome,
      ".nemoclaw",
      "source",
      "packages",
      "nemoclaw-hermes",
      "Dockerfile.base",
    );
    const legacyBase = "ARG HERMES_VERSION=v2026.6.5\nARG HERMES_TARBALL_SHA256=oldsha\n";
    const legacyDockerfile = "# legacy Hermes Dockerfile without v0.17 integration markers\n";
    fs.mkdirSync(path.dirname(installedDockerfile), { recursive: true });
    fs.writeFileSync(installedDockerfile, legacyBase);
    fs.writeFileSync(path.join(path.dirname(installedDockerfile), "Dockerfile"), legacyDockerfile);

    const run = spawnSync(
      "bash",
      [SCRIPT, "--tag", TARGET_TAG, "--check", "--update-installed-copies"],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpHome,
          NEMOCLAW_CLI: inventoryCli,
          NEMOCLAW_SOURCE_ROOT: undefined,
        },
        timeout: 5000,
      },
    );

    try {
      expect(run.status).toBe(1);
      expect(run.stdout).toContain("INVALID: installed copy");
      expect(run.stdout).toContain("legacy Hermes source schema");
      expect(run.stdout).toContain("refresh or reinstall");
      expect(fs.readFileSync(installedDockerfile, "utf-8")).toBe(legacyBase);
      expect(
        fs.readFileSync(path.join(path.dirname(installedDockerfile), "Dockerfile"), "utf-8"),
      ).toBe(legacyDockerfile);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("refuses installed copies that predate the transactional MCP boundary", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-update-pre-mcp-"));
    const inventoryCli = writeHarnessInventoryCli(path.join(tmpHome, "bin"), "absent");
    const installedDockerfile = path.join(
      tmpHome,
      ".nemoclaw",
      "source",
      "packages",
      "nemoclaw-hermes",
      "Dockerfile.base",
    );
    const installedAgentDockerfile = path.join(path.dirname(installedDockerfile), "Dockerfile");
    const preMcpDockerfile = CURRENT_INSTALLED_DOCKERFILE.replace(
      /^(?:COPY (?:packages\/nemoclaw-hermes\/runtime\/(?:mcp-digest|mcp-transaction)\.py|src\/lib\/actions\/sandbox\/openshell-child-visible-credentials\.v0\.0\.106\.json) .*|RUN mcp_digest=.*build-hermes-mcp-digest\.py.*)\n/gm,
      "",
    );
    fs.mkdirSync(path.dirname(installedDockerfile), { recursive: true });
    fs.writeFileSync(installedDockerfile, CURRENT_INSTALLED_BASE);
    fs.writeFileSync(installedAgentDockerfile, preMcpDockerfile);

    const run = spawnSync(
      "bash",
      [SCRIPT, "--tag", TARGET_TAG, "--check", "--update-installed-copies"],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpHome,
          NEMOCLAW_CLI: inventoryCli,
          NEMOCLAW_SOURCE_ROOT: undefined,
        },
        timeout: 5000,
      },
    );

    try {
      expect(run.status).toBe(1);
      expect(run.stdout).toContain("INVALID: installed copy");
      expect(run.stdout).toContain("marker hermes-mcp-config-transaction.py");
      expect(run.stdout).toContain("marker openshell-child-visible-credentials.v0.0.106.json");
      expect(run.stdout).toContain("marker COPY packages/nemoclaw-hermes/runtime/mcp-digest.py");
      expect(run.stdout).toContain("marker /opt/hermes/.venv/bin/python -I");
      expect(fs.readFileSync(installedDockerfile, "utf-8")).toBe(CURRENT_INSTALLED_BASE);
      expect(fs.readFileSync(installedAgentDockerfile, "utf-8")).toBe(preMcpDockerfile);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("refuses installed copies with an independently pinned final workaround guard (#5254)", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-update-final-guard-"));
    const inventoryCli = writeHarnessInventoryCli(path.join(tmpHome, "bin"), "absent");
    const installedDockerfile = path.join(
      tmpHome,
      ".nemoclaw",
      "source",
      "packages",
      "nemoclaw-hermes",
      "Dockerfile.base",
    );
    const installedAgentDockerfile = path.join(path.dirname(installedDockerfile), "Dockerfile");
    const staleGuardDockerfile = [
      CURRENT_INSTALLED_DOCKERFILE,
      "ARG HERMES_SEMVER=0.17.0",
      'RUN if [ "$HERMES_SEMVER" != "0.17.0" ]; then exit 1; fi',
      "",
    ].join("\n");
    fs.mkdirSync(path.dirname(installedDockerfile), { recursive: true });
    fs.writeFileSync(installedDockerfile, CURRENT_INSTALLED_BASE);
    fs.writeFileSync(installedAgentDockerfile, staleGuardDockerfile);

    const run = spawnSync(
      "bash",
      [SCRIPT, "--tag", TARGET_TAG, "--check", "--update-installed-copies"],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpHome,
          NEMOCLAW_CLI: inventoryCli,
          NEMOCLAW_SOURCE_ROOT: undefined,
        },
        timeout: 5000,
      },
    );

    try {
      expect(run.status).toBe(1);
      expect(run.stdout).toContain("INVALID: installed copy");
      expect(run.stdout).toContain("final Dockerfile #5254 guard");
      expect(run.stdout).toContain("installed hermes --version");
      expect(fs.readFileSync(installedDockerfile, "utf-8")).toBe(CURRENT_INSTALLED_BASE);
      expect(fs.readFileSync(installedAgentDockerfile, "utf-8")).toBe(staleGuardDockerfile);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
