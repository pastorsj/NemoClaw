// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { prepareInitialSandboxCreatePolicy } from "../../../../src/lib/onboard/initial-policy.ts";
import { cloudExperimentalChecksForOnboarding } from "../../../../test/e2e/live/cloud-experimental-check-list.ts";
import {
  DCODE_CANONICAL_PATH,
  headlessCheckPath,
  runHeadlessCheckHelper,
  TRUSTED_FETCH_PROXY_ENV_NAME,
} from "../helpers/headless.ts";

const packageRoot = path.resolve(import.meta.dirname, "../..");
const repoRoot = path.resolve(packageRoot, "../..");
const tuiStartupCheckPath = path.join(
  repoRoot,
  "test",
  "e2e",
  "e2e-cloud-experimental",
  "checks",
  "10-deepagents-code-tui-startup.sh",
);

function expectTextToMatchAll(text: string, expectedPatterns: readonly (string | RegExp)[]): void {
  for (const expectedPattern of expectedPatterns) expect(text).toMatch(expectedPattern);
}

describe("Deep Agents Code E2E acceptance contracts", () => {
  it.each(["example.com", "169.254.169.254", "127.0.0.1"])(
    "prepares read-only raw GitHub access without opening denied fetch targets [%s]",
    (deniedHost) => {
      const prepared = prepareInitialSandboxCreatePolicy(
        path.join(packageRoot, "policy-additions.yaml"),
        [],
        {
          agentName: "langchain-deepagents-code",
          additionalPresets: ["observability-otlp-local"],
        },
      );

      try {
        const policy = YAML.parse(fs.readFileSync(prepared.policyPath, "utf8")) as {
          network_policies?: Record<string, { endpoints?: Array<Record<string, unknown>> }>;
        };
        const endpoints = Object.values(policy.network_policies ?? {}).flatMap(
          (networkPolicy) => networkPolicy.endpoints ?? [],
        );
        const rawGitHub = endpoints.find(
          (endpoint) => endpoint.host === "raw.githubusercontent.com",
        );

        expect(rawGitHub).toMatchObject({
          port: 443,
          protocol: "rest",
          enforcement: "enforce",
          rules: [
            { allow: { method: "GET", path: "/**" } },
            { allow: { method: "HEAD", path: "/**" } },
          ],
        });
        expect(rawGitHub).not.toHaveProperty("access");

        const effectiveHosts = new Set(endpoints.map((endpoint) => endpoint.host));
        expect(effectiveHosts, `${deniedHost} must remain denied by default`).not.toContain(
          deniedHost,
        );
      } finally {
        prepared.cleanup?.();
      }
    },
  );

  it("pins the cloud E2E wiring for fetch_url success and denied-host paths", () => {
    const check = fs.readFileSync(
      path.join(
        repoRoot,
        "test/e2e/e2e-cloud-experimental/checks/06-deepagents-code-python-egress.sh",
      ),
      "utf8",
    );

    expect(check).toContain("fetch_url_probe_source");
    expect(check).toContain("from deepagents_code.tools import fetch_url");
    expect(check).toContain(TRUSTED_FETCH_PROXY_ENV_NAME);
    expect(check).toContain("expect_fetch_reached");
    expect(check).toContain("FETCH_SUCCESS:2[0-9]{2}:[1-9][0-9]*");
    expect(check).toContain("https://raw.githubusercontent.com/NVIDIA/NemoClaw/main/README.md");
    expect(check).toContain('expect_fetch_blocked "unapproved hosts" "https://example.com/"');
    expect(check).toContain(
      'expect_fetch_blocked "instance metadata" "https://169.254.169.254/latest/meta-data/"',
    );
    expect(check).toContain('expect_fetch_blocked "sandbox loopback" "https://127.0.0.1/"');
    expect(check).not.toContain("'403 client error: forbidden'");
  });

  function verifyDeepAgentsLivePolicyChecks() {
    const landlockCheck = fs.readFileSync(
      path.join(
        repoRoot,
        "test",
        "e2e",
        "e2e-cloud-experimental",
        "checks",
        "05-deepagents-code-landlock-readonly.sh",
      ),
      "utf8",
    );
    const pythonEgressCheck = fs.readFileSync(
      path.join(
        repoRoot,
        "test",
        "e2e",
        "e2e-cloud-experimental",
        "checks",
        "06-deepagents-code-python-egress.sh",
      ),
      "utf8",
    );
    const secretBoundaryCheck = fs.readFileSync(
      path.join(
        repoRoot,
        "test",
        "e2e",
        "e2e-cloud-experimental",
        "checks",
        "08-deepagents-code-secret-boundary.sh",
      ),
      "utf8",
    );
    const tuiStartupCheck = fs.readFileSync(tuiStartupCheckPath, "utf8");

    expectTextToMatchAll(landlockCheck, [
      "test -d /sandbox/.deepagents && command -v dcode",
      "touch /sandbox/.deepagents/deepagents-landlock-test",
      "touch /usr/deepagents-landlock-test",
      "touch /opt/venv/deepagents-landlock-test",
      "touch /etc/deepagents-landlock-test",
      "touch /tmp/deepagents-landlock-test",
      "/usr is Landlock read-only for Deep Agents Code",
      "/opt/venv is Landlock read-only for Deep Agents Code",
      "/etc is Landlock read-only for Deep Agents Code",
    ]);
    expect(pythonEgressCheck).toContain(`DCODE_CANONICAL_PATH="${DCODE_CANONICAL_PATH}"`);
    expect(pythonEgressCheck).not.toContain("mktemp");
    expectTextToMatchAll(pythonEgressCheck, [
      'grep -Fxq "PATH=${DCODE_CANONICAL_PATH}"',
      'printf "PYTHON_REAL=%s\\n"',
      "^PYTHON=/opt/venv/bin/python3$",
      "^PIP=/opt/venv/bin/pip3$",
      "^USRLOCAL_COUNT=1$",
      "import urllib.error",
      "except urllib.error.HTTPError as exc:",
      "except urllib.error.URLError as exc:",
      "ERROR:URLError",
      "lacked denial evidence",
      "python_probe_source",
      'DCODE_MANAGED_EXEC="/usr/local/lib/nemoclaw/dcode-managed-exec"',
      "sandbox_exec_argv",
      'source="$(python_probe_source)"',
      '"$python_bin" -c "$source" "$url"',
      'expect_reached "arbitrary Python" "GitHub" "https://api.github.com/"',
      'expect_reached "arbitrary Python" "PyPI" "https://pypi.org/"',
      '"direct managed-exec Python"',
      '"/opt/venv/bin/python3"',
      'PROJECT_VENV="/sandbox/.nemoclaw-e2e-project-venv"',
      "python3 -m venv --copies",
      'expect_reached "project venv Python under /sandbox" "PyPI" "https://pypi.org/" "$PROJECT_PYTHON"',
      'expect_reached "project venv Python under /sandbox" "files.pythonhosted.org" "https://files.pythonhosted.org/" "$PROJECT_PYTHON"',
      'expect_blocked "project venv Python under /sandbox" "Tavily" "https://api.tavily.com/" "$PROJECT_PYTHON"',
      "https://api.tavily.com/",
      "https://api.smith.langchain.com/",
      "https://modelcontextprotocol.io/",
      "https://example.com/",
      "${actor} cannot reach ${label} without explicit policy",
    ]);
    expect(pythonEgressCheck).not.toContain("base64 -d");
    expectTextToMatchAll(secretBoundaryCheck, [
      "Case: Deep Agents Code dcode secret boundary",
      "env OPENAI_API_KEY=",
      "dcode -n 'Reply with the single word PING'",
      "dcode_secret_probe_runtime_env",
      "dcode_secret_probe_env_file",
      "remote_cmd=",
      "LOG_MARKER_FOUND:%s",
      "Keep secret injection, output capture, cleanup, and status reporting atomic",
      "NEMOCLAW_E2E_SECRET_BOUNDARY_SELF_TEST",
      "ATOMIC_COMMAND",
      "DCODE_EXIT:%s\\\\n",
      "DCODE_EXIT:0",
      "refusing to start",
      "NETWORK_LOG_PATTERN=",
      "AUDIT_NETWORK_LOG_PATTERN=",
      "NET:OPEN|inference\\\\.local|pypi\\\\.org",
      "integrate\\\\.api\\\\.nvidia\\\\.com",
      "/tmp/gateway.log",
      "/tmp/nemoclaw-start.log",
      "ocsf_json_enabled",
      'openshell logs "$SANDBOX_NAME" -n 500 --source all --since 2m',
      "AUDIT_LOG_READ:1",
      "LOG_MARKER_FOUND:1",
      "assert_no_rejected_interval_audit_logs",
      "assert_no_rejected_interval_network_logs",
      "sha256sum ${DEEPAGENTS_ENV_FILE@Q}",
    ]);
    expect(tuiStartupCheck).toContain("Case: Deep Agents Code interactive TUI startup");
    expect(tuiStartupCheck).not.toContain("-nocase -re {(deep agents|");
    expect(tuiStartupCheck.indexOf("local expect_rc")).toBeLessThan(
      tuiStartupCheck.indexOf('run_tui_expect "$raw_capture_file"'),
    );
    expectTextToMatchAll(tuiStartupCheck, [
      "test -d /sandbox/.deepagents && command -v dcode",
      "expect <<'EXPECT'",
      "set cmd [list openshell sandbox exec --name $sandbox --tty -- sh -lc",
      "spawn {*}$cmd",
      "NEMOCLAW_DCODE_PROBE:deepagents",
      "NEMOCLAW_DCODE_PROBE:other",
      "unable to probe sandbox",
      "unexpected sandbox probe output",
      "cd /sandbox; dcode",
      'NEMOCLAW_TUI_FIRST_RUN_PATTERN="$TUI_FIRST_RUN_PATTERN"',
      "-nocase -re $first_run_pattern",
      'append_marker $markers "NEMOCLAW_TUI_UNEXPECTED_FIRST_RUN"',
      "choose a recommended model",
      "exit 24",
      'send -- "\\003"\nafter 250\ncatch {send -- "\\003"}',
      'append_marker $markers "$expect_out(0,string)"',
      'append_marker $markers "NEMOCLAW_TUI_READY"',
      'append_marker $markers "NEMOCLAW_TUI_TIMEOUT"',
      'append_marker $markers "NEMOCLAW_TUI_EOF_BEFORE_READY"',
      'append_marker $markers "NEMOCLAW_TUI_EXIT_CAPTURED:$expect_out(1,string)"',
      'append_marker $markers "NEMOCLAW_TUI_EXIT_TIMEOUT"',
      'append_marker $markers "NEMOCLAW_TUI_EOF_BEFORE_EXIT"',
      'NEMOCLAW_TUI_MARKERS="$marker_capture_file"',
      'cat "$raw_capture_file" "$expect_log_file" "$marker_capture_file"',
      'print_sanitized_capture_excerpt "$plain_capture_file"',
      "DEEPAGENTS_TUI_TIMEOUT must be a positive integer",
      "strip_terminal_control_sequences",
      "is_tui_ready_capture",
      "redact_secrets_in_file",
      "trap cleanup_sensitive_captures EXIT",
      "cleanup_sensitive_captures",
      "${PREFIX}${suffix}.sanitized.log",
      "for session_index in 1 2",
      'wait_for_dcode_process_baseline "$baseline_process_count"',
      "secret-shaped value found in sanitized TUI capture",
      "nvapi-",
      "sk-",
    ]);
    const tavilyOptInCheck = fs.readFileSync(
      path.join(
        repoRoot,
        "test",
        "e2e",
        "e2e-cloud-experimental",
        "checks",
        "09-deepagents-code-tavily-opt-in.sh",
      ),
      "utf8",
    );
    expectTextToMatchAll(tavilyOptInCheck, [
      "policy-add tavily --dry-run",
      "policy-add tavily --yes",
      /urllib\.request\.Request[\s\S]*method='POST'/,
      "python_probe_source",
      "sandbox_exec_argv",
      '"$python_bin" -c "$source" "$url"',
      "NEMOCLAW_E2E_TAVILY_SELF_TEST",
      "/opt/venv/",
      "managed Deep Agents Code python can reach Tavily",
      /python_probe .*api\.tavily\.com\/search.*python3/,
      "system Python remains blocked from Tavily after policy-add",
      "/sandbox/.nemoclaw-e2e-project-venv",
      "project venv Python under /sandbox remains blocked from Tavily after policy-add",
    ]);
    expect(tavilyOptInCheck).not.toContain("base64 -d");
    expect(cloudExperimentalChecksForOnboarding("cloud-langchain-deepagents-code")).toEqual([
      "test/e2e/e2e-cloud-experimental/checks/03-deepagents-code-nemotron-ultra-profile.sh",
      "test/e2e/e2e-cloud-experimental/checks/04-deepagents-code-fresh-reonboard.sh",
      "test/e2e/e2e-cloud-experimental/checks/05-deepagents-code-landlock-readonly.sh",
      "test/e2e/e2e-cloud-experimental/checks/06-deepagents-code-python-egress.sh",
      "test/e2e/e2e-cloud-experimental/checks/07-deepagents-code-headless-inference.sh",
      "test/e2e/e2e-cloud-experimental/checks/08-deepagents-code-secret-boundary.sh",
      "test/e2e/e2e-cloud-experimental/checks/09-deepagents-code-tavily-opt-in.sh",
      "test/e2e/e2e-cloud-experimental/checks/10-deepagents-code-tui-startup.sh",
      "test/e2e/e2e-cloud-experimental/checks/11-deepagents-code-observability.sh",
      "test/e2e/e2e-cloud-experimental/checks/12-deepagents-code-thread-auto-approval.sh",
    ]);
  }

  it("ships live policy behavior checks for Deep Agents Code", verifyDeepAgentsLivePolicyChecks);
  it.each([
    'sandbox_exec "test -d /sandbox/.deepagents"',
    "command -v dcode",
    "dcode -n 'Reply with exactly one word: PONG' --json",
    "sandbox_login_exec",
    "sandbox_login_proxy_contract",
    "-u HTTP_PROXY -u HTTPS_PROXY -u NO_PROXY",
    "-u ALL_PROXY -u all_proxy",
    "-u http_proxy -u https_proxy -u no_proxy",
    'HOME=/sandbox bash -lc "$1"',
    'bash -lc "$1"',
    "NEMOCLAW_DCODE_PROXY_ENV_OK",
    "local contract_command",
    'sandbox_login_exec "$contract_command"',
    "sandbox_direct_dcode",
    '-- dcode "$@"',
    "sandbox_dcode_wrapper_contract",
    "NEMOCLAW_DCODE_WRAPPER_CHAIN_OK",
    "cmp -s /usr/local/lib/nemoclaw/dcode-managed-exec /usr/local/lib/nemoclaw/dcode-launcher.sh",
    "dcode_entrypoint_rlimit_contract_command",
    "sandbox_entrypoint_rlimit_contract",
    "nemoclaw-dcode-entrypoint",
    "NEMOCLAW_DCODE_ENTRYPOINT_RLIMIT_OK",
    "process-count",
    "rlimit_shell_contract_command",
    "sandbox_interactive_exec",
    "sandbox_direct_rlimit_exec",
    "/usr/local/lib/nemoclaw/dcode-managed-exec bash -c",
    "NEMOCLAW_DCODE_SHELL_RLIMIT_OK",
    "ulimit -Su 513",
    "ulimit -Sn 65537",
    "dcode entrypoint process tree enforces nproc=512 and nofile=65536",
    "dcode login shell enforces and cannot raise nproc/nofile limits",
    "dcode interactive/connect shell enforces and cannot raise nproc/nofile limits",
    "direct dcode launcher enforces and cannot raise nproc/nofile limits",
    "NEMOCLAW_DCODE_EMPTY_EXIT",
    "login-shell dcode rejects an empty non-interactive prompt with exit 2",
    "direct-exec dcode rejects an empty non-interactive prompt with exit 2",
    "write_openshell_target_shim",
    "OPENSHELL_NEMOCLAW_REAL_BIN",
    "OPENSHELL_NEMOCLAW_TARGET_TRACE",
    "validate_connect_target_trace",
    "NEMOCLAW_DCODE_CONNECT_TARGET_FAIL:missing",
    "NEMOCLAW_DCODE_CONNECT_TARGET_FAIL:mismatch",
    "nemoclaw_connect_probe",
    "unset SANDBOX_NAME NEMOCLAW_SANDBOX_NAME NEMOCLAW_SANDBOX",
    '"${NEMOCLAW_CLI_BIN:-${REPO:-.}/bin/nemoclaw.js}" connect --probe-only 2>&1',
    "bare connect targeted the Deep Agents Code sandbox",
    "${NEMOCLAW_CLI_BIN:-${REPO:-.}/bin/nemoclaw.js}",
    "connect --probe-only 2>&1",
    "dcode_connect_fail_closed_contract",
    "connect rejects untrusted image-backed route evidence before session attach",
    "direct-exec dcode -n reached managed inference",
    "connect --probe-only accepted the managed inference route",
    'sandbox_login_exec "cd /sandbox',
    "https://inference.local/v1/models",
    "HTTP_CODE:%{http_code}",
    '[ "$route_code" = "200" ]',
    "https://inference\\.local(/v1)?",
    "references_managed_placeholder_key",
    'api_key_env[[:space:]]*=[[:space:]]*"DEEPAGENTS_CODE_OPENAI_API_KEY"',
    "classify_headless_output",
    '"schema_version", "command", "data"',
    '"status"',
    '"exit_code"',
    '"response"',
    '"completion"',
    '"thread_id"',
    '"duration_ms"',
    '"response_bytes"',
    "NEMOCLAW_DCODE_DNS_PROBE_MISSING_GETENT",
    "required DNS diagnostic tool getent is unavailable",
    "NEMOCLAW_DCODE_DNS_PROBE_MISSING_TIMEOUT",
    "required DNS diagnostic tool timeout is unavailable",
    "DEEPAGENTS_HEADLESS_TIMEOUT must be a positive integer",
    "nvapi-",
    "nvcf-",
    "ghp_",
    "github_pat_",
    "sk-proj-",
    "sk-ant-",
    "xapp",
    "A(K|S)IA",
    "lsv2_(pt|sk)",
    "/tmp/nemoclaw-proxy-env.sh",
    'cat /sandbox/.deepagents/config.toml 2>/dev/null" || true',
  ])("ships a headless inference acceptance check for Deep Agents Code [%s]", (expected) => {
    const headlessCheck = fs.readFileSync(headlessCheckPath, "utf8");
    const wrapperContract = headlessCheck.match(
      /sandbox_dcode_wrapper_contract\(\) \{(?<body>[\s\S]*?)\n\}/,
    )?.groups?.body;
    expect(wrapperContract).toContain("sandbox_direct_rlimit_exec");
    expect(wrapperContract).not.toMatch(/\bsandbox_exec /);

    expect(headlessCheck).toContain(expected);

    expect(headlessCheck).not.toContain(
      '"${NEMOCLAW_CLI_BIN:-${REPO:-.}/bin/nemoclaw.js}" "$SANDBOX_NAME" connect --probe-only',
    );
    const connectProbe = headlessCheck.slice(
      headlessCheck.indexOf("nemoclaw_connect_probe() {"),
      headlessCheck.indexOf("sandbox_login_proxy_contract() {"),
    );
    const shimWriteIndex = connectProbe.indexOf('write_openshell_target_shim "$shim_path"');
    const aliasUnsetIndex = connectProbe.indexOf(
      "unset SANDBOX_NAME NEMOCLAW_SANDBOX_NAME NEMOCLAW_SANDBOX",
    );
    const connectCommandIndex = connectProbe.indexOf(
      '"${NEMOCLAW_CLI_BIN:-${REPO:-.}/bin/nemoclaw.js}" connect --probe-only',
    );
    const traceValidationIndex = connectProbe.indexOf(
      'validate_connect_target_trace "$trace_file"',
    );
    expect(shimWriteIndex).toBeGreaterThan(-1);
    expect(aliasUnsetIndex).toBeGreaterThan(shimWriteIndex);
    expect(connectCommandIndex).toBeGreaterThan(aliasUnsetIndex);
    expect(traceValidationIndex).toBeGreaterThan(connectCommandIndex);
    expect(headlessCheck).not.toContain('sandbox_login_exec ". /tmp/nemoclaw-proxy-env.sh');
    expect(headlessCheck).not.toContain("config_output:0:200");
    expect(headlessCheck).toMatch(/headless_output=.*sandbox_login_exec.*\|\| true\)"/);
  });

  it("binds the live rlimit probe to one exact managed entrypoint process (#6545)", () => {
    const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-proc-"));
    const limits = [
      "Limit Soft Limit Hard Limit Units",
      "Max processes 512 512 processes",
      "Max open files 65536 65536 files",
      "",
    ].join("\n");
    const writeProcess = (pid: number, argv: readonly string[], processLimits = limits) => {
      const procDir = path.join(procRoot, String(pid));
      fs.mkdirSync(procDir);
      fs.writeFileSync(path.join(procDir, "cmdline"), Buffer.from(`${argv.join("\0")}\0`));
      fs.writeFileSync(path.join(procDir, "limits"), processLimits, "utf8");
    };

    try {
      writeProcess(1, ["/opt/openshell/bin/openshell-sandbox"]);
      writeProcess(42, ["nemoclaw-dcode-entrypoint", "-f", "/dev/null"]);
      expect(runHeadlessCheckHelper("entrypoint-rlimits", { PROC_ROOT: procRoot })).toBe(
        "NEMOCLAW_DCODE_ENTRYPOINT_RLIMIT_OK\n",
      );

      writeProcess(43, ["nemoclaw-dcode-entrypoint", "-f", "/dev/null"]);
      expect(() => runHeadlessCheckHelper("entrypoint-rlimits", { PROC_ROOT: procRoot })).toThrow();
      fs.rmSync(path.join(procRoot, "43"), { force: true, recursive: true });

      fs.writeFileSync(
        path.join(procRoot, "42", "limits"),
        limits.replace("Max processes 512 512", "Max processes unlimited unlimited"),
        "utf8",
      );
      expect(() => runHeadlessCheckHelper("entrypoint-rlimits", { PROC_ROOT: procRoot })).toThrow();

      fs.writeFileSync(
        path.join(procRoot, "42", "limits"),
        limits.replace("Max open files 65536 65536", "Max open files 1024 1024"),
        "utf8",
      );
      expect(() => runHeadlessCheckHelper("entrypoint-rlimits", { PROC_ROOT: procRoot })).toThrow();
    } finally {
      fs.rmSync(procRoot, { force: true, recursive: true });
    }
  });

  it("requires the managed inference route and placeholder key in Deep Agents Code config", () => {
    expect(
      runHeadlessCheckHelper("managed-route", {
        CONFIG: 'base_url = "https://inference.local/v1"',
      }),
    ).toBe("route");
    expect(
      runHeadlessCheckHelper("managed-placeholder", {
        CONFIG: 'api_key_env = "DEEPAGENTS_CODE_OPENAI_API_KEY"',
      }),
    ).toBe("key");
  });

  it("rejects unsafe headless timeout values before sandbox execution", () => {
    const validate = (timeout: string) =>
      runHeadlessCheckHelper("positive-integer", { DEEPAGENTS_HEADLESS_TIMEOUT: timeout });

    expect(validate("120")).toBe("valid");
    expect(validate("0")).toBe("invalid");
    expect(validate("1; touch /tmp/nemoclaw-timeout-injection")).toBe("invalid");
  });

  it("detects representative secret families in headless inference artifacts", () => {
    const detectsSecret = (token: string) =>
      runHeadlessCheckHelper("contains-secret", { TOKEN: token });
    const secretSamples = [
      "nvapi-" + "A".repeat(10),
      "nvcf-" + "A".repeat(10),
      "ghp_" + "A".repeat(10),
      "github_pat_" + "A".repeat(30),
      "sk-proj-" + "A".repeat(10),
      "sk-ant-" + "A".repeat(10),
      "sk-" + "A".repeat(20),
      "xapp-" + "A".repeat(10),
      "ASIA" + "A".repeat(16),
    ];

    expect(secretSamples.every((sample) => Object.is(detectsSecret(sample), "secret"))).toBe(true);
    expect(detectsSecret("managed-placeholder-key")).toBe("clean");
  });
});
