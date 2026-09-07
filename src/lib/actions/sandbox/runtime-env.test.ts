// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  wrapExecCommandWithRuntimeEnv,
  wrapOpenClawAgentCommandWithRuntimeEnv,
} from "./runtime-env";

const BASH_WRAPPER_ARGV_PREFIX = ["--noprofile", "--norc", "-p", "-c"] as const;
const GATEWAY_CREDENTIAL_SCRUB =
  'while IFS= read -r _nemoclaw_runtime_env_name; do case "$_nemoclaw_runtime_env_name" in GATEWAY_TOKEN|GATEWAY_PASSWORD|GATEWAY_SECRET|GATEWAY_CREDENTIAL|*_GATEWAY_TOKEN|*_GATEWAY_PASSWORD|*_GATEWAY_SECRET|*_GATEWAY_CREDENTIAL) builtin unset "$_nemoclaw_runtime_env_name" ;; esac; done < <(builtin compgen -e); builtin unset _nemoclaw_runtime_env_name';
const RUNTIME_ENV_EXEC_SCRIPT = `if [ -r "/tmp/nemoclaw-proxy-env.sh" ]; then builtin source "/tmp/nemoclaw-proxy-env.sh" || exit $?; fi; ${GATEWAY_CREDENTIAL_SCRUB}; builtin exec -- "$@"`;
const OPENCLAW_AGENT_RUNTIME_ENV_EXEC_SCRIPT = `if [ -r "/tmp/nemoclaw-proxy-env.sh" ]; then builtin source "/tmp/nemoclaw-proxy-env.sh" || exit $?; fi; ${GATEWAY_CREDENTIAL_SCRUB}; builtin export NODE_OPTIONS="\${NODE_OPTIONS:+\${NODE_OPTIONS} }--disable-warning=UNDICI-EHPA"; builtin exec -- "$@"`;

function trustedRuntimeEnvArgv(
  command: readonly string[],
  script = RUNTIME_ENV_EXEC_SCRIPT,
): string[] {
  return [...BASH_WRAPPER_ARGV_PREFIX, script, "nemoclaw-runtime-env", ...command];
}

describe("wrapExecCommandWithRuntimeEnv", () => {
  it("sources the trusted runtime env and preserves each original argv element (#4504)", () => {
    const command = ["openclaw", "agent", "-m", "hello world", "quote'and\"double"];
    const wrapped = wrapExecCommandWithRuntimeEnv(command);

    expect(wrapped).toEqual(["/bin/bash", ...trustedRuntimeEnvArgv(command)]);
    expect(wrapped[5]).not.toMatch(/[\r\n]/);
  });

  it("executes LF, CR, CRLF, quote, and heredoc argv byte-exactly", () => {
    const payloads = [
      "line one\nline two",
      "line one\rline two",
      "line one\r\nline two",
      `single ' and double " quotes`,
      "cat <<'EOF'\nline one\nline 'two'\nEOF",
    ];
    const command = [
      "node",
      "-e",
      "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
      ...payloads,
    ];
    const wrapped = wrapExecCommandWithRuntimeEnv(command);
    const trustedArgv = trustedRuntimeEnvArgv(command);
    expect(wrapped).toEqual(["/bin/bash", ...trustedArgv]);

    const result = spawnSync("/bin/bash", trustedArgv, {
      encoding: "utf-8",
      env: { ...process.env },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(payloads);
  });

  it("removes OPENCLAW_GATEWAY_TOKEN from the executed command environment (#6291)", () => {
    const command = ["/bin/sh", "-c", 'printf "TOKEN=[%s]" "${OPENCLAW_GATEWAY_TOKEN:-}"'];
    const wrapped = wrapExecCommandWithRuntimeEnv(command);
    const trustedArgv = trustedRuntimeEnvArgv(command);
    expect(wrapped).toEqual(["/bin/bash", ...trustedArgv]);
    const result = spawnSync("/bin/bash", trustedArgv, {
      encoding: "utf-8",
      env: { ...process.env, OPENCLAW_GATEWAY_TOKEN: "super-secret-gateway-token" },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("TOKEN=[]");
    expect(result.stdout).not.toContain("super-secret-gateway-token");
    expect(wrapped[5]).not.toContain("OPENCLAW_GATEWAY_TOKEN");
  });

  it("scrubs package-neutral gateway credentials while preserving unrelated provider keys", () => {
    const command = [
      "/bin/sh",
      "-c",
      'printf "%s|%s" "${FUTURE_GATEWAY_PASSWORD:-}" "${NVIDIA_API_KEY:-}"',
    ];
    const trustedArgv = trustedRuntimeEnvArgv(command);
    const result = spawnSync("/bin/bash", trustedArgv, {
      encoding: "utf-8",
      env: {
        ...process.env,
        FUTURE_GATEWAY_PASSWORD: "internal-gateway-password",
        NVIDIA_API_KEY: "provider-key",
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("|provider-key");
    expect(result.stdout).not.toContain("internal-gateway-password");
  });

  it("preserves required non-credential proxy and gateway routing metadata", () => {
    const command = [
      "/bin/sh",
      "-c",
      'printf "%s|%s|%s" "$HTTP_PROXY" "$NEMOCLAW_OPENCLAW_GATEWAY_URL" "$NEMOCLAW_OPENCLAW_ALLOW_INSECURE_PRIVATE_WS"',
    ];
    const wrapped = wrapExecCommandWithRuntimeEnv(command);
    const trustedArgv = trustedRuntimeEnvArgv(command);
    expect(wrapped).toEqual(["/bin/bash", ...trustedArgv]);
    const result = spawnSync("/bin/bash", trustedArgv, {
      encoding: "utf-8",
      env: {
        ...process.env,
        HTTP_PROXY: "http://10.200.0.1:3128",
        NEMOCLAW_OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1",
        NEMOCLAW_OPENCLAW_GATEWAY_URL: "ws://10.200.0.2:18789",
        OPENCLAW_GATEWAY_TOKEN: "super-secret-gateway-token",
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("http://10.200.0.1:3128|ws://10.200.0.2:18789|1");
    expect(result.stdout).not.toContain("super-secret-gateway-token");
  });

  it("ignores ambient BASH_ENV before sourcing the trusted runtime env (#4504)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-exec-bash-env-"));
    const bashEnv = path.join(root, "bash-env.sh");
    fs.writeFileSync(bashEnv, 'printf "BASH_ENV_RAN"\n');
    const command = ["/usr/bin/printf", "%s", "COMMAND_RAN"];
    const wrapped = wrapExecCommandWithRuntimeEnv(command);
    const trustedArgv = trustedRuntimeEnvArgv(command);
    expect(wrapped).toEqual(["/bin/bash", ...trustedArgv]);

    try {
      const result = spawnSync("/bin/bash", trustedArgv, {
        encoding: "utf-8",
        env: { ...process.env, BASH_ENV: bashEnv },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("COMMAND_RAN");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not reinterpret a command-leading exec option (#4504)", () => {
    const command = ["-a", "spoofed-argv-zero", "/usr/bin/printf", "SHOULD_NOT_RUN"];
    const wrapped = wrapExecCommandWithRuntimeEnv(command);
    const trustedArgv = trustedRuntimeEnvArgv(command);
    expect(wrapped).toEqual(["/bin/bash", ...trustedArgv]);
    const result = spawnSync("/bin/bash", trustedArgv, { encoding: "utf-8" });

    expect(result.status).toBe(127);
    expect(result.stdout).not.toContain("SHOULD_NOT_RUN");
  });

  it("suppresses only the UNDICI-EHPA warning for OpenClaw agent commands (#8975)", () => {
    const command = [
      "node",
      "-e",
      [
        'process.stdout.write(`TOKEN=[${process.env.OPENCLAW_GATEWAY_TOKEN ?? ""}]`);',
        'process.emitWarning("proxy warning", { code: "UNDICI-EHPA" });',
        'process.emitWarning("other warning", { code: "NEMOCLAW-TEST" });',
      ].join(""),
    ];
    const wrapped = wrapOpenClawAgentCommandWithRuntimeEnv(command);
    const trustedArgv = trustedRuntimeEnvArgv(command, OPENCLAW_AGENT_RUNTIME_ENV_EXEC_SCRIPT);
    expect(wrapped).toEqual(["/bin/bash", ...trustedArgv]);
    const result = spawnSync("/bin/bash", trustedArgv, {
      encoding: "utf-8",
      env: { ...process.env, OPENCLAW_GATEWAY_TOKEN: "test-gateway-token" },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("TOKEN=[]");
    expect(result.stdout).not.toContain("test-gateway-token");
    expect(result.stderr).not.toContain("UNDICI-EHPA");
    expect(result.stderr).not.toContain("proxy warning");
    expect(result.stderr).toContain("NEMOCLAW-TEST");
    expect(result.stderr).toContain("other warning");
    expect(result.stderr).not.toContain("test-gateway-token");
  });
});
