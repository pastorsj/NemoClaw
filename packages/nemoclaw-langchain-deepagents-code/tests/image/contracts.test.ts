// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAgent } from "../../../../src/lib/agent/defs.ts";
import { TOKEN_PREFIX_PATTERNS } from "../../../../src/lib/security/secret-patterns.ts";
import {
  ANALYTICS_DISABLE_ENV_NAMES,
  DCODE_CANONICAL_PATH,
  NO_PROXY_ENV_NAMES,
  PROXY_URL_ENV_NAMES,
  runStartScriptProxyProbe,
  TRACING_ENABLE_ENV_NAMES,
} from "../helpers/headless.ts";
import { makeWrapperFixture, readAgentFile, runWrapper } from "../helpers/image.ts";
import { dcodeStateDir, makeStartScriptFixture } from "../helpers/start-script.ts";
import { expectManagedBootstrapNativeImageContract } from "../../../../test/support/managed-bootstrap-image-contract.ts";
import { testTimeoutOptions } from "../helpers/timeouts.ts";

function containsTokenShapedSecret(value: string): boolean {
  return TOKEN_PREFIX_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    const matched = pattern.test(value);
    pattern.lastIndex = 0;
    return matched;
  });
}

const packageRoot = path.resolve(import.meta.dirname, "../..");
const repoRoot = path.resolve(packageRoot, "../..");

function sha256(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function lockedRequirementVersion(requirementsLock: string, distribution: string): string {
  const escapedDistribution = distribution.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = requirementsLock.match(
    new RegExp(`^${escapedDistribution}==([^\\s\\\\]+)\\s+\\\\$`, "m"),
  );
  expect(match, `${distribution} must be exactly pinned in requirements.lock`).not.toBeNull();
  return match?.[1] ?? "";
}

function pythonStringMap(source: string, constantName: string): Record<string, string> {
  const block = source.match(new RegExp(`${constantName}\\s*=\\s*\\{([\\s\\S]*?)\\n\\}`));
  expect(block, `${constantName} must be a literal Python dictionary`).not.toBeNull();
  return Object.fromEntries(
    [...(block?.[1] ?? "").matchAll(/^\s*"([^"]+)":\s*"([^"]+)",?\s*$/gm)].map(
      ([, distribution, version]) => [distribution, version],
    ),
  );
}

function expectVersionsMatchLock(requirementsLock: string, versions: Record<string, string>): void {
  expect(versions, "deepagents-code must be present in the version map").toHaveProperty(
    "deepagents-code",
  );
  expect(versions, "deepagents must be present in the version map").toHaveProperty("deepagents");
  for (const [distribution, version] of Object.entries(versions)) {
    expect(version, distribution).toBe(lockedRequirementVersion(requirementsLock, distribution));
  }
}

function expectEnvironmentValues(
  outputLines: readonly string[],
  envFileLines: readonly string[],
  names: readonly string[],
  value: string,
): void {
  for (const name of names) {
    expect(outputLines).toContain(`RUNTIME_${name}=${value}`);
    expect(outputLines).toContain(`SOURCED_${name}=${value}`);
    expect(envFileLines).toContain(`export ${name}=${value.replaceAll(",", "\\,")}`);
  }
}

function expectTextToOmitAll(text: string, omittedValues: readonly string[]): void {
  for (const omittedValue of omittedValues) expect(text).not.toContain(omittedValue);
}

const TARGETED_ADVISORY_VERSIONS = [
  ["aiohttp", "3.14.3"],
  ["cryptography", "50.0.0"],
  ["uv", "0.11.33"],
  ["langgraph-checkpoint-sqlite", "3.1.1"],
  ["mcp", "1.28.1"],
  ["pillow", "12.3.0"],
  ["pyasn1", "0.6.4"],
] as const;

describe("targeted dependency advisory review", () => {
  it.each(TARGETED_ADVISORY_VERSIONS)(
    "documents the reviewed %s %s pin",
    (distribution, version) => {
      const normalizedDistribution = distribution.replaceAll("-", "[-_]");
      const normalizedVersion = version.replaceAll(".", "\\.");
      expect(readAgentFile("compat/dependencies.md")).toMatch(
        new RegExp(
          `(?:^|[^A-Za-z0-9_-])${normalizedDistribution}\\s+${normalizedVersion}(?=[^0-9.]|$)`,
          "im",
        ),
      );
    },
  );
});

function writeMinimalWheel(directory: string): string {
  const wheelPath = path.join(directory, "nemoclaw_hash_contract-1.0-py3-none-any.whl");
  execFileSync(
    "python3",
    [
      "-c",
      `
import sys
import zipfile

wheel_path = sys.argv[1]
dist_info = "nemoclaw_hash_contract-1.0.dist-info"
with zipfile.ZipFile(wheel_path, "w") as wheel:
    wheel.writestr("nemoclaw_hash_contract/__init__.py", "")
    wheel.writestr(
        f"{dist_info}/METADATA",
        "Metadata-Version: 2.1\\nName: nemoclaw-hash-contract\\nVersion: 1.0\\n",
    )
    wheel.writestr(
        f"{dist_info}/WHEEL",
        "Wheel-Version: 1.0\\nGenerator: nemoclaw-test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n",
    )
    wheel.writestr(f"{dist_info}/RECORD", f"{dist_info}/RECORD,,\\n")
`,
      wheelPath,
    ],
    { stdio: "pipe" },
  );
  return wheelPath;
}

function baseImagePipInstallArgs(dockerfile: string, requirementsPath: string): string[] {
  const logicalDockerfile = dockerfile.replace(/\\\r?\n\s*/g, " ");
  const copiedLock = logicalDockerfile.match(
    /COPY\s+packages\/nemoclaw-langchain-deepagents-code\/runtime\/requirements\.lock\s+(\S+)/,
  );
  expect(copiedLock, "base image must copy the reviewed lockfile").not.toBeNull();
  const invocation = logicalDockerfile.match(/"\$VIRTUAL_ENV\/bin\/pip3" install\s+([^\n]+?)\s+&&/);
  expect(
    invocation,
    "base image must install the reviewed lockfile with the managed venv",
  ).not.toBeNull();
  const args = (invocation?.[1] ?? "").trim().split(/\s+/);
  const requirementsFlag = args.indexOf("-r");
  expect(
    requirementsFlag,
    "base image pip install must consume a requirements file",
  ).toBeGreaterThanOrEqual(0);
  expect(args[requirementsFlag + 1]).toBe(copiedLock?.[1]);
  return [...args.slice(0, requirementsFlag), "-r", requirementsPath];
}

function assertEveryRequirementIsHashLocked(requirementsLock: string): void {
  const lines = requirementsLock.split(/\r?\n/);
  const requirementStarts = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.length > 0 && !/^\s|#/.test(line));
  expect(requirementStarts.length).toBeGreaterThan(0);

  requirementStarts.forEach((requirement, position) => {
    expect(
      requirement.line,
      `lock entry on line ${requirement.index + 1} must be exactly pinned`,
    ).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\[[^\]]+\])?==[^\s\\]+\s+\\$/);
    const nextIndex = requirementStarts[position + 1]?.index ?? lines.length;
    const block = lines.slice(requirement.index, nextIndex).join("\n");
    const hashTokens = block.match(/--hash=[^\s\\]+/g) ?? [];
    expect(hashTokens.length, requirement.line).toBeGreaterThan(0);
    expect(hashTokens.every((token) => /^--hash=sha256:[a-f0-9]{64}$/.test(token))).toBe(true);
  });
}

describe("LangChain Deep Agents Code image contracts", () => {
  it.each([
    "/usr/local/lib/nemoclaw/dcode-managed-exec /usr/bin/true",
    "/usr/local/bin/dcode --version",
    "/usr/local/bin/dcode.real --version",
    "/usr/local/bin/deepagents-code --version",
  ])(
    "hardens copied NemoClaw blueprints against sandbox-user mutation [%s]",
    testTimeoutOptions(30_000),
    (probe) => {
      const dockerfile = readAgentFile("Dockerfile");
      const finalRuntimeStage = ["# hadolint ignore=DL3006", "FROM ${BASE_IMAGE}", ""].join("\n");
      const finalRuntimeRootHandoff = [
        "# The supplied base may end as a non-root runtime user. Reset the build user",
        "# explicitly before installing the root-owned managed-startup handoff.",
        "# hadolint ignore=DL3066",
        "USER root",
      ].join("\n");
      const managedRuntimeDirectory = "&& install -d -o root -g root -m 0755 /run/nemoclaw";
      const runtimeModeReplay =
        "&& chmod 444 /opt/nemoclaw-deepagents-code/generate-config.ts /opt/nemoclaw-deepagents-code/packages/nemoclaw-langchain-deepagents-code/config/generate-config.ts /opt/nemoclaw-deepagents-code/package.json";

      expect(dockerfile).toContain("ARG BASE_IMAGE\n");
      expect(dockerfile).toContain("ARG NEMOCLAW_MODEL=nvidia/nemotron-3-ultra-550b-a55b");
      expect(dockerfile).toContain(
        "COPY packages/nemoclaw-langchain-deepagents-code/config/entrypoint.ts /opt/nemoclaw-deepagents-code/generate-config.ts",
      );
      expect(dockerfile).toContain(
        "COPY packages/nemoclaw-langchain-deepagents-code/package.json /opt/nemoclaw-deepagents-code/package.json",
      );
      expect(dockerfile).toContain(
        "COPY packages/nemoclaw-langchain-deepagents-code/host/managed-identity.cts /opt/nemoclaw-deepagents-code/packages/nemoclaw-langchain-deepagents-code/host/managed-identity.cts",
      );
      expect(dockerfile).toContain("&& /usr/local/lib/nemoclaw/generate-config \\");
      expect(dockerfile).not.toContain("langchain-deepagents-code-sandbox-base:latest");
      expect(dockerfile).toContain(
        'timeout 10 env -i /usr/local/lib/nemoclaw/dcode-wrapper.sh -n ""',
      );

      expect(dockerfile).toContain(`env -i ${probe}`);

      expect(dockerfile).toContain("chown root:root /sandbox/.nemoclaw");
      expect(dockerfile).toContain("chmod 1755 /sandbox/.nemoclaw");
      expect(dockerfile).toContain("chown -R root:root /sandbox/.nemoclaw/blueprints");
      expect(dockerfile).toContain("chmod -R 755 /sandbox/.nemoclaw/blueprints");
      expect(dockerfile).toContain("cp -r /opt/nemoclaw-blueprint/*");
      expect(dockerfile).toContain("COPY --from=mcp-tool-discovery-runtime");
      expect(dockerfile.indexOf("cp -r /opt/nemoclaw-blueprint/*")).toBeLessThan(
        dockerfile.indexOf("chown -R root:root /sandbox/.nemoclaw/blueprints"),
      );
      expect(dockerfile.split(managedRuntimeDirectory)).toHaveLength(2);
      expect(dockerfile.indexOf("COPY --from=mcp-tool-discovery-runtime")).toBeLessThan(
        dockerfile.indexOf(managedRuntimeDirectory),
      );
      expect(dockerfile).toContain(finalRuntimeStage);
      expect(dockerfile).toContain(finalRuntimeRootHandoff);
      expectManagedBootstrapNativeImageContract(dockerfile);
      expect(dockerfile.indexOf(finalRuntimeStage)).toBeLessThan(
        dockerfile.indexOf(finalRuntimeRootHandoff),
      );
      expect(dockerfile.indexOf(finalRuntimeRootHandoff)).toBeLessThan(
        dockerfile.indexOf(managedRuntimeDirectory),
      );
      expect(dockerfile.indexOf(managedRuntimeDirectory)).toBeLessThan(
        dockerfile.indexOf(runtimeModeReplay),
      );
      expect(dockerfile).toContain(
        "COPY tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/managed-startup-image-runtime.bundle /out/managed-startup-image-runtime.cjs",
      );
      expect(dockerfile).not.toContain(
        "COPY src/lib/onboard/managed-bootstrap/ ./src/lib/onboard/managed-bootstrap/",
      );
      expect(dockerfile).toContain(
        "COPY --from=managed-bootstrap-entrypoint-builder /out/usr/local/bin/nemoclaw-managed-bootstrap /usr/local/bin/nemoclaw-managed-bootstrap",
      );
      expect(dockerfile).toContain(
        "COPY --from=managed-bootstrap-entrypoint-builder /out/usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh /usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh",
      );
      expect(dockerfile).toContain(
        "chmod 755 /usr/local/bin/nemoclaw-start /usr/local/bin/nemoclaw-managed-startup-hold /usr/local/bin/nemoclaw-managed-bootstrap",
      );
      expect(dockerfile).toContain("ARG NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER=root");
      expect(dockerfile).toContain("root|sandbox) ;; \\");
      expect(dockerfile).toContain("&& command -v setpriv >/dev/null 2>&1");
      expect(dockerfile.trimEnd()).toMatch(
        /USER \$\{NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER\}\nENTRYPOINT \["\/usr\/local\/bin\/nemoclaw-start"\]\nCMD \["\/bin\/bash"\]$/,
      );
    },
  );

  it("does not wire unsupported messaging artifacts into the DeepAgents image", () => {
    const dockerfile = readAgentFile("Dockerfile");
    const startScript = readAgentFile("start.sh");

    expect(dockerfile).not.toContain("NEMOCLAW_MESSAGING_PLAN_B64");
    expect(dockerfile).not.toContain("messaging-build-applier.mts");
    expect(startScript).toContain("Setting up NemoClaw Deep Agents Code runtime");
    expect(startScript).not.toContain("load_messaging_env");
    expect(startScript).not.toContain("TELEGRAM_BOT_TOKEN");
    expect(startScript).not.toContain("DISCORD_BOT_TOKEN");
    expect(startScript).not.toContain("SLACK_BOT_TOKEN");
    expect(startScript).not.toContain("GOOGLECHAT_SERVICE_ACCOUNT");
    expect(startScript).not.toContain("GOOGLE_CHAT_SERVICE_ACCOUNT");
  });

  it("prints NemoClaw setup output before idling as a terminal runtime", () => {
    const startScript = readAgentFile("start.sh");

    expect(startScript).toContain("Setting up NemoClaw Deep Agents Code runtime");
    expect(startScript).toContain("exec -a nemoclaw-dcode-entrypoint tail -f /dev/null");
    expect(startScript).not.toContain("exec sleep infinity");
  });

  it("sources the managed runtime environment in interactive and login shells (#6191)", () => {
    const baseDockerfile = readAgentFile("Dockerfile.base");
    const sourceLine = "[ -f /tmp/nemoclaw-proxy-env.sh ] && . /tmp/nemoclaw-proxy-env.sh";

    expect(baseDockerfile.split(sourceLine)).toHaveLength(3);
    expect(baseDockerfile).toContain("> /sandbox/.bashrc");
    expect(baseDockerfile).toContain("> /sandbox/.profile");
  });

  it("reserves the first DCode login profile under a sticky root workspace (#8624)", () => {
    const dockerfile = readAgentFile("Dockerfile");
    const loginProfile = readAgentFile("runtime/login-profile.sh");
    const startScript = readAgentFile("start.sh");

    expect(dockerfile).toContain(
      "COPY packages/nemoclaw-langchain-deepagents-code/runtime/login-profile.sh /usr/local/lib/nemoclaw/dcode-login-profile.sh",
    );
    expect(dockerfile).toContain("chown root:sandbox /sandbox");
    expect(dockerfile).toContain("chmod 1775 /sandbox");
    expect(dockerfile).toContain(
      "install -o root -g root -m 0444 /usr/local/lib/nemoclaw/dcode-login-profile.sh /sandbox/.bash_profile",
    );
    expect(startScript).toContain("protect_dcode_login_profile");
    expect(startScript).toContain("verify_dcode_login_profile");
    expect(startScript).toContain("rm -f -- /sandbox/.bash_profile");
    expect(startScript).toContain(
      "[SECURITY] DCode login profile is not protected; rebuild this sandbox.",
    );
    expect(loginProfile).toContain('case "${BASH_EXECUTION_STRING:-}" in');
    expect(loginProfile).toContain('*"/usr/local/lib/nemoclaw/dcode-managed-exec"*)');
    expect(loginProfile.indexOf("unset BASH_ENV ENV")).toBeLessThan(
      loginProfile.indexOf("/tmp/nemoclaw-proxy-env.sh"),
    );
  });

  it("serializes the sandbox name into the shell env file for in-sandbox identity", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-start-"));
    try {
      const { envFile, scriptPath } = makeStartScriptFixture(tempDir);

      execFileSync("bash", [scriptPath, "sh", "-c", ":"], {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          NEMOCLAW_SANDBOX_NAME: "dcode-demo",
        },
        encoding: "utf8",
      });

      expect(fs.readFileSync(envFile, "utf8")).toContain("export NEMOCLAW_SANDBOX_NAME=dcode-demo");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function verifyManagedRuntimeProxyReplacement() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-start-"));
    const { envFile, scriptPath } = makeStartScriptFixture(tempDir, {
      markerDir: dcodeStateDir(tempDir),
    });
    const inheritedSecrets = {
      NVIDIA_API_KEY: `nvapi-${"A".repeat(10)}`,
      OPENAI_API_KEY: `sk-${"B".repeat(20)}`,
      LANGSMITH_API_KEY: `lsv2_pt_${"C".repeat(36)}_${"D".repeat(10)}`,
      LANGSMITH_TRACING: `lsv2_sk_${"I".repeat(36)}_${"J".repeat(10)}`,
      LANGSMITH_PROJECT: `lsv2_pt_${"E".repeat(36)}_${"F".repeat(10)}`,
      DEEPAGENTS_CODE_LANGSMITH_PROJECT: `lsv2_sk_${"G".repeat(36)}_${"H".repeat(10)}`,
    };
    const inheritedTracingFlags = Object.fromEntries(
      TRACING_ENABLE_ENV_NAMES.map((name) => [name, "true"]),
    );
    const inheritedAnalyticsFlags = Object.fromEntries(
      ANALYTICS_DISABLE_ENV_NAMES.map((name) => [name, "0"]),
    );
    const { envFileText, output } = runStartScriptProxyProbe(scriptPath, envFile, {
      HTTP_PROXY: "http://corp-user:corp-password@corp-proxy.example:8080",
      HTTPS_PROXY: "http://corp-user:corp-password@corp-proxy.example:8080",
      NO_PROXY: "corp.internal,inference.local",
      http_proxy: "http://lower-user:lower-password@lower-proxy.example:8080",
      https_proxy: "http://lower-user:lower-password@lower-proxy.example:8080",
      no_proxy: "corp.internal,inference.local",
      ALL_PROXY: "socks5://all-user:all-password@all-proxy.example:1080",
      all_proxy: "socks5://lower-all-user:lower-all-password@lower-all-proxy.example:1080",
      OPENAI_PROXY: "http://openai-user:openai-password@attacker.example:8080",
      ...inheritedSecrets,
      ...inheritedTracingFlags,
      ...inheritedAnalyticsFlags,
    });
    const managedProxy = "http://10.200.0.1:3128";
    const managedNoProxy = "localhost,127.0.0.1,::1,10.200.0.1";
    const outputLines = output.trimEnd().split("\n");
    const envFileLines = envFileText.trimEnd().split("\n");
    expect(fs.statSync(envFile).mode & 0o777).toBe(0o444);
    expect(envFileText).toContain(`export PATH="${DCODE_CANONICAL_PATH}"`);
    expectEnvironmentValues(outputLines, envFileLines, PROXY_URL_ENV_NAMES, managedProxy);
    expectEnvironmentValues(outputLines, envFileLines, NO_PROXY_ENV_NAMES, managedNoProxy);
    expectEnvironmentValues(outputLines, envFileLines, TRACING_ENABLE_ENV_NAMES, "false");
    expectEnvironmentValues(outputLines, envFileLines, ANALYTICS_DISABLE_ENV_NAMES, "1");
    expect(envFileLines).toContain("unset ALL_PROXY all_proxy OPENAI_PROXY");
    expect(
      outputLines.filter((line) => /^(?:RUNTIME|SOURCED)_(?:NO_PROXY|no_proxy)=/.test(line)),
    ).not.toEqual(expect.arrayContaining([expect.stringContaining("inference.local")]));
    expect(envFileLines.filter((line) => /^export (?:NO_PROXY|no_proxy)=/.test(line))).not.toEqual(
      expect.arrayContaining([expect.stringContaining("inference.local")]),
    );
    const combined = `${output}\n${envFileText}`;
    expect(containsTokenShapedSecret(inheritedSecrets.LANGSMITH_API_KEY)).toBe(true);
    expect(containsTokenShapedSecret(envFileText)).toBe(false);
    expectTextToOmitAll(envFileText, Object.values(inheritedSecrets));
    expectTextToOmitAll(combined, ["proxy.example", "user", "password", "corp.internal"]);
  }

  it(
    "replaces inherited host proxy values with the managed runtime proxy (#6191)",
    verifyManagedRuntimeProxyReplacement,
  );

  it("keeps all Deep Agents Code entry points behind the managed wrapper boundary", () => {
    const dockerfile = readAgentFile("Dockerfile");
    const launcher = readAgentFile("runtime/agent-launcher.sh");
    const wrapper = readAgentFile("runtime/agent-wrapper.sh");
    const expectedVersion = loadAgent("langchain-deepagents-code").expectedVersion;

    expect(dockerfile).not.toContain("NEMOCLAW_WEB_SEARCH_ENABLED");
    expect(dockerfile).not.toContain("NEMOCLAW_DEEPAGENTS_CODE_SHELL_ALLOW_LIST");
    expect(dockerfile).not.toContain("dcode.upstream");
    expect(wrapper).not.toContain("NEMOCLAW_DEEPAGENTS_CODE_SHELL_ALLOW_LIST");
    expect(wrapper).toContain("unset DEEPAGENTS_CODE_SHELL_ALLOW_LIST");
    expect(expectedVersion).not.toBeNull();
    expect(wrapper).toContain(`deepagents-code==${expectedVersion}`);
    expect(wrapper).toContain("Schema pin");
    expect(wrapper).toContain("truthy top-level");
    expect(wrapper).toContain("unset PYTHONHOME PYTHONPATH");
    expect(wrapper).toContain('/opt/venv/bin/python3 -I - "$auth_file"');
    expect(wrapper).toContain("exec /opt/venv/bin/python3 -I -m deepagents_code");
    expect(wrapper).toContain("extra_args=(--sandbox none --no-mcp)");
    expect(wrapper).not.toContain("managed_mcp_config_path");
    expect(wrapper).not.toContain("--mcp-config /sandbox/.mcp.json");
    expect(wrapper).toContain("assert_no_auth_store_credentials");
    expect(wrapper).toContain("assert_no_codex_auth_credentials");
    expect(
      [
        "export DEEPAGENTS_CODE_LANGSMITH_TRACING=false",
        "export LANGSMITH_TRACING=false",
        "export DEEPAGENTS_CODE_OFFLINE=1",
        "export DEEPAGENTS_CODE_RIPGREP_INSTALLER=system",
        'reject_managed_override "dependency update posture"',
        'reject_managed_override "credential posture"',
        'reject_managed_override "managed tool set posture"',
        'reject_managed_override "sandbox isolation"',
        'reject_managed_override "MCP posture"',
        'reject_managed_override "shell allow-list posture"',
      ].every((s) => wrapper.includes(s)),
    ).toBe(true);
    expect(
      [
        "runtime/managed-runtime.py",
        "dcode-session-supervisor.py",
        "runtime/observability.py",
        "nemoclaw_read_only_mcp.py",
        "compat/runtime-patch.py",
        "validate-read-only-mcp-call.py",
        "validate-nemotron-ultra-profile.py",
        "DEEPAGENTS_CODE_LANGSMITH_TRACING=false",
        "LANGSMITH_TRACING=false",
        "DEEPAGENTS_CODE_OFFLINE=1",
        "DEEPAGENTS_CODE_RIPGREP_INSTALLER=system",
        "install -m 0755 /usr/local/lib/nemoclaw/dcode-launcher.sh /usr/local/bin/dcode.real",
        "install -m 0755 /usr/local/lib/nemoclaw/dcode-launcher.sh /usr/local/bin/deepagents-code",
        "install -o root -g root -m 0755 /usr/local/lib/nemoclaw/dcode-launcher.sh /usr/local/lib/nemoclaw/dcode-managed-exec",
        "COPY packages/nemoclaw-langchain-deepagents-code/runtime/agent-status.sh /usr/local/lib/nemoclaw/dcode-agent-status.sh",
        `test "$(stat -c '%u:%g:%a' /usr/local/lib/nemoclaw/dcode-agent-status.sh)" = "0:0:444"`,
        "COPY packages/nemoclaw-langchain-deepagents-code/runtime/session-supervisor.py /usr/local/lib/nemoclaw/dcode-session-supervisor.py",
        `test "$(stat -c '%u:%g:%a' /usr/local/lib/nemoclaw/dcode-session-supervisor.py)" = "0:0:755"`,
        "test -f /usr/local/lib/nemoclaw/dcode-managed-exec",
        "test ! -L /usr/local/lib/nemoclaw/dcode-managed-exec",
        `test "$(stat -c '%u:%g:%a' /usr/local/lib/nemoclaw/dcode-managed-exec)" = "0:0:755"`,
        "cmp -s /usr/local/lib/nemoclaw/dcode-launcher.sh /usr/local/lib/nemoclaw/dcode-managed-exec",
        "/usr/local/lib/nemoclaw/dcode-managed-exec /usr/bin/true",
        "/opt/venv/bin/pip3 install --no-index --no-cache-dir --no-deps --no-build-isolation /opt/nemoclaw-deepagents-profile-plugin",
        "find /opt/nemoclaw-deepagents-profile-plugin -type f -print | LC_ALL=C sort",
        "/opt/venv/bin/pip3 check",
        "/opt/venv/bin/python3 -I /opt/nemoclaw-deepagents-code/validate-nemotron-ultra-profile.py",
        "/opt/venv/bin/python3 -I /opt/nemoclaw-deepagents-code/validate-read-only-mcp-call.py",
      ].every((s) => dockerfile.includes(s)),
    ).toBe(true);
    expect(
      dockerfile
        .split("\n")
        .filter((line) =>
          line.startsWith("COPY packages/nemoclaw-langchain-deepagents-code/plugin"),
        ),
    ).toEqual([
      "COPY packages/nemoclaw-langchain-deepagents-code/plugin/pyproject.toml /opt/nemoclaw-deepagents-profile-plugin/",
      "COPY packages/nemoclaw-langchain-deepagents-code/plugin/src/nemoclaw_deepagents_profile/__init__.py /opt/nemoclaw-deepagents-profile-plugin/src/nemoclaw_deepagents_profile/",
    ]);
    expect(dockerfile).toContain(
      "rm -f /usr/local/bin/dcode /usr/local/bin/deepagents-code /opt/venv/bin/dcode /opt/venv/bin/deepagents-code",
    );
    expect(dockerfile).toContain(
      "COPY packages/nemoclaw-langchain-deepagents-code/checks/tool-disclosure.py",
    );
    expect(dockerfile).toContain(
      "python3 /opt/nemoclaw-deepagents-code/validate-progressive-tool-disclosure.py",
    );
    expect(dockerfile).toContain(
      "rm -f /opt/nemoclaw-deepagents-code/validate-progressive-tool-disclosure.py",
    );
    expect(dockerfile).toContain(
      "rm -f /opt/nemoclaw-deepagents-code/validate-nemotron-ultra-profile.py",
    );
    expect(dockerfile).toContain(
      "rm -f /opt/nemoclaw-deepagents-code/validate-read-only-mcp-call.py",
    );
    expect(dockerfile).not.toContain("patch-nemotron-ultra-profile.py");
    expect(dockerfile).not.toContain("nemotron-ultra-harness-profile.py");
    expect(dockerfile).not.toContain("LICENSE.langchain-deepagents");
    expect(dockerfile).not.toContain("langchain-deepagents-MIT.txt");
    expect(dockerfile).toContain(
      "COPY packages/nemoclaw-langchain-deepagents-code/checks/observability.py",
    );
    expect(dockerfile).toContain(
      "/opt/venv/bin/python3 -I /opt/nemoclaw-deepagents-code/validate-observability.py",
    );
    expect(dockerfile).toContain("rm -f /opt/nemoclaw-deepagents-code/validate-observability.py");
    expect(dockerfile).toContain("ARG NEMOCLAW_TOOL_DISCLOSURE=progressive");
    expect(dockerfile).toContain("NEMOCLAW_TOOL_DISCLOSURE=${NEMOCLAW_TOOL_DISCLOSURE}");
    expect(dockerfile).toContain("progressive|direct)");
    expect(launcher).toContain(
      'exec /opt/venv/bin/python3 -I "$MANAGED_SESSION_SUPERVISOR" "$MANAGED_DCODE_WRAPPER" "$@"',
    );
    expect(launcher).toContain(
      'readonly MANAGED_SESSION_SUPERVISOR="/usr/local/lib/nemoclaw/dcode-session-supervisor.py"',
    );
    expect(launcher).toContain(
      'status | whoami | identity | --version | -v | -V) exec "$MANAGED_DCODE_WRAPPER" "$@"',
    );
    expect(launcher).toContain("harden_resource_limits");
    expect(launcher).toContain("refusing to launch dcode unhardened");
  });

  it("exposes an exact managed MCP capability marker without starting dcode", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-mcp-capability-"));
    try {
      const { wrapperPath, ranMarker, authFile, codexAuthFile } = makeWrapperFixture(tempDir);
      fs.writeFileSync(authFile, '{"api_key":"forbidden"}\n', "utf8");
      fs.writeFileSync(codexAuthFile, '{"access_token":"forbidden"}\n', "utf8");
      const result = runWrapper(wrapperPath, ["--nemoclaw-mcp-capability"], {
        OPENAI_API_KEY: "forbidden",
        NEMOCLAW_DEEPAGENTS_CODE_AUTH_MODE: "invalid",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("NEMOCLAW_DEEPAGENTS_MCP_CAPABILITY=2\n");
      expect(fs.existsSync(ranMarker)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps NemoClaw MCP state separate from user discovery", () => {
    const wrapper = readAgentFile("runtime/agent-wrapper.sh");
    const managedRuntime = readAgentFile("runtime/managed-runtime.py");
    const patcher = readAgentFile("compat/runtime-patch.py");
    const agent = loadAgent("langchain-deepagents-code");
    const managedPath = "/sandbox/.deepagents/.nemoclaw-mcp.json";

    // The pinned release's user/project .mcp.json files remain user-authored.
    // Managed images suppress discovery and pass only an integrity-bound
    // snapshot of NemoClaw's dedicated projection.
    expect(wrapper).toContain("extra_args=(--sandbox none --no-mcp)");
    expect(managedRuntime).toContain(`_MCP_CONFIG_FILE = Path("${managedPath}")`);
    expect(patcher).toContain("managed_mcp_config = _nemoclaw_managed_mcp_config_path()");
    expect(patcher).toContain("_nemoclaw_skip_launch_model");
    expect(managedRuntime).toContain("if not servers:\n        return None");
    expect(managedRuntime).toContain("or descriptor != _MANAGED_MCP_FD");
    expect(patcher).toContain("def discover_mcp_configs(");
    expect(patcher).toContain("return []");
    expect(agent.userManagedFiles).toContain(".deepagents/.mcp.json");
    expect(agent.userManagedFiles).not.toContain(".deepagents/.nemoclaw-mcp.json");
    expect(wrapper).not.toContain("--mcp-config /sandbox/.mcp.json");
    expect(wrapper).not.toContain("managed_mcp_config_path");
    expect(patcher).not.toContain('managed_mcp_config = "/sandbox/.mcp.json"');
  });

  it("puts the managed Python venv before system Python in every dcode entry path", () => {
    const baseDockerfile = readAgentFile("Dockerfile.base");
    const dockerfile = readAgentFile("Dockerfile");
    const startScript = readAgentFile("start.sh");
    const wrapper = readAgentFile("runtime/agent-wrapper.sh");
    const pathContractFiles = [baseDockerfile, dockerfile, startScript, wrapper].join("\n");

    expect(baseDockerfile).toContain("VIRTUAL_ENV=/opt/venv");
    expect(dockerfile).toContain("VIRTUAL_ENV=/opt/venv");
    expect(baseDockerfile).toContain(`PATH="${DCODE_CANONICAL_PATH}"`);
    expect(dockerfile).toContain(`PATH="${DCODE_CANONICAL_PATH}"`);
    expect(startScript).toContain(`export PATH="${DCODE_CANONICAL_PATH}"`);
    expect(startScript).toContain(`printf '%s\\n' 'export PATH="${DCODE_CANONICAL_PATH}"'`);
    expect(wrapper).toContain(`export PATH="${DCODE_CANONICAL_PATH}"`);
    expect(pathContractFiles).not.toContain('PATH="/usr/local/bin:${PATH}"');
  });

  it("preseeds managed first-run state and a usable ripgrep binary (#6678)", () => {
    const baseDockerfile = readAgentFile("Dockerfile.base");

    expect(baseDockerfile).toContain("ripgrep=14.1.1-1+b4");
    expect(baseDockerfile).toContain(
      "printf '1\\n' > /sandbox/.deepagents/.state/onboarding_complete",
    );
  });

  it("makes the base image enforce the reviewed hash-locked dependency set", () => {
    const baseDockerfile = readAgentFile("Dockerfile.base");
    const requirementsLock = readAgentFile("runtime/requirements.lock");

    assertEveryRequirementIsHashLocked(requirementsLock);
    expect(baseDockerfile).not.toContain("--break-system-packages");
    expect(baseDockerfile).not.toContain("--ignore-installed");

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pip-hash-contract-"));
    try {
      const venvPath = path.join(tempDir, "venv");
      execFileSync("python3", ["-m", "venv", venvPath], { stdio: "pipe" });
      const pipPath = path.join(venvPath, "bin", "pip3");
      const wheelPath = writeMinimalWheel(tempDir);
      const wheelDigest = sha256(fs.readFileSync(wheelPath));
      const hashedRequirements = path.join(tempDir, "hashed-requirements.txt");
      const unhashedRequirements = path.join(tempDir, "unhashed-requirements.txt");
      const requirement = `nemoclaw-hash-contract @ ${pathToFileURL(wheelPath).href}`;
      fs.writeFileSync(hashedRequirements, `${requirement} --hash=sha256:${wheelDigest}\n`, "utf8");
      fs.writeFileSync(unhashedRequirements, `${requirement}\n`, "utf8");

      const runPip = (requirementsPath: string) =>
        spawnSync(
          pipPath,
          [
            "install",
            "--dry-run",
            "--no-index",
            "--no-deps",
            ...baseImagePipInstallArgs(baseDockerfile, requirementsPath),
          ],
          { encoding: "utf8" },
        );
      const accepted = runPip(hashedRequirements);
      expect(accepted.status, `${accepted.stdout}\n${accepted.stderr}`).toBe(0);

      const rejected = runPip(unhashedRequirements);
      expect(rejected.status).not.toBe(0);
      expect(`${rejected.stdout}\n${rejected.stderr}`).toContain(
        "Hashes are required in --require-hashes mode",
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps image validator versions aligned with the reviewed lockfile", () => {
    const requirementsLock = readAgentFile("runtime/requirements.lock");
    const progressiveValidator = readAgentFile("checks/tool-disclosure.py");
    const pluginMetadata = readAgentFile("plugin/pyproject.toml");
    const pluginVersion = pluginMetadata.match(/^version = "([^"]+)"$/m)?.[1];
    expect(pluginVersion).toBe("0.1.0");

    const {
      "nemoclaw-deepagents-profile": profileValidatorPluginVersion,
      ...profileValidatorVersions
    } = pythonStringMap(readAgentFile("checks/model-profile.py"), "EXPECTED_VERSIONS");
    expect(profileValidatorPluginVersion).toBe(pluginVersion);
    expectVersionsMatchLock(requirementsLock, profileValidatorVersions);
    expectVersionsMatchLock(
      requirementsLock,
      pythonStringMap(progressiveValidator, "PINNED_VERSIONS"),
    );

    const observabilityValidator = readAgentFile("checks/observability.py");
    const observabilityVersion = observabilityValidator.match(
      /^_EXPECTED_LANGGRAPH_VERSION = "([^"]+)"$/m,
    )?.[1];
    expect(observabilityVersion).toBe(lockedRequirementVersion(requirementsLock, "langgraph"));

    const e2eProfileCheck = fs.readFileSync(
      path.join(
        repoRoot,
        "test",
        "e2e",
        "e2e-cloud-experimental",
        "checks",
        "03-deepagents-code-nemotron-ultra-profile.sh",
      ),
      "utf8",
    );
    const { "nemoclaw-deepagents-profile": e2ePluginVersion, ...e2eVersions } = pythonStringMap(
      e2eProfileCheck,
      "EXPECTED_VERSIONS",
    );
    expect(e2ePluginVersion).toBe(pluginVersion);
    expectVersionsMatchLock(requirementsLock, e2eVersions);
  });

  it("assigns the read-only MCP contract to each loaded validator tool", () => {
    const validatorPath = path.join(
      repoRoot,
      "packages",
      "nemoclaw-langchain-deepagents-code",
      "checks",
      "tool-disclosure.py",
    );
    const metadata = JSON.parse(
      execFileSync(
        "python3",
        [
          "-c",
          `import ast
import json
import sys

tree = ast.parse(open(sys.argv[1], encoding="utf-8").read())
values = []
for node in ast.walk(tree):
    if not isinstance(node, ast.Assign):
        continue
    if not any(isinstance(target, ast.Attribute) and target.attr == "metadata" for target in node.targets):
        continue
    value = ast.literal_eval(node.value)
    if isinstance(value, dict) and value.get("_deepagents_code_mcp") is True:
        values.append(value)
print(json.dumps(values, sort_keys=True))`,
          validatorPath,
        ],
        { encoding: "utf8" },
      ),
    ) as Array<Record<string, unknown>>;

    expect(metadata).toEqual([
      {
        _deepagents_code_mcp: true,
        _deepagents_code_mcp_server: "direct-runtime-validator",
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      {
        _deepagents_code_mcp: true,
        _deepagents_code_mcp_server: "runtime-validator",
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
    ]);
  });

  it.each([
    ["aiohttp", "3.14.3"],
    ["cryptography", "50.0.0"],
    ["deepagents-code", "0.1.55"],
    ["langgraph-checkpoint-sqlite", "3.1.1"],
  ] as const)(
    "records dependency advisory review for the lockfile [case %#]",
    (name, expectedVersion) => {
      const review = readAgentFile("compat/dependencies.md");
      const requirementsLock = readAgentFile("runtime/requirements.lock");
      const adapterModule = readAgentFile("plugin/src/nemoclaw_deepagents_profile/__init__.py");
      const adapterMetadata = readAgentFile("plugin/pyproject.toml");
      const dockerfile = readAgentFile("Dockerfile");
      const profileValidator = readAgentFile("checks/model-profile.py");

      expect(review).toContain(`Lockfile SHA-256: \`${sha256(requirementsLock)}\``);
      expect(review).toContain(
        "uv tool run --python 3.13 pip-audit -r packages/nemoclaw-langchain-deepagents-code/runtime/requirements.lock --progress-spinner off --disable-pip",
      );
      expect(review).toMatch(/Targeted audit result:.*no known vulnerabilities/is);
      expect(review).toMatch(
        /Complete-lock audit result:.*2 duplicate records.*1 unrelated package/is,
      );
      expect(review).toContain("`GHSA-cq5v-8q36-5273`");
      expect(review).toContain("`GHSA-g6cj-pr64-35w5`");
      expect(review).toContain("Deep Agents Code `0.1.55`");
      expect(review).toContain("semantic migration through `0.1.55`");
      expect(requirementsLock).toContain("uv==0.11.33");
      expect(requirementsLock).toContain("aiohttp==3.14.3");
      expect(requirementsLock).toContain("cryptography==50.0.0");
      expect(requirementsLock).not.toContain("aiohttp==3.14.1");
      expect(requirementsLock).not.toContain("cryptography==49.0.0");
      expect(requirementsLock).toContain("mcp==1.28.1");
      expect(requirementsLock).toContain("pillow==12.3.0");
      expect(requirementsLock).toContain("pyasn1==0.6.4");
      expect(requirementsLock).toContain("langgraph-checkpoint-sqlite==3.1.1");
      const dockerfileBase = readAgentFile("Dockerfile.base");
      expect(dockerfileBase).toContain(`'${name}': '${expectedVersion}'`);
      expect(review).toContain(`Adapter module SHA-256: \`${sha256(adapterModule)}\``);
      expect(review).toContain(`Adapter project metadata SHA-256: \`${sha256(adapterMetadata)}\``);
      expect(dockerfile).toContain(
        `'${sha256(adapterModule)}' '/opt/nemoclaw-deepagents-profile-plugin/src/nemoclaw_deepagents_profile/__init__.py'`,
      );
      expect(dockerfile).toContain(
        `'${sha256(adapterMetadata)}' '/opt/nemoclaw-deepagents-profile-plugin/pyproject.toml'`,
      );
      expect(profileValidator).toContain(`"${sha256(adapterModule)}"`);
      expect(review).toContain("Adapter dependency audit result: `No known vulnerabilities found`");
    },
  );
});
