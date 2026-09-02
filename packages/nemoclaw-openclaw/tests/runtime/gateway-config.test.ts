// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  extractShellFunctionFromSource,
  INSTALLED_APPROVAL_POLICY,
  JSON5_MODULE,
  readOpenClawStartupSource,
  runtimeShellEnvBlock,
  trustedApprovalPolicyFile,
} from "../helpers/startup-suite";

describe("nemoclaw-start gateway token export (#1114)", () => {
  const src = readOpenClawStartupSource();

  function runGatewayTokenHarness(
    configJson: string,
    initialToken = "stale-token",
    port = "18789",
    ensureToken = false,
    preseedPredictableTmpSymlink = false,
  ) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-token-"));
    const openclawDir = path.join(tmpDir, ".openclaw");
    const optNemoclaw = path.join(tmpDir, "opt", "nemoclaw");
    const configPath = path.join(openclawDir, "openclaw.json");
    const fabricPath = path.join(openclawDir, "fabric.json");
    const hashPath = path.join(openclawDir, ".config-hash");
    const proxyEnv = path.join(tmpDir, "proxy-env.sh");
    const scriptPath = path.join(tmpDir, "run.sh");
    const predictableTmpPath = `${configPath}.tmp`;
    const tmpSymlinkVictim = path.join(tmpDir, "predictable-tmp-victim");
    fs.mkdirSync(openclawDir, { recursive: true });
    fs.mkdirSync(path.join(optNemoclaw, "node_modules"), { recursive: true });
    fs.cpSync(JSON5_MODULE, path.join(optNemoclaw, "node_modules", "json5"), {
      recursive: true,
    });
    fs.writeFileSync(configPath, configJson);
    fs.writeFileSync(fabricPath, "{}\n", { mode: 0o600 });
    fs.writeFileSync(hashPath, "initial-hash\n");
    if (preseedPredictableTmpSymlink) {
      fs.writeFileSync(tmpSymlinkVictim, "do-not-overwrite\n");
      fs.symlinkSync(tmpSymlinkVictim, predictableTmpPath);
    }

    const readToken = extractShellFunctionFromSource(src, "_read_gateway_token")
      .replaceAll("/sandbox/.openclaw/openclaw.json", configPath)
      .replaceAll("/opt/nemoclaw", optNemoclaw);
    const ensureGatewayToken = extractShellFunctionFromSource(src, "ensure_gateway_token")
      .replaceAll("/sandbox/.openclaw/openclaw.json", configPath)
      .replaceAll("/sandbox/.openclaw/fabric.json", fabricPath)
      .replaceAll("/sandbox/.openclaw/.config-hash", hashPath)
      .replaceAll("/opt/nemoclaw", optNemoclaw);
    const configWriteHelperStubs = [
      "prepare_openclaw_config_for_write() { :; }",
      "restore_openclaw_config_after_write() { :; }",
    ].join("\n");
    const exportToken = extractShellFunctionFromSource(src, "export_gateway_token");
    const printDashboard = extractShellFunctionFromSource(src, "print_dashboard_urls");
    const runtimeEnv = runtimeShellEnvBlock(src).replaceAll("/tmp/nemoclaw-proxy-env.sh", proxyEnv);

    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'emit_sandbox_sourced_file() { local target="$1"; cat > "$target"; chmod 444 "$target"; }',
        readToken,
        ...(ensureToken ? ["id() { echo 0; }"] : []),
        configWriteHelperStubs,
        ...(ensureToken ? [ensureGatewayToken, "ensure_gateway_token"] : []),
        exportToken,
        printDashboard,
        runtimeEnv,
        `export OPENCLAW_GATEWAY_TOKEN=${JSON.stringify(initialToken)}`,
        `export OPENCLAW_GATEWAY_PORT=${JSON.stringify(port)}`,
        `export OPENCLAW_GATEWAY_URL=${JSON.stringify(`ws://127.0.0.1:${port}`)}`,
        'export OPENCLAW_HOME="/sandbox"',
        'export OPENCLAW_STATE_DIR="/sandbox/.openclaw"',
        'export OPENCLAW_CONFIG_PATH="/sandbox/.openclaw/openclaw.json"',
        'export OPENCLAW_OAUTH_DIR="/sandbox/.openclaw/credentials"',
        `PUBLIC_PORT=${JSON.stringify(port)}`,
        'CHAT_UI_URL="https://remote.example.test/ui"',
        'PROXY_HOST="10.200.0.1"',
        'PROXY_PORT="3128"',
        '_PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"',
        '_NO_PROXY_VAL="localhost,127.0.0.1,::1,${PROXY_HOST}"',
        '_SANDBOX_SAFETY_NET="/tmp/safety-net.js"',
        '_PROXY_FIX_SCRIPT="/tmp/http-proxy-fix.js"',
        '_NEMOTRON_FIX_SCRIPT="/tmp/nemotron-fix.js"',
        '_CIAO_GUARD_SCRIPT="/tmp/ciao-guard.js"',
        "emit_messaging_connect_runtime_preload_exports() { :; }",
        "_TOOL_REDIRECTS=()",
        "set +u",
        "export_gateway_token",
        'printf "TOKEN=%s\\n" "${OPENCLAW_GATEWAY_TOKEN-unset}"',
        "print_dashboard_urls",
        "write_runtime_shell_env",
      ].join("\n"),
      { mode: 0o700 },
    );

    const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
    const envFile = fs.existsSync(proxyEnv) ? fs.readFileSync(proxyEnv, "utf-8") : "";
    const configAfter = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const hashAfter = fs.readFileSync(hashPath, "utf-8");
    const fabricAfter = fs.readFileSync(fabricPath, "utf-8");
    const tmpSymlinkVictimAfter = fs.existsSync(tmpSymlinkVictim)
      ? fs.readFileSync(tmpSymlinkVictim, "utf-8")
      : undefined;
    const predictableTmpPathIsSymlink =
      fs.existsSync(predictableTmpPath) && fs.lstatSync(predictableTmpPath).isSymbolicLink();
    const configPathIsSymlink = fs.lstatSync(configPath).isSymbolicLink();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return {
      result,
      envFile,
      configAfter,
      hashAfter,
      fabricAfter,
      tmpSymlinkVictimAfter,
      predictableTmpPathIsSymlink,
      configPathIsSymlink,
    };
  }

  it("reads, exports, prints, and shell-escapes the gateway token without touching rc files", () => {
    const { result, envFile } = runGatewayTokenHarness(
      JSON.stringify({ gateway: { auth: { token: "tok'en" } } }),
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("TOKEN=tok'en");
    expect(result.stderr).toContain("http://127.0.0.1:18789/");
    expect(result.stderr).toContain("https://remote.example.test/ui/");
    expect(result.stderr).toContain("Dashboard auth token redacted from startup logs.");
    expect(result.stderr).not.toContain("#token=");
    expect(result.stderr).not.toContain("tok'en");
    expect(envFile).toContain("OPENCLAW_GATEWAY_TOKEN='tok'\\''en'");
    expect(envFile).toContain("export OPENCLAW_GATEWAY_TOKEN");
    expect(envFile).toContain("nemoclaw-configure-guard begin");
    expect(envFile).not.toContain(".bashrc");
    expect(envFile).not.toContain(".profile");
  });

  it("writes the gateway port and URL into the runtime shell env (#3256)", () => {
    const { result, envFile } = runGatewayTokenHarness(
      JSON.stringify({ gateway: { auth: { token: "token" } } }),
      "stale-token",
      "18790",
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("http://127.0.0.1:18790/");
    expect(envFile).toContain("export OPENCLAW_GATEWAY_PORT='18790'");
    expect(envFile).toContain("export NEMOCLAW_OPENCLAW_GATEWAY_URL='ws://127.0.0.1:18790'");
    expect(envFile).not.toContain("export OPENCLAW_GATEWAY_URL='ws://127.0.0.1:18790'");
    expect(envFile).toContain("OPENCLAW_GATEWAY_TOKEN='token'");
  });
  it("writes OpenClaw state env for connect-shell pairing approval (#3730)", () => {
    const { result, envFile } = runGatewayTokenHarness(
      JSON.stringify({ gateway: { auth: { token: "token" } } }),
    );

    expect(result.status).toBe(0);
    expect(envFile).toContain("export OPENCLAW_HOME='/sandbox'");
    expect(envFile).toContain("export OPENCLAW_STATE_DIR='/sandbox/.openclaw'");
    expect(envFile).toContain("export OPENCLAW_CONFIG_PATH='/sandbox/.openclaw/openclaw.json'");
    expect(envFile).toContain("export OPENCLAW_OAUTH_DIR='/sandbox/.openclaw/credentials'");
    expect(envFile.indexOf("export OPENCLAW_STATE_DIR=")).toBeLessThan(
      envFile.indexOf("OPENCLAW_GATEWAY_TOKEN='"),
    );
  });

  it("generates a gateway token before writing the runtime shell env (#3256)", () => {
    const { result, envFile, configAfter, hashAfter, fabricAfter } = runGatewayTokenHarness(
      JSON.stringify({ gateway: { auth: {} } }),
      "stale-token",
      "18790",
      true,
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(configAfter.gateway.auth.token).not.toBe("");
    expect(Number.isNaN(Date.parse(configAfter.meta.lastTouchedAt))).toBe(false);
    expect(envFile).toContain("export OPENCLAW_GATEWAY_PORT='18790'");
    expect(envFile).toContain("export NEMOCLAW_OPENCLAW_GATEWAY_URL='ws://127.0.0.1:18790'");
    expect(envFile).not.toContain("export OPENCLAW_GATEWAY_URL='ws://127.0.0.1:18790'");
    expect(envFile).toContain(`OPENCLAW_GATEWAY_TOKEN='${configAfter.gateway.auth.token}'`);
    expect(envFile).not.toContain("stale-token");
    expect(hashAfter).not.toBe("initial-hash\n");
    expect(hashAfter).toMatch(/ openclaw\.json\n[0-9a-f]{64}  fabric\.json\n$/);
    expect(fabricAfter).toBe("{}\n");
  });
  it("rotates an existing gateway token before writing the runtime shell env (#4517)", () => {
    const oldToken = "old-token-before-rebuild";
    const { result, envFile, configAfter, hashAfter, fabricAfter } = runGatewayTokenHarness(
      JSON.stringify({ gateway: { auth: { token: oldToken } } }),
      "stale-token",
      "18790",
      true,
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(configAfter.gateway.auth.token).toEqual(expect.any(String));
    expect(configAfter.gateway.auth.token).not.toBe("");
    expect(configAfter.gateway.auth.token).not.toBe(oldToken);
    expect(envFile).toContain(`OPENCLAW_GATEWAY_TOKEN='${configAfter.gateway.auth.token}'`);
    expect(envFile).not.toContain(oldToken);
    expect(envFile).not.toContain("stale-token");
    expect(hashAfter).not.toBe("initial-hash\n");
    expect(hashAfter).toMatch(/ openclaw\.json\n[0-9a-f]{64}  fabric\.json\n$/);
    expect(fabricAfter).toBe("{}\n");
  });

  it("rotates an existing gateway token from JSON5 config (#4517)", () => {
    const oldToken = "old-json5-token-before-rebuild";
    const { result, envFile, configAfter, hashAfter, fabricAfter } = runGatewayTokenHarness(
      [
        "{",
        "  // OpenClaw config accepts JSON5.",
        "  gateway: { auth: { token: 'old-json5-token-before-rebuild', }, },",
        "  model: 'nvidia/nemotron-3-super-120b-a12b',",
        "}",
      ].join("\n"),
      "stale-token",
      "18790",
      true,
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(configAfter.gateway.auth.token).toEqual(expect.any(String));
    expect(configAfter.gateway.auth.token).not.toBe("");
    expect(configAfter.gateway.auth.token).not.toBe(oldToken);
    expect(configAfter.model).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(envFile).toContain(`OPENCLAW_GATEWAY_TOKEN='${configAfter.gateway.auth.token}'`);
    expect(envFile).not.toContain(oldToken);
    expect(envFile).not.toContain("stale-token");
    expect(hashAfter).not.toBe("initial-hash\n");
    expect(hashAfter).toMatch(/ openclaw\.json\n[0-9a-f]{64}  fabric\.json\n$/);
    expect(fabricAfter).toBe("{}\n");
  });

  it("does not write gateway tokens through a preseeded predictable temp symlink", () => {
    const {
      result,
      configAfter,
      tmpSymlinkVictimAfter,
      predictableTmpPathIsSymlink,
      configPathIsSymlink,
    } = runGatewayTokenHarness(
      JSON.stringify({ gateway: { auth: {} } }),
      "stale-token",
      "18790",
      true,
      true,
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(configAfter.gateway.auth.token).toEqual(expect.any(String));
    expect(configAfter.gateway.auth.token).not.toBe("");
    expect(tmpSymlinkVictimAfter).toBe("do-not-overwrite\n");
    expect(predictableTmpPathIsSymlink).toBe(true);
    expect(configPathIsSymlink).toBe(false);
  });

  it("refuses to generate a gateway token through a symlinked config path", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-token-symlink-"));
    const openclawDir = path.join(tmpDir, ".openclaw");
    const realConfig = path.join(tmpDir, "real-openclaw.json");
    const linkConfig = path.join(openclawDir, "openclaw.json");
    const hashPath = path.join(openclawDir, ".config-hash");
    const fabricPath = path.join(openclawDir, "fabric.json");
    const scriptPath = path.join(tmpDir, "run.sh");
    const configJson = JSON.stringify({ gateway: { auth: {} } });
    fs.mkdirSync(openclawDir, { recursive: true });
    fs.writeFileSync(realConfig, configJson);
    fs.symlinkSync(realConfig, linkConfig);
    fs.writeFileSync(hashPath, "initial-hash\n");
    fs.writeFileSync(fabricPath, "{}\n", { mode: 0o600 });

    const readToken = extractShellFunctionFromSource(src, "_read_gateway_token").replaceAll(
      "/sandbox/.openclaw/openclaw.json",
      linkConfig,
    );
    const ensureGatewayToken = extractShellFunctionFromSource(src, "ensure_gateway_token")
      .replaceAll("/sandbox/.openclaw/openclaw.json", linkConfig)
      .replaceAll("/sandbox/.openclaw/fabric.json", fabricPath)
      .replaceAll("/sandbox/.openclaw/.config-hash", hashPath);

    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        readToken,
        ensureGatewayToken,
        "ensure_gateway_token",
      ].join("\n"),
      { mode: 0o700 },
    );

    const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Refusing gateway token generation");
    expect(fs.readFileSync(realConfig, "utf-8")).toBe(configJson);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("unsets stale OPENCLAW_GATEWAY_TOKEN when no token is configured", () => {
    const { result, envFile } = runGatewayTokenHarness(JSON.stringify({ gateway: { auth: {} } }));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("TOKEN=unset");
    expect(result.stderr).not.toContain("#token=");
    expect(envFile).not.toMatch(/^export OPENCLAW_GATEWAY_TOKEN=/m);
  });
});

describe("nemoclaw-start configure guard behavior", () => {
  const src = readOpenClawStartupSource();

  function writeProxyEnvWithGuard() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-configure-guard-"));
    const fakeBin = path.join(tmpDir, "bin");
    const proxyEnv = path.join(tmpDir, "proxy-env.sh");
    const commandLog = path.join(tmpDir, "openclaw.log");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "openclaw"),
      `#!/usr/bin/env bash\nprintf 'ARGS=%s URL=%s PORT=%s TOKEN=%s\\n' "$*" "\${OPENCLAW_GATEWAY_URL-unset}" "\${OPENCLAW_GATEWAY_PORT-unset}" "\${OPENCLAW_GATEWAY_TOKEN-unset}" >> ${JSON.stringify(commandLog)}\nexit 0\n`,
      { mode: 0o755 },
    );
    const runtimeBlock = `${runtimeShellEnvBlock(src)}\nwrite_runtime_shell_env`
      .replaceAll("/tmp/nemoclaw-proxy-env.sh", proxyEnv)
      .replaceAll(INSTALLED_APPROVAL_POLICY, trustedApprovalPolicyFile(tmpDir));
    const wrapper = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'emit_sandbox_sourced_file() { local target="$1"; cat > "$target"; chmod 444 "$target"; }',
      'PROXY_HOST="10.200.0.1"',
      'PROXY_PORT="3128"',
      '_PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"',
      '_NO_PROXY_VAL="localhost,127.0.0.1,::1,${PROXY_HOST}"',
      '_SANDBOX_SAFETY_NET="/tmp/safety-net.js"',
      '_PROXY_FIX_SCRIPT="/tmp/http-proxy-fix.js"',
      '_NEMOTRON_FIX_SCRIPT="/tmp/nemotron-fix.js"',
      '_CIAO_GUARD_SCRIPT="/tmp/ciao-guard.js"',
      "emit_messaging_connect_runtime_preload_exports() { :; }",
      'export OPENCLAW_GATEWAY_URL="ws://127.0.0.1:18789"',
      'export OPENCLAW_GATEWAY_PORT="18789"',
      'export OPENCLAW_GATEWAY_TOKEN="test-gateway-token"',
      "_TOOL_REDIRECTS=()",
      "set +u",
      runtimeBlock,
    ].join("\n");
    const scriptPath = path.join(tmpDir, "write-env.sh");
    fs.writeFileSync(scriptPath, wrapper, { mode: 0o700 });
    const write = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
    expect(write.status).toBe(0);
    return { tmpDir, fakeBin, proxyEnv, commandLog };
  }

  function shellOpenclawCommand(args: string[]) {
    return ["openclaw", ...args.map((arg) => JSON.stringify(arg))].join(" ");
  }

  function runGuardedShell(setup: ReturnType<typeof writeProxyEnvWithGuard>, commands: string[]) {
    return spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        [`source ${JSON.stringify(setup.proxyEnv)}`, ...commands].join("; "),
      ],
      {
        encoding: "utf-8",
        env: { ...process.env, PATH: `${setup.fakeBin}:${process.env.PATH || ""}` },
        timeout: 5000,
      },
    );
  }

  function runGuardedOpenclaw(setup: ReturnType<typeof writeProxyEnvWithGuard>, args: string[]) {
    return runGuardedShell(setup, [shellOpenclawCommand(args)]);
  }

  it("emits a proxy-env guard that blocks mutating OpenClaw commands and passes read-only commands through", () => {
    const setup = writeProxyEnvWithGuard();
    try {
      const envFile = fs.readFileSync(setup.proxyEnv, "utf-8");
      expect(envFile).toContain("nemoclaw-configure-guard begin");
      expect(envFile).toContain("nemoclaw-configure-guard end");

      const configure = runGuardedOpenclaw(setup, ["configure"]);
      expect(configure.status).toBe(1);
      expect(configure.stderr).toContain("cannot modify config inside the sandbox");
      expect(configure.stderr).toContain("nemoclaw onboard --resume");

      const configSet = runGuardedOpenclaw(setup, ["config", "set", "foo", "bar"]);
      expect(configSet.status).toBe(1);
      expect(configSet.stderr).toContain("openclaw config set");
      expect(configSet.stderr).toContain("nemoclaw onboard --resume");

      const localAgent = runGuardedOpenclaw(setup, ["agent", "--local"]);
      expect(localAgent.status).toBe(1);
      expect(localAgent.stderr).toContain("--local");
      expect(localAgent.stderr).toContain("openclaw agent --agent main");

      expect(runGuardedOpenclaw(setup, ["agent", "--agent", "main", "-m", "hello"]).status).toBe(0);
      expect(runGuardedOpenclaw(setup, ["config", "get", "foo"]).status).toBe(0);
      expect(runGuardedOpenclaw(setup, ["channels", "list"]).status).toBe(0);
      expect(fs.readFileSync(setup.commandLog, "utf-8")).toContain("agent --agent main -m hello");
      expect(fs.readFileSync(setup.commandLog, "utf-8")).toContain("config get foo");
      expect(fs.readFileSync(setup.commandLog, "utf-8")).toContain("channels list");
    } finally {
      fs.rmSync(setup.tmpDir, { recursive: true, force: true });
    }
  });
  it("unsets gateway env and leaves failed approval state to OpenClaw (#4462)", () => {
    const setup = writeProxyEnvWithGuard();
    const stateDir = path.join(setup.tmpDir, "openclaw-state");
    const devicesDir = path.join(stateDir, "devices");
    const pendingFile = path.join(devicesDir, "pending.json");
    const pairedFile = path.join(devicesDir, "paired.json");
    const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf-8"));
    const resetState = () => {
      fs.mkdirSync(devicesDir, { recursive: true });
      fs.writeFileSync(
        pendingFile,
        '{"original":{"requestId":"request-1","deviceId":"device-1","publicKey":"public-key-1","clientId":"openclaw-cli","clientMode":"cli","role":"operator","roles":["operator"],"scopes":["operator.write"]}}',
      );
      fs.writeFileSync(
        pairedFile,
        '{"device-1":{"deviceId":"device-1","publicKey":"public-key-1","clientId":"openclaw-cli","clientMode":"cli","role":"operator","roles":["operator"],"scopes":["operator.pairing"],"approvedScopes":["operator.pairing"],"tokens":{"operator":{"role":"operator","scopes":["operator.pairing"]}}}}',
      );
    };
    fs.writeFileSync(
      path.join(setup.fakeBin, "openclaw"),
      `#!/usr/bin/env bash
printf 'ARGS=%s URL=%s PORT=%s TOKEN=%s\n' "$*" "\${OPENCLAW_GATEWAY_URL-unset}" "\${OPENCLAW_GATEWAY_PORT-unset}" "\${OPENCLAW_GATEWAY_TOKEN-unset}" >> ${JSON.stringify(setup.commandLog)}
cat > "\${OPENCLAW_STATE_DIR}/devices/pending.json" <<'JSON'
{"replacement":{"requestId":"replacement-1","deviceId":"device-1","publicKey":"public-key-1","role":"operator","roles":["operator"],"scopes":["operator.write","operator.pairing","operator.read","operator.admin"],"isRepair":true}}
JSON
if [ -n "\${CASE_REPLACEMENT_ID:-}" ]; then echo "gateway connect failed: GatewayClientRequestError: scope upgrade pending approval (requestId: \${CASE_REPLACEMENT_ID})" >&2; else echo "gateway connect failed: G" >&2; fi
exit 1
`,
      { mode: 0o755 },
    );
    try {
      ["replacement-1", "replacement-10", ""].forEach((replacementId) => {
        resetState();
        const result = runGuardedShell(setup, [
          `export OPENCLAW_STATE_DIR=${JSON.stringify(stateDir)}`,
          `export CASE_REPLACEMENT_ID=${JSON.stringify(replacementId)}`,
          shellOpenclawCommand(["devices", "approve", "request-1", "--json"]),
        ]);
        const paired = readJson(pairedFile);
        const pending = readJson(pendingFile);
        expect(result.status).toBe(1);
        expect(fs.readFileSync(setup.commandLog, "utf-8")).toContain(
          "ARGS=devices approve request-1 --json URL=unset PORT=unset TOKEN=unset",
        );
        for (const scopes of [
          paired["device-1"].approvedScopes,
          paired["device-1"].scopes,
          paired["device-1"].tokens.operator.scopes,
        ]) {
          expect(scopes).toEqual(["operator.pairing"]);
        }
        expect(JSON.stringify(paired)).not.toContain("operator.admin");
        expect(pending.replacement.requestId).toBe("replacement-1");
        expect(result.stderr).toContain("gateway connect failed");
      });
    } finally {
      fs.rmSync(setup.tmpDir, { recursive: true, force: true });
    }
  });
  it("blocks channel mutations and renders only validated host-side hints (#2592, #7292)", () => {
    const setup = writeProxyEnvWithGuard();
    try {
      const channels = ["discord", "slack", "teams", "telegram", "wechat", "whatsapp"];
      ["add", "remove"].forEach((op) => {
        for (const channel of channels) {
          const result = runGuardedShell(setup, [
            "export OPENSHELL_SANDBOX=my-assistant",
            shellOpenclawCommand(["channels", op, channel]),
          ]);
          expect(result.status, `channels ${op} ${channel} should be blocked`).toBe(1);
          expect(result.stderr).toContain(
            `Run 'nemoclaw my-assistant channels ${op} ${channel}' on the host.`,
          );
        }
      });
      const marker = path.join(setup.tmpDir, "host-command-injection");
      [
        ["channels", `add'; touch ${marker}; #`, "telegram"],
        ["channels", "add", `telegram\n; touch ${marker}`],
      ].forEach((args) => {
        const result = runGuardedOpenclaw(setup, args);
        expect(result.status).toBe(1);
        expect(result.stderr).not.toContain(marker);
        expect(result.stderr).toMatch(/channels (?:<operation> telegram|add <channel>)/);
      });
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(setup.tmpDir, { recursive: true, force: true });
    }
  });

  // WhatsApp pairing is in-sandbox; status is read-only and does not persist changes.
  it("allows only WhatsApp `channels login` and read-only `channels status` inside the sandbox", () => {
    const setup = writeProxyEnvWithGuard();
    try {
      const allowed = [
        ["channels", "login", "--channel", "whatsapp"],
        ["channels", "login", "--channel=whatsapp"],
        ["channels", "status", "--channel", "whatsapp"],
        ["channels", "status"],
      ];
      allowed.forEach((argv) => {
        const result = runGuardedOpenclaw(setup, argv);
        expect(result.status, `${argv.join(" ")} should pass the guard`).toBe(0);
      });

      const blocked = [
        ["channels", "login"],
        ["channels", "login", "--channel", "wechat"],
        ["channels", "login", "--channel=telegram"],
      ];
      blocked.forEach((argv) => {
        const result = runGuardedOpenclaw(setup, argv);
        expect(result.status, `${argv.join(" ")} should be blocked`).toBe(1);
        expect(result.stderr).toContain("only supported inside the sandbox for WhatsApp");
      });

      const log = fs.readFileSync(setup.commandLog, "utf-8");
      expect(log).toContain("channels login --channel whatsapp");
      expect(log).toContain("channels login --channel=whatsapp");
      expect(log).toContain("channels status");
      expect(log).not.toContain("channels login --channel wechat");
    } finally {
      fs.rmSync(setup.tmpDir, { recursive: true, force: true });
    }
  });
});
